/**
 * Identity logic (Agent A). Phones are stored only as keyed hashes (getKeys().hmac("phone", e164)) plus an
 * AES-GCM encrypted copy used solely to send OTP/lockout SMS. No Aadhaar, no voice data, no clear phone anywhere.
 */
import crypto from "node:crypto";
import { audit, getDb, getKeys, getSms, recordConsent, redactAuditFor, registerErasureHook, registerMigration, runErasureHooks, runInTransaction } from "../core";
import type { Tier } from "../core";

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
// Number intelligence
// ---------------------------------------------------------------------------------------------

export interface NumberIntel { recently_reissued: boolean; voip: boolean }
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
// PIN hashing (scrypt)
// ---------------------------------------------------------------------------------------------

export function hashPin(pin: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt: salt.toString("hex"), hash };
}
export function verifyPin(pin: string, saltHex: string, hashHex: string): boolean {
  const { hash } = hashPin(pin, saltHex);
  const a = Buffer.from(hash, "hex"), b = Buffer.from(hashHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------------------------

export interface PersonRow {
  id: string; tier: Tier; role: string; phone_hash: string | null; phone_enc: string | null; pin_salt: string | null; pin_hash: string | null;
  label: string | null; failed_pins: number; locked_until: string | null; flags: string; residence_enc: string | null;
  residence_unit: string | null; residence_declared_at: string | null; created_at: string; eligible_from: string; org: string | null;
  phone_purged_at: string | null; deleted_at: string | null; last_active_at: string | null;
}

export const phoneHash = (e164: string) => getKeys().hmac("phone", e164);
export function getPerson(id: string): PersonRow | undefined {
  return getDb().prepare("SELECT * FROM persons WHERE id = ? AND deleted_at IS NULL").get(id) as unknown as PersonRow | undefined;
}
export function personsOnSim(hash: string): PersonRow[] {
  return getDb().prepare("SELECT * FROM persons WHERE phone_hash = ? AND deleted_at IS NULL ORDER BY created_at").all(hash) as unknown as PersonRow[];
}

export function createPerson(opts: { phone: string; pin: string; label?: string; flags?: string[]; consentVersion: string; now?: Date }): PersonRow {
  const now = opts.now ?? new Date();
  const id = crypto.randomUUID();
  const { salt, hash } = hashPin(opts.pin);
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

const BLOCKING_FLAGS = ["recently_reissued", "voip"];
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
  if (p.pin_salt && p.pin_hash && verifyPin(pin, p.pin_salt, p.pin_hash)) {
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

/** Erase an account. Every hook, the person-row wipe and the audit redaction run in ONE transaction: any failure rolls all of it back. */
export function deleteAccount(personId: string): { hooks: string[]; audit_rows_redacted: number } {
  return runInTransaction(() => {
    const d = getDb();
    const hooks = runErasureHooks(personId);
    d.prepare("DELETE FROM consents WHERE person_id = ?").run(personId);
    d.prepare("DELETE FROM sessions WHERE person_id = ?").run(personId);
    d.prepare(
      `UPDATE persons SET phone_hash = NULL, phone_enc = NULL, pin_salt = NULL, pin_hash = NULL, label = NULL, residence_enc = NULL,
         residence_unit = NULL, residence_declared_at = NULL, flags = '[]', tier = 'T0', role = 'resident', org = NULL, last_active_at = NULL, deleted_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), personId);
    const redacted = redactAuditFor(personId);
    audit("system", "account.delete", "person:deleted", { hooks });
    return { hooks, audit_rows_redacted: redacted };
  });
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
