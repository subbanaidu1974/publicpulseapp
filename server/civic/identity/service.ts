/**
 * Identity logic (Agent A). Phones are stored only as keyed hashes (getKeys().hmac("phone", e164)) plus an
 * AES-GCM encrypted copy used solely to send OTP/lockout SMS. No Aadhaar, no voice data, no clear phone anywhere.
 */
import crypto from "node:crypto";
import {
  audit, collectErasureSubjects, drainErasureOutbox, enqueueStoreErasure, getDb, getKeys, getSms, recordConsent, registerErasureHook, registerMigration,
  runIdentityErasureHooks, runInTransaction,
} from "../core";
import type { Tier } from "../core";
import { phoneHashCandidates } from "../providers/rehash";
import { OtpStore } from "../../data/repos/otp";
import { identityDb } from "../core/asyncBridge";
import type { Db } from "../../data";

registerMigration("identity_001", `
CREATE TABLE otps (
  phone_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE rate_events (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_rate_events ON rate_events(key, ts);
CREATE TABLE attestations (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  attestor_id TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX idx_attest_subject ON attestations(subject_id);
CREATE INDEX idx_attest_attestor ON attestations(attestor_id, ts);
CREATE TABLE has_responded (
  person_id TEXT NOT NULL,
  survey_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  PRIMARY KEY (person_id, survey_id)
);
`);

registerMigration("identity_002", `
ALTER TABLE persons ADD COLUMN last_active_at TEXT;
CREATE TABLE pin_failures (
  person_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  ok_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_id, source_key)
);
CREATE TABLE survey_closures (
  survey_id TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL
);
`);

// Wave 4 (S-59 per-purpose OTP rows, S-136 enrolments). otps gets a purpose column and a (phone_hash, purpose) key so a signup code, a
// recovery code and an enrolment activation code for the same number never overwrite each other.
registerMigration("identity_003_otp_purpose_enrolments", `
ALTER TABLE otps RENAME TO otps_old;
CREATE TABLE otps (
  phone_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'signup',
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phone_hash, purpose)
);
INSERT INTO otps (phone_hash, purpose, code_hash, expires_at, attempts) SELECT phone_hash, 'signup', code_hash, expires_at, attempts FROM otps_old;
DROP TABLE otps_old;
CREATE TABLE enrolments (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL,
  context_kind TEXT NOT NULL,
  context_ref TEXT,
  label TEXT,
  person_id TEXT,
  code_hash TEXT,
  notice_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','activated','expired','cancelled','legacy')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  activated_at TEXT,
  recheck_state TEXT,
  recheck_at TEXT
);
CREATE INDEX idx_enrolments_person ON enrolments(person_id);
CREATE INDEX idx_enrolments_volunteer ON enrolments(volunteer_id, created_at);
-- (Pre-split releases backfilled 'legacy' enrolments from the audit log here. Legacy databases are now handled by server/civic/core/legacy.ts; a fresh identity store has nothing to backfill.)
`);

export const OTP_TTL_MS = 5 * 60 * 1000;
export const AGE_GATE_DAYS = 14;
export const LOCKOUT_AFTER = 5;
export const LOCKOUT_MS = 30 * 60 * 1000;
/** Per-person ceiling on wrong PINs from sources that never signed in successfully, per window. Rate-limits only; never locks the owner out. */
export const pinCeiling = () => Number(process.env.CIVIC_PIN_GLOBAL_CEILING || 20);
export const PIN_CEILING_WINDOW_MS = 15 * 60 * 1000;
const DAY = 86400000;

export const E164_IN = /^\+91[6-9]\d{9}$/;
export const PIN_RE = /^\d{4,6}$/;

// ---------------------------------------------------------------------------------------------
// SMS budget (shared by OTP, invites and enrolment activation)
// ---------------------------------------------------------------------------------------------

export const smsHourlyBudget = () => Number(process.env.CIVIC_SMS_HOURLY_BUDGET || 2000);
/** Spend one SMS from the global hourly budget (key "sms:global", shared by every SMS-sending flow). False = budget exhausted: answer 429/503 + degraded. */
export function smsBudgetAllow(now = Date.now()): boolean { return rateAllow("sms:global", smsHourlyBudget(), 60 * 60 * 1000, now); }
export type SmsDelivery = "sent" | "queued" | "failed";
/**
 * (S-164) Send one SMS and report HONESTLY what happened. A contract-v2 provider answers with the ledger state of the message; the quiet
 * failure policy of the managed provider (send() resolves even when the vendor is down) is why this does not use send(): sent/delivered ->
 * "sent"; pending/queued/retry (the vendor has it, or will be asked again) -> "queued"; dead/failed/budget_exhausted -> "failed". A v1
 * provider only has send(): resolved -> "sent", threw -> "failed". Never throws.
 */
export async function sendSmsReport(to: string, text: string): Promise<SmsDelivery> {
  const p = getSms() as { contract?: number; submit?: (to: string, text: string) => Promise<{ state: string }>; send(to: string, text: string): Promise<void> };
  try {
    if (p.contract === 2 && typeof p.submit === "function") {
      const r = await p.submit(to, text);
      if (r.state === "sent" || r.state === "delivered") return "sent";
      if (r.state === "pending" || r.state === "queued" || r.state === "retry") return "queued";
      return "failed";
    }
    await p.send(to, text);
    return "sent";
  } catch { return "failed"; }
}
export const DEGRADED_NOTICE = "SMS capacity is reached for this hour. Existing sessions keep working; try again later.";

