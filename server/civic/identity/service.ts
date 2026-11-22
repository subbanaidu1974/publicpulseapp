/**
 * Identity logic (Agent A). Phones are stored only as keyed hashes (getKeys().hmac("phone", e164)) plus an
 * AES-GCM encrypted copy used solely to send OTP/lockout SMS. No Aadhaar, no voice data, no clear phone anywhere.
 */
import crypto from "node:crypto";
import { audit, getDb, getKeys, getSms, recordConsent, redactAuditFor, registerErasureHook, registerMigration, runErasureHooks } from "../core";
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

export const OTP_TTL_MS = 5 * 60 * 1000;
export const AGE_GATE_DAYS = 14;
export const LOCKOUT_AFTER = 5;
export const LOCKOUT_MS = 30 * 60 * 1000;
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
  phone_purged_at: string | null; deleted_at: string | null;
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

export type PinResult = "ok" | "wrong" | "locked" | "just_locked";
export async function checkPin(p: PersonRow, pin: string, now = new Date()): Promise<PinResult> {
  if (p.locked_until && new Date(p.locked_until).getTime() > now.getTime()) return "locked";
  let failed = p.failed_pins;
  if (p.locked_until) { failed = 0; getDb().prepare("UPDATE persons SET locked_until = NULL, failed_pins = 0 WHERE id = ?").run(p.id); }
  if (p.pin_salt && p.pin_hash && verifyPin(pin, p.pin_salt, p.pin_hash)) {
    if (failed) getDb().prepare("UPDATE persons SET failed_pins = 0 WHERE id = ?").run(p.id);
    return "ok";
  }
  failed += 1;
  if (failed >= LOCKOUT_AFTER) {
    getDb().prepare("UPDATE persons SET failed_pins = ?, locked_until = ? WHERE id = ?").run(failed, new Date(now.getTime() + LOCKOUT_MS).toISOString(), p.id);
    audit("system", "pin.lockout", "person:" + p.id, { attempts: failed });
    if (p.phone_enc) {
      // Tell the SIM holder (the number's owner). Never include any PIN or who set it.
      try { await getSms().send(getKeys().decrypt("phone", p.phone_enc), "People Pulse: sign-in for a person linked to your number was locked after repeated wrong PINs. It unlocks automatically in 30 minutes."); } catch { /* notification is best effort */ }
    }
    return "just_locked";
  }
  getDb().prepare("UPDATE persons SET failed_pins = ? WHERE id = ?").run(failed, p.id);
  return "wrong";
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
registerErasureHook("identity.attestations", (personId) => {
  const d = getDb();
  d.prepare("DELETE FROM attestations WHERE subject_id = ?").run(personId);
  d.prepare("UPDATE attestations SET attestor_id = 'redacted' WHERE attestor_id = ?").run(personId);
});

export function deleteAccount(personId: string): { hooks: string[]; audit_rows_redacted: number } {
  const d = getDb();
  const hooks = runErasureHooks(personId);
  d.prepare("DELETE FROM consents WHERE person_id = ?").run(personId);
  d.prepare("DELETE FROM sessions WHERE person_id = ?").run(personId);
  d.prepare(
    `UPDATE persons SET phone_hash = NULL, phone_enc = NULL, pin_salt = NULL, pin_hash = NULL, label = NULL, residence_enc = NULL,
       residence_unit = NULL, residence_declared_at = NULL, flags = '[]', tier = 'T0', role = 'resident', org = NULL, deleted_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), personId);
  const redacted = redactAuditFor(personId);
  audit("system", "account.delete", "person:deleted", { hooks });
  return { hooks, audit_rows_redacted: redacted };
}

export const retentionDays = () => Number(process.env.CIVIC_RETENTION_DAYS || 180);

/**
 * Retention job. Removes expired OTPs/sessions/rate counters, and clears the encrypted phone copy and residence data of
 * accounts older than the retention window (the keyed phone hash stays so login and one-account-per-adult checks work).
 * GAP: the design says "N days after a survey closes"; survey close is not modelled in Phase 1, so the window runs from
 * account creation / residence declaration. Pass windowDays to override.
 */
export function purgeExpired(now: Date = new Date(), windowDays: number = retentionDays()): Record<string, number> {
  const d = getDb();
  const iso = now.toISOString();
  const cutoff = new Date(now.getTime() - windowDays * DAY).toISOString();
  const run = (sql: string, ...a: (string | number)[]) => Number(d.prepare(sql).run(...a).changes);
  const out = {
    otps: run("DELETE FROM otps WHERE expires_at < ?", iso),
    sessions: run("DELETE FROM sessions WHERE expires_at < ?", iso),
    rate_events: run("DELETE FROM rate_events WHERE ts < ?", now.getTime() - DAY),
    residence: run("UPDATE persons SET residence_enc = NULL, residence_unit = NULL WHERE residence_enc IS NOT NULL AND residence_declared_at < ?", cutoff),
    phone_copies: run("UPDATE persons SET phone_enc = NULL, phone_purged_at = ? WHERE phone_enc IS NOT NULL AND created_at < ?", iso, cutoff),
  };
  audit("system", "retention.purge", "identity", out);
  return out;
}