// ---------------------------------------------------------------------------------------------
// Number intelligence
// ---------------------------------------------------------------------------------------------

export interface NumberIntel { recently_reissued: boolean; voip: boolean }
/** The richer report of a contract-v2 adapter (providers/numberintel.ts). Every field beyond NumberIntel is optional here: the dev stub and old adapters omit them. */
export interface NumberIntelExtra { risk?: "low" | "medium" | "high" | "unknown"; trust?: "normal" | "reduced"; recycled?: boolean; portedRecently?: boolean; source?: string }
/** Adapter for an operator-grade number intelligence / churn-list vendor. */
export interface NumberIntelligence { lookup(e164: string): Promise<NumberIntel> }

/** Dev stub: fixture lists. +919999900001 = recently reissued, +919999900002 = VoIP/bulk-prepaid batch. */
export const DEV_NUMBER_FIXTURES = { reissued: new Set(["+919999900001"]), voip: new Set(["+919999900002"]) };
class DevNumberIntelligence implements NumberIntelligence {
  async lookup(e164: string): Promise<NumberIntel> {
    return { recently_reissued: DEV_NUMBER_FIXTURES.reissued.has(e164), voip: DEV_NUMBER_FIXTURES.voip.has(e164) };
  }
}
let intel: NumberIntelligence = new DevNumberIntelligence();
export function setNumberIntelligence(n: NumberIntelligence | null): void { intel = n ?? new DevNumberIntelligence(); }
export function getNumberIntelligence(): NumberIntelligence { return intel; }
/** (S-55) True while the dev fixture stub is the active number-intelligence adapter. */
export function isDevNumberIntelligence(): boolean { return intel instanceof DevNumberIntelligence; }

/**
 * (S-162) Number-intelligence lookup that can never block a sign-up: an adapter that throws (vendor down, bad answer) yields an UNKNOWN
 * verdict with reduced trust, and sign-up proceeds. The managed adapter already degrades the same way; this covers any other adapter.
 */
export async function lookupNumber(e164: string): Promise<NumberIntel & NumberIntelExtra> {
  try { return (await intel.lookup(e164)) as NumberIntel & NumberIntelExtra; }
  catch { return { recently_reissued: false, voip: false, risk: "unknown", trust: "reduced", recycled: false, portedRecently: false, source: "unknown" }; }
}
export type NumberRisk = "low" | "medium" | "high" | "unknown";
/** Effective risk class of a lookup result: the adapter's own `risk` when it gives one, else derived from the two classic flags. */
export function numberRisk(i: NumberIntel & NumberIntelExtra): NumberRisk { return i.risk ?? (i.voip || i.recently_reissued ? "high" : "low"); }
/** Risk classes whose holders get the stricter OTP cap (CIVIC_RISK_CAP_FACTOR) and the "low quality" survey key class. */
export const isElevatedRisk = (r: NumberRisk): boolean => r === "medium" || r === "high";
/**
 * Flags written on the person at account creation from a lookup. recently_reissued (recycled number) already makes the account
 * survey-ineligible until a volunteer confirms it (T0-restricted). number_risk_medium/high move survey responses to the *_LOW key class;
 * number_ported is informational; number_unverified records that the vendor could not answer (never blocks, never penalises).
 */
export function numberFlags(i: NumberIntel & NumberIntelExtra): string[] {
  const f: string[] = [];
  if (i.recently_reissued || i.recycled) f.push("recently_reissued");
  if (i.portedRecently) f.push("number_ported");
  const r = numberRisk(i);
  if (isElevatedRisk(r)) f.push("number_risk_" + r);
  if (i.trust === "reduced" && numberRisk(i) === "unknown") f.push("number_unverified"); // vendor failure (also when served from the short failure cache)
  return [...new Set(f)];
}
/** Multiplier on the per-phone OTP cap for elevated-risk numbers (default 0.67: 3 requests per 10 minutes become 2). 1 = no difference. */
export const riskCapFactor = (): number => { const f = Number(process.env.CIVIC_RISK_CAP_FACTOR ?? 0.67); return Number.isFinite(f) && f > 0 && f <= 1 ? f : 0.67; };

// ---------------------------------------------------------------------------------------------
// Rate limiting (persisted so it survives restarts)
// ---------------------------------------------------------------------------------------------

/** Returns true if allowed (and records the event). */
export function rateAllow(rawKey: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const d = getDb();
  const key = getKeys().hmac("rate", rawKey);
  d.prepare("DELETE FROM rate_events WHERE key = ? AND ts < ?").run(key, now - windowMs);
  const c = (d.prepare("SELECT COUNT(*) AS c FROM rate_events WHERE key = ?").get(key) as { c: number }).c;
  if (c >= limit) return false;
  d.prepare("INSERT INTO rate_events (key, ts) VALUES (?, ?)").run(key, now);
  return true;
}

/** Count events in the window without recording one. */
export function rateCount(rawKey: string, windowMs: number, now = Date.now()): number {
  const key = getKeys().hmac("rate", rawKey);
  return (getDb().prepare("SELECT COUNT(*) AS c FROM rate_events WHERE key = ? AND ts >= ?").get(key, now - windowMs) as { c: number }).c;
}
/** Forget the events of a rate key (used when the owner proves control of the number). */
export function rateReset(rawKey: string): void {
  getDb().prepare("DELETE FROM rate_events WHERE key = ?").run(getKeys().hmac("rate", rawKey));
}

/**
 * ASN proxy: the network prefix of an address (/24 for IPv4, /48 for IPv6). Real ASN lookup needs a database; the
 * prefix groups the address block a SIM-farm or hosting range would use. IPv4-mapped IPv6 is treated as IPv4.
 */
export function networkPrefix(ip: string): string {
  let a = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) return a.split(".").slice(0, 3).join(".") + ".0/24";
  if (a.includes(":")) {
    const [head, tail = ""] = a.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
    return groups.slice(0, 3).map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/48";
  }
  return "unknown";
}
/** Rate-limit buckets for the per-network OTP cap: always the IP prefix, plus the x-asn header when the edge supplies one. */
export function networkKeys(ip: string, asnHeader?: string): string[] {
  const keys = ["net:" + networkPrefix(ip)];
  const asn = (asnHeader ?? "").trim().slice(0, 32);
  if (asn) keys.push("asn:" + asn); // header is spoofable, so the prefix bucket always applies as well
  return keys;
}
export const otpNetworkLimit = () => Number(process.env.CIVIC_OTP_NET_LIMIT || 60);
export const OTP_NET_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// OTP rows (one per phone and purpose; a valid code is never replaced by another request)
// ---------------------------------------------------------------------------------------------

export type OtpPurpose = "signup" | "recovery" | "enrol";
export const OTP_PURPOSES: OtpPurpose[] = ["signup", "recovery", "enrol"];
export const OTP_MAX_ATTEMPTS = 5;

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");
const otps = (): OtpStore => new OtpStore(identityDb());
/** Milliseconds left on a still-usable code for (phone, purpose), or 0. A code with 5 failed tries counts as burned (0). */
export async function otpRemainingMs(phone: string, purpose: OtpPurpose, now = Date.now()): Promise<number> {
  const row = await otps().row(phoneHashCandidates(phone), purpose); // any active key version (S-161 dual-read; current-version row preferred)
  if (!row || row.attempts >= OTP_MAX_ATTEMPTS) return 0;
  return Math.max(0, new Date(row.expires_at).getTime() - now);
}
/** Store a fresh code (hashed) for (phone, purpose), replacing an expired or burned one. Single-write: always under the CURRENT key version. */
export function storeOtp(phone: string, purpose: OtpPurpose, code: string, now = Date.now(), db?: Db): Promise<void> {
  return new OtpStore(db ?? identityDb()).store(phoneHashCandidates(phone), purpose, getKeys().hmac("otp", code), new Date(now + OTP_TTL_MS).toISOString());
}
/** Drop the pending code for (phone, purpose), whichever key version it was stored under (a code whose SMS never left is not "already sent"). */
export function discardOtp(phone: string, purpose: OtpPurpose): Promise<void> { return otps().discard(phoneHashCandidates(phone), purpose); }
/** Check a code for (phone, purpose): constant-time, 5 tries, single use (the row is removed on success, and only one caller can remove it). */
export async function consumeOtp(phone: string, purpose: OtpPurpose, code: string, now = new Date()): Promise<boolean> {
  const st = otps();
  const row = await st.row(phoneHashCandidates(phone), purpose);
  if (!row || row.expires_at < now.toISOString() || row.attempts >= OTP_MAX_ATTEMPTS) return false;
  const given = Buffer.from(getKeys().hmac("otp", code), "hex"), want = Buffer.from(row.code_hash, "hex");
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { await st.wrongTry(row.phone_hash, purpose); return false; }
  return st.spend(row.phone_hash, purpose);
}

// ---------------------------------------------------------------------------------------------
// Login rate limits (S-59): keyed on phone + person_id + source, so flooding a phone cannot lock the owner out
// ---------------------------------------------------------------------------------------------

export const loginSourceLimit = () => Number(process.env.CIVIC_LOGIN_SOURCE_LIMIT || 10);
export const loginPhoneCeiling = () => Number(process.env.CIVIC_LOGIN_PHONE_CEILING || 100);
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Per-(phone, person, source) attempt budget. Only that source is slowed; other sources of the same phone are untouched. */
export function loginSourceAllow(phone: string, personId: string, source: string): boolean {
  return rateAllow(`login:src:${phone}|${personId}|${source}`, loginSourceLimit(), LOGIN_WINDOW_MS);
}
export function loginSourceReset(phone: string, personId: string, source: string): void { rateReset(`login:src:${phone}|${personId}|${source}`); }
/**
 * Global per-phone ceiling: a pure rate limit (never a lock). Sources that have already signed in successfully as one of `personIds` bypass it,
 * so an attacker flooding a phone from many sources slows other NEW sources but never the owner's known devices.
 */
export function loginCeilingAllow(phone: string, personIds: string[], source: string, now = Date.now()): boolean {
  const known = personIds.length > 0 && !!getDb().prepare(
    `SELECT 1 AS x FROM pin_failures WHERE source_key = ? AND ok_at IS NOT NULL AND person_id IN (${personIds.map(() => "?").join(",")})`)
    .get(getKeys().hmac("pinsrc", source), ...personIds);
  if (known) return true;
  return rateAllow("login:phone:" + phone, loginPhoneCeiling(), LOGIN_WINDOW_MS, now);
}

// ---------------------------------------------------------------------------------------------
// PIN hashing (scrypt)
// ---------------------------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** Synchronous scrypt (blocks the event loop ~50 ms). Kept for scripts, module-load constants and old callers; request paths use hashPinAsync. */
export function hashPin(pin: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32, SCRYPT_PARAMS).toString("hex");
  return { salt: salt.toString("hex"), hash };
}
export function verifyPin(pin: string, saltHex: string, hashHex: string): boolean {
  const { hash } = hashPin(pin, saltHex);
  const a = Buffer.from(hash, "hex"), b = Buffer.from(hashHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// S-73: async scrypt runs on the libuv threadpool, so the event loop keeps serving other requests while PINs hash. A small semaphore
// (CIVIC_SCRYPT_CONCURRENCY, default 4 = the default threadpool size) stops a login burst from starving fs/dns work on the same pool.
let scryptActive = 0;
const scryptWaiters: (() => void)[] = [];
const scryptLimit = () => Math.max(1, Number(process.env.CIVIC_SCRYPT_CONCURRENCY || 4));
async function scryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (scryptActive >= scryptLimit()) await new Promise<void>((r) => scryptWaiters.push(r)); // slot is handed over, count unchanged
  else scryptActive++;
  try { return await fn(); } finally {
    const next = scryptWaiters.shift();
    if (next) next(); else scryptActive--;
  }
}
const scryptAsync = (pin: string, salt: Buffer) =>
  scryptSlot(() => new Promise<Buffer>((res, rej) => crypto.scrypt(pin, salt, 32, SCRYPT_PARAMS, (e, k) => (e ? rej(e) : res(k)))));
/** Same output format as hashPin (hex salt + hex scrypt N=16384 r=8 p=1), computed off the event loop. */
export async function hashPinAsync(pin: string, saltHex?: string): Promise<{ salt: string; hash: string }> {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  return { salt: salt.toString("hex"), hash: (await scryptAsync(pin, salt)).toString("hex") };
}
/** Constant-time compare of a PIN against a stored salt+hash, computed off the event loop. */
export async function verifyPinAsync(pin: string, saltHex: string, hashHex: string): Promise<boolean> {
  const a = await scryptAsync(pin, Buffer.from(saltHex, "hex")), b = Buffer.from(hashHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------
// Weak-PIN blocklist (S-59)
// ---------------------------------------------------------------------------------------------

export type WeakPinReason = "common" | "repeated" | "sequential" | "year_like" | "date_like";
const COMMON_PINS = new Set(["0000", "1234", "2580", "0852", "1357", "1590", "6969", "1004", "4200", "123456", "654321", "000000", "112233", "121212", "159753", "789456"]);
/** Why a PIN is too guessable, or null when acceptable. Applies wherever a person chooses a PIN (sign-up, recovery, change, activation, invite acceptance). */
export function weakPinReason(pin: string): WeakPinReason | null {
  if (!PIN_RE.test(pin)) return null; // format errors are reported separately
  if (COMMON_PINS.has(pin)) return "common";
  if (/^(\d)\1+$/.test(pin)) return "repeated";
  for (let n = 1; n <= pin.length / 2; n++) if (pin.length % n === 0 && pin.slice(0, n).repeat(pin.length / n) === pin) return "repeated"; // 1212, 123123
  const diffs = [...pin].slice(1).map((c, i) => (Number(c) - Number(pin[i]) + 10) % 10);
  if (diffs.every((x) => x === 1) || diffs.every((x) => x === 9)) return "sequential"; // 2345, 7890, 9876, 3210
  if (pin.length === 4 && /^(19[4-9]\d|20[0-2]\d)$/.test(pin)) return "year_like";
  if (pin.length === 6) {
    const dd = Number(pin.slice(0, 2)), mm = Number(pin.slice(2, 4));
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) return "date_like"; // DDMMYY
  }
  return null;
}
export const WEAK_PIN_MESSAGE = "that PIN is too easy to guess (no repeated digits, runs like 1234, or birth years); choose another";

// ---------------------------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------------------------

export interface PersonRow {
  id: string; tier: Tier; role: string; phone_hash: string | null; phone_enc: string | null; pin_salt: string | null; pin_hash: string | null;
  label: string | null; failed_pins: number; locked_until: string | null; flags: string; residence_enc: string | null;
  residence_unit: string | null; residence_declared_at: string | null; created_at: string; eligible_from: string; org: string | null;
  phone_purged_at: string | null; deleted_at: string | null; last_active_at: string | null;
  email_hash: string | null; email_enc: string | null;
}

/** The WRITE hash of a number (current key version). Lookups must go through personsOnPhone / phoneHashCandidates, which also see older versions during a rotation (S-161). */
export const phoneHash = (e164: string) => getKeys().hmac("phone", e164);
export function getPerson(id: string): PersonRow | undefined {
  return getDb().prepare("SELECT * FROM persons WHERE id = ? AND deleted_at IS NULL").get(id) as unknown as PersonRow | undefined;
}
export function personsOnSim(hash: string): PersonRow[] {
  return getDb().prepare("SELECT * FROM persons WHERE phone_hash = ? AND deleted_at IS NULL ORDER BY created_at").all(hash) as unknown as PersonRow[];
}
/**
 * (S-161) Every live account on a number, under ANY active key version, so a key rotation locks nobody out while the rehash runs. Single-write,
 * lazy migration: a row found under an older hash is rewritten to the current hash (and its encrypted phone re-encrypted) right here, so
 * logging in is itself part of the migration. With one active version this is the same query as personsOnSim(phoneHash(e164)).
 */
export function personsOnPhone(e164: string): PersonRow[] {
  const cands = phoneHashCandidates(e164);
  const d = getDb();
  const rows = d.prepare(`SELECT * FROM persons WHERE phone_hash IN (${inList(cands.length)}) AND deleted_at IS NULL ORDER BY created_at`).all(...cands) as unknown as PersonRow[];
  if (cands.length > 1) {
    const stale = rows.filter((r) => r.phone_hash !== cands[0]);
    if (stale.length) {
      const enc = getKeys().encrypt("phone", e164);
      runInTransaction(() => { for (const r of stale) d.prepare("UPDATE persons SET phone_hash = ?, phone_enc = ? WHERE id = ?").run(cands[0], enc, r.id); });
      for (const r of stale) { r.phone_hash = cands[0]; r.phone_enc = enc; }
      audit("system", "phone.rehash_lazy", "identity", { rows: stale.length });
    }
  }
  return rows;
}
/** Everyone on the same SIM as `p` (including p), by the clear number when it is still on file, else by the stored hash. */
export function simMembers(p: PersonRow): PersonRow[] {
  if (p.phone_enc) { try { return personsOnPhone(getKeys().decrypt("phone", p.phone_enc)); } catch { /* fall through */ } }
  return p.phone_hash ? personsOnSim(p.phone_hash) : [];
}

export function createPerson(opts: { phone: string; pin: string; label?: string; flags?: string[]; consentVersion: string; now?: Date }): PersonRow {
  return insertPerson(opts, hashPin(opts.pin));
}
/** (S-73) Same as createPerson but hashes the PIN off the event loop. Request handlers use this one. */
export async function createPersonAsync(opts: { phone: string; pin: string; label?: string; flags?: string[]; consentVersion: string; now?: Date }): Promise<PersonRow> {
  return insertPerson(opts, await hashPinAsync(opts.pin));
}
function insertPerson(opts: { phone: string; label?: string; flags?: string[]; consentVersion: string; now?: Date }, h: { salt: string; hash: string }): PersonRow {
  const now = opts.now ?? new Date();
  const id = crypto.randomUUID();
  const { salt, hash } = h;
  const flags = opts.flags ?? [];
  getDb().prepare(
    `INSERT INTO persons (id, tier, phone_hash, phone_enc, pin_salt, pin_hash, label, flags, created_at, eligible_from)
     VALUES (?, 'T0', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, phoneHash(opts.phone), getKeys().encrypt("phone", opts.phone), salt, hash, opts.label ?? null, JSON.stringify(flags),
    now.toISOString(), new Date(now.getTime() + AGE_GATE_DAYS * DAY).toISOString());
  touchActive(id, now);
  recordConsent(id, "signup", opts.consentVersion);
  return getPerson(id)!;
}

/** "pending_activation" = enrolled by a volunteer but the adult has not yet proven phone control and set their own PIN (S-136). */
export const PENDING_FLAG = "pending_activation";
/** (S-165) "email_only": the account has no phone, so it cannot take part in surveys until a phone or a volunteer attestation is added. */
export const EMAIL_ONLY_FLAG = "email_only";
const BLOCKING_FLAGS = ["recently_reissued", "voip", PENDING_FLAG, EMAIL_ONLY_FLAG];
export const isPendingActivation = (p: Pick<PersonRow, "flags">): boolean => (JSON.parse(p.flags) as string[]).includes(PENDING_FLAG);
/** Eligibility for any Pulse Survey: past the 14-day age gate, no blocking number-intelligence flag, not deleted. */
export function isSurveyEligible(personId: string, now: Date = new Date()): boolean {
  const p = getPerson(personId);
  if (!p) return false;
  if (new Date(p.eligible_from).getTime() > now.getTime()) return false;
  const flags = JSON.parse(p.flags) as string[];
  return !flags.some((f) => BLOCKING_FLAGS.includes(f));
}

/** Admin/ops operation (no HTTP route): enrol a volunteer, optionally with an organisation id for independence checks. */
export function grantVolunteer(personId: string, org?: string): void {
  getDb().prepare("UPDATE persons SET role = 'volunteer', org = ? WHERE id = ? AND deleted_at IS NULL").run(org ?? null, personId);
  audit("system", "role.grant_volunteer", "person:" + personId, {});
}

export function publicPerson(p: PersonRow, now = new Date()) {
  return {
    id: p.id, tier: p.tier, label: p.label, role: p.role, eligible_from: p.eligible_from,
    survey_eligible: isSurveyEligible(p.id, now), flags: JSON.parse(p.flags) as string[], residence_declared: !!p.residence_declared_at,
  };
}

// ---------------------------------------------------------------------------------------------
// Lockout + SIM notices
// ---------------------------------------------------------------------------------------------

export type PinResult = "ok" | "wrong" | "locked" | "just_locked" | "limited";
interface FailRow { failed: number; locked_until: string | null; ok_at: string | null }

/**
 * PIN check with lockout scoped to (person, source). `source` identifies the caller (IP + device); a wrong-PIN streak locks only
 * that source, so a stranger who knows phone + person_id cannot lock the real owner out from their own device. A per-person ceiling
 * on wrong PINs from sources that never signed in successfully ("limited") rate-limits guessing across rotating sources; sources with
 * a previous success bypass it. The SIM holder is texted when a source locks (at most once per 30 minutes per person).
 * The owner can always recover with a fresh OTP on the number (POST /pin/recover).
 */
export async function checkPin(p: PersonRow, pin: string, now = new Date(), source = "-"): Promise<PinResult> {
  const d = getDb();
  const sk = getKeys().hmac("pinsrc", source);
  const row = d.prepare("SELECT failed, locked_until, ok_at FROM pin_failures WHERE person_id = ? AND source_key = ?").get(p.id, sk) as unknown as FailRow | undefined;
  const t = now.getTime();
  if (row?.locked_until && new Date(row.locked_until).getTime() > t) return "locked";
  const ceilingKey = "pin:person:" + p.id;
  if (!row?.ok_at && rateCount(ceilingKey, PIN_CEILING_WINDOW_MS, t) >= pinCeiling()) return "limited";
  let failed = row && !row.locked_until ? row.failed : 0; // an expired lock starts a fresh streak
  if (!isPendingActivation(p) && p.pin_salt && p.pin_hash && await verifyPinAsync(pin, p.pin_salt, p.pin_hash)) {
    d.prepare(
      `INSERT INTO pin_failures (person_id, source_key, failed, locked_until, ok_at, updated_at) VALUES (?,?,0,NULL,?,?)
       ON CONFLICT(person_id, source_key) DO UPDATE SET failed = 0, locked_until = NULL, ok_at = excluded.ok_at, updated_at = excluded.updated_at`)
      .run(p.id, sk, now.toISOString(), now.toISOString());
    return "ok";
  }
  rateAllow(ceilingKey, Number.MAX_SAFE_INTEGER, PIN_CEILING_WINDOW_MS, t); // record the wrong attempt
  failed += 1;
  const lock = failed >= LOCKOUT_AFTER ? new Date(t + LOCKOUT_MS).toISOString() : null;
  d.prepare(
    `INSERT INTO pin_failures (person_id, source_key, failed, locked_until, ok_at, updated_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(person_id, source_key) DO UPDATE SET failed = excluded.failed, locked_until = excluded.locked_until, updated_at = excluded.updated_at`)
    .run(p.id, sk, failed, lock, row?.ok_at ?? null, now.toISOString());
  if (!lock) return "wrong";
  audit("system", "pin.lockout", "person:" + p.id, { attempts: failed });
  if (p.phone_enc && rateAllow("pinnotice:" + p.id, 1, LOCKOUT_MS, t)) {
    // Tell the SIM holder (the number's owner). Never include any PIN or who set it.
    try { await getSms().send(getKeys().decrypt("phone", p.phone_enc), "People Pulse: sign-in for a person linked to your number was locked from one device after repeated wrong PINs. It unlocks automatically in 30 minutes. You can reset the PIN with a code sent to this number."); } catch { /* notification is best effort */ }
  }
  return "just_locked";
}

/** Is any source currently locked out of this person's sign-in? (informational, for the SIM members list) */
export function isLockedAnywhere(personId: string, now = new Date()): boolean {
  return !!getDb().prepare("SELECT 1 AS x FROM pin_failures WHERE person_id = ? AND locked_until > ?").get(personId, now.toISOString());
}

/** Owner recovery (after a fresh OTP on the number): set a new PIN, clear every lock and the ceiling counter. */
export function resetPin(personId: string, newPin: string): void {
  const { salt, hash } = hashPin(newPin);
  runInTransaction(() => {
    const d = getDb();
    d.prepare("UPDATE persons SET pin_salt = ?, pin_hash = ?, failed_pins = 0, locked_until = NULL WHERE id = ? AND deleted_at IS NULL").run(salt, hash, personId);
    d.prepare("DELETE FROM pin_failures WHERE person_id = ?").run(personId);
    rateReset("pin:person:" + personId);
    d.prepare("DELETE FROM sessions WHERE person_id = ?").run(personId);
    audit(personId, "pin.recover", "person:" + personId, {});
  });
}

/** (S-73) resetPin with the PIN hashed off the event loop. Also revokes every session (S-59: recovery/PIN change signs out all devices). */
export async function resetPinAsync(personId: string, newPin: string): Promise<void> {
  const h = await hashPinAsync(newPin);
  runInTransaction(() => {
    const d = getDb();
    d.prepare("UPDATE persons SET pin_salt = ?, pin_hash = ?, failed_pins = 0, locked_until = NULL, flags = (SELECT json_group_array(value) FROM json_each(persons.flags) WHERE value <> 'pin_reset_required') WHERE id = ? AND deleted_at IS NULL").run(h.salt, h.hash, personId);
    d.prepare("DELETE FROM pin_failures WHERE person_id = ?").run(personId);
    rateReset("pin:person:" + personId);
    d.prepare("DELETE FROM sessions WHERE person_id = ?").run(personId);
    audit(personId, "pin.recover", "person:" + personId, {});
  });
}

/** Mark recent activity (anchors the retention window). */
export function touchActive(personId: string, now: Date = new Date()): void {
  getDb().prepare("UPDATE persons SET last_active_at = ? WHERE id = ?").run(now.toISOString(), personId);
}

// ---------------------------------------------------------------------------------------------
// Attestation (T2)
// ---------------------------------------------------------------------------------------------

export const attestQuota = () => Number(process.env.CIVIC_ATTEST_DAILY_QUOTA || 10);

export type AttestResult =
  | { ok: true; tier: Tier; independent_attestors: number }
  | { ok: false; status: number; error: string };

export function attest(attestorId: string, subjectId: string, now = new Date()): AttestResult {
  const d = getDb();
  const a = getPerson(attestorId);
  if (!a || a.role !== "volunteer") return { ok: false, status: 403, error: "only enrolled volunteers can attest" };
  if (attestorId === subjectId) return { ok: false, status: 403, error: "cannot attest yourself" };
  const s = getPerson(subjectId);
  if (!s) return { ok: false, status: 404, error: "person not found" };
  if (!s.residence_declared_at) return { ok: false, status: 409, error: "person has not declared a residence" };
  if (a.phone_hash && a.phone_hash === s.phone_hash) return { ok: false, status: 403, error: "attestor shares a SIM with the person" };
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const used = (d.prepare("SELECT COUNT(*) AS c FROM attestations WHERE attestor_id = ? AND ts >= ?").get(attestorId, dayStart) as { c: number }).c;
  if (used >= attestQuota()) return { ok: false, status: 429, error: "daily attestation quota reached" };
  // S-136: whoever enrolled the person (the volunteer, or anyone from that volunteer's organisation) is not an independent attestor.
  const enr = d.prepare(`SELECT e.volunteer_id AS vid, v.org AS org FROM enrolments e LEFT JOIN persons v ON v.id = e.volunteer_id
                         WHERE e.person_id = ? AND e.status IN ('activated','legacy') ORDER BY e.created_at DESC LIMIT 1`).get(subjectId) as { vid: string; org: string | null } | undefined;
  if (enr && (enr.vid === attestorId || (a.org && enr.org === a.org))) return { ok: false, status: 409, error: "attestors must be independent of the volunteer who enrolled this person" };
  const existing = d.prepare(
    `SELECT a.attestor_id AS aid, p.phone_hash AS ph, p.org AS org FROM attestations a LEFT JOIN persons p ON p.id = a.attestor_id WHERE a.subject_id = ?`)
    .all(subjectId) as unknown as { aid: string; ph: string | null; org: string | null }[];
  if (existing.some((e) => e.aid === attestorId)) return { ok: false, status: 409, error: "already attested by you" };
  for (const e of existing) {
    if ((a.phone_hash && e.ph === a.phone_hash) || (a.org && e.org === a.org)) return { ok: false, status: 409, error: "attestors must be independent (different SIM and organisation)" };
  }
  d.prepare("INSERT INTO attestations (id, subject_id, attestor_id, ts) VALUES (?,?,?,?)").run(crypto.randomUUID(), subjectId, attestorId, now.toISOString());
  const n = existing.length + 1;
  let tier = s.tier;
  if (n >= 2 && s.tier === "T1") {
    tier = "T2";
    d.prepare("UPDATE persons SET tier = 'T2' WHERE id = ?").run(subjectId);
  }
  // Attestor identity is logged here (actor) and is never returned to the attested person.
  audit(attestorId, "attest.residence", "person:" + subjectId, { independent_attestors: n, tier });
  return { ok: true, tier, independent_attestors: n };
}

// ---------------------------------------------------------------------------------------------
// has_responded + account deletion + retention
// ---------------------------------------------------------------------------------------------

/** Mark that a person responded to a survey (one row per person per survey; holds no answer content). */
export function markResponded(personId: string, surveyId: string): void {
  getDb().prepare("INSERT OR IGNORE INTO has_responded (person_id, survey_id, ts) VALUES (?,?,?)").run(personId, surveyId, new Date().toISOString());
  touchActive(personId);
}
/** Record that a survey closed; retention for its respondents runs from this date (or later activity). */
export function markSurveyClosed(surveyId: string, closedAt: Date = new Date()): void {
  getDb().prepare("INSERT OR REPLACE INTO survey_closures (survey_id, closed_at) VALUES (?,?)").run(surveyId, closedAt.toISOString());
}
export function hasResponded(personId: string, surveyId: string): boolean {
  return !!getDb().prepare("SELECT 1 AS x FROM has_responded WHERE person_id = ? AND survey_id = ?").get(personId, surveyId);
}

// Redact has_responded references: keep the row (turnout counts stay right) but unlink it from the person.
registerErasureHook("identity.has_responded", (personId) => {
  const d = getDb();
  const rows = d.prepare("SELECT survey_id FROM has_responded WHERE person_id = ?").all(personId) as { survey_id: string }[];
  const upd = d.prepare("UPDATE has_responded SET person_id = ? WHERE person_id = ? AND survey_id = ?");
  for (const r of rows) upd.run("redacted:" + crypto.randomBytes(8).toString("hex"), personId, r.survey_id);
});
registerErasureHook("identity.pin_failures", (personId) => { getDb().prepare("DELETE FROM pin_failures WHERE person_id = ?").run(personId); });
registerErasureHook("identity.attestations", (personId) => {
  const d = getDb();
  d.prepare("DELETE FROM attestations WHERE subject_id = ?").run(personId);
  d.prepare("UPDATE attestations SET attestor_id = 'redacted' WHERE attestor_id = ?").run(personId);
});

/**
 * Erase an account (S-74: stores are separate, so this is staged).
 * Stage 1, ONE identity-store transaction (all or nothing): the person's pseudonyms in other stores are read, every identity hook and the
 * person-row wipe run, and the cross-store erasure outbox entry is written. Any failure rolls all of it back.
 * Stage 2, after commit: the issues store is unlinked and the audit log redacted from the outbox. Both steps are idempotent; if one fails
 * the outbox row stays and the `retryErasureOutbox` job finishes it (`pending_cross_store` is true until then).
 */
export function deleteAccount(personId: string): { hooks: string[]; audit_rows_redacted: number; pending_cross_store: boolean } {
  let outboxId = "";
  let identityHooks: string[] = [];
  runInTransaction(() => {
    const d = getDb();
    const subjects = collectErasureSubjects(personId); // before the hooks delete the identity-side links
    identityHooks = runIdentityErasureHooks(personId);
    d.prepare("DELETE FROM consents WHERE person_id = ?").run(personId);
    d.prepare("DELETE FROM sessions WHERE person_id = ?").run(personId);
    d.prepare(
      `UPDATE persons SET phone_hash = NULL, phone_enc = NULL, email_hash = NULL, email_enc = NULL, pin_salt = NULL, pin_hash = NULL, label = NULL, residence_enc = NULL,
         residence_unit = NULL, residence_declared_at = NULL, flags = '[]', tier = 'T0', role = 'resident', org = NULL, last_active_at = NULL, deleted_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), personId);
    outboxId = enqueueStoreErasure(personId, subjects);
  });
  const r = drainErasureOutbox(outboxId);
  const hooks = [...identityHooks, ...r.storeHooks];
  const pending = r.done === 0;
  audit("system", "account.delete", "person:deleted", { hooks, pending_cross_store: pending });
  return { hooks, audit_rows_redacted: r.auditRedacted, pending_cross_store: pending };
}

export const retentionDays = () => Number(process.env.CIVIC_RETENTION_DAYS || 180);

/**
 * Retention job. Removes expired OTPs/sessions/rate counters/stale PIN-source rows, and clears the encrypted phone copy and residence
 * data of accounts whose retention anchor is older than the window. The anchor is the LATEST of: last activity (sign-up, sign-in,
 * residence, survey response), residence declaration, and the close date of any survey the person responded to (markSurveyClosed).
 * Creation date is only the fallback for rows with no activity recorded. The keyed phone hash stays so login and
 * one-account-per-adult checks work. Pass windowDays to override.
 */
export function purgeExpired(now: Date = new Date(), windowDays: number = retentionDays()): Record<string, number> {
  const d = getDb();
  const iso = now.toISOString();
  const cutoff = new Date(now.getTime() - windowDays * DAY).toISOString();
  const run = (sql: string, ...a: (string | number)[]) => Number(d.prepare(sql).run(...a).changes);
  const cands = d.prepare(
    `SELECT p.id AS id, p.created_at AS created_at, p.last_active_at AS last_active_at, p.residence_declared_at AS res_at,
            p.phone_enc IS NOT NULL AS has_phone, p.residence_enc IS NOT NULL AS has_res,
            (SELECT MAX(c.closed_at) FROM has_responded h JOIN survey_closures c ON c.survey_id = h.survey_id WHERE h.person_id = p.id) AS closed_at
       FROM persons p WHERE p.deleted_at IS NULL AND (p.phone_enc IS NOT NULL OR p.residence_enc IS NOT NULL)`).all() as unknown as
    { id: string; created_at: string; last_active_at: string | null; res_at: string | null; has_phone: number; has_res: number; closed_at: string | null }[];
  let phoneCopies = 0, residence = 0;
  for (const c of cands) {
    const anchor = [c.created_at, c.last_active_at, c.res_at, c.closed_at].filter((x): x is string => !!x).sort().pop()!;
    if (anchor >= cutoff) continue;
    if (c.has_res) residence += run("UPDATE persons SET residence_enc = NULL, residence_unit = NULL WHERE id = ?", c.id);
    if (c.has_phone) phoneCopies += run("UPDATE persons SET phone_enc = NULL, phone_purged_at = ? WHERE id = ?", iso, c.id);
  }
  const out = {
    otps: run("DELETE FROM otps WHERE expires_at < ?", iso),
    sessions: run("DELETE FROM sessions WHERE expires_at < ?", iso),
    rate_events: run("DELETE FROM rate_events WHERE ts < ?", now.getTime() - DAY),
    pin_sources: run("DELETE FROM pin_failures WHERE updated_at < ?", cutoff),
    residence,
    phone_copies: phoneCopies,
  };
  audit("system", "retention.purge", "identity", out);
  return out;
}
