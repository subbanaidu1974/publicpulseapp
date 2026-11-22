/**
 * Volunteer enrolment (S-136). The volunteer never chooses or learns the adult's PIN:
 *   1. enrol: creates a PENDING person (no PIN, flag pending_activation) plus an `enrolments` row (volunteer, context, label, status) and
 *      texts the adult's own phone the notice, an activation code and a one-time OTP (purpose "enrol").
 *   2. activate: the adult enters code + OTP (proving control of the phone) and sets their own PIN; only then does the account exist.
 * Pending accounts cannot log in, answer or attest; they expire after 72 hours (expirePendingEnrolments, run by the jobs scheduler) and are
 * deleted outright. The enrolment context (volunteer, kind, ref) stays on the row for the T2 independence check and the re-check sampler.
 */
import crypto from "node:crypto";
import { audit, createSession, getDb, getKeys, getSms, recordConsent, runInTransaction } from "../core";
import {
  PENDING_FLAG, OTP_TTL_MS, AGE_GATE_DAYS, consumeOtp, getNumberIntelligence, getPerson, hashPinAsync, personsOnSim, phoneHash, publicPerson, rateAllow,
  smsBudgetAllow, storeOtp, weakPinReason, WEAK_PIN_MESSAGE,
} from "./service";
import type { PersonRow } from "./service";

export const ENROLMENT_TTL_MS = 72 * 60 * 60 * 1000;
export const ENROL_CONTEXTS = ["household", "shg"] as const;
export const enrolQuota = () => Number(process.env.CIVIC_ENROL_DAILY_QUOTA || 15);

export interface EnrolmentRow {
  id: string; volunteer_id: string; context_kind: string; context_ref: string | null; label: string | null; person_id: string | null;
  notice_version: string | null; status: "pending" | "activated" | "expired" | "cancelled" | "legacy"; created_at: string; expires_at: string;
  activated_at: string | null; recheck_state: string | null; recheck_at: string | null;
}
type Fail = { ok: false; status: number; error: string; code?: string; degraded?: boolean };

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = (): string => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
const normCode = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
const showCode = (c: string): string => c.slice(0, 4) + "-" + c.slice(4);
const codeHash = (c: string): string => getKeys().hmac("enrolcode", normCode(c));

/** Delete pending enrolments past their expiry (the pending person row and its OTP go with them). Returns how many. */
export function expirePendingEnrolments(now: Date = new Date()): number {
  const d = getDb();
  const rows = d.prepare("SELECT id, person_id FROM enrolments WHERE status = 'pending' AND expires_at <= ?").all(now.toISOString()) as { id: string; person_id: string | null }[];
  for (const r of rows) {
    runInTransaction(() => {
      if (r.person_id) {
        const p = d.prepare("SELECT phone_hash, flags FROM persons WHERE id = ?").get(r.person_id) as { phone_hash: string | null; flags: string } | undefined;
        if (p && (JSON.parse(p.flags) as string[]).includes(PENDING_FLAG)) {
          if (p.phone_hash) d.prepare("DELETE FROM otps WHERE phone_hash = ? AND purpose = 'enrol'").run(p.phone_hash);
          d.prepare("DELETE FROM persons WHERE id = ?").run(r.person_id);
        }
      }
      d.prepare("UPDATE enrolments SET status = 'expired', person_id = NULL, code_hash = NULL WHERE id = ?").run(r.id);
    });
    audit("system", "enrolment.expired", "enrolment:" + r.id, {});
  }
  return rows.length;
}

export async function createEnrolment(o: {
  volunteerId: string; phone: string; contextKind: string; contextRef?: string | null; label?: string | null; noticeVersion: string; noticeText: string; now?: Date;
}): Promise<{ ok: true; enrolmentId: string; personId: string; expiresAt: string } | Fail> {
  const d = getDb();
  const now = o.now ?? new Date();
  const v = getPerson(o.volunteerId);
  if (!v || v.role !== "volunteer") return { ok: false, status: 403, error: "only enrolled volunteers can enrol adults" };
  expirePendingEnrolments(now);
  if (personsOnSim(phoneHash(o.phone)).length > 0) {
    audit(o.volunteerId, "volunteer_enrol_refused", "enrol", { reason: "number_already_registered" });
    return { ok: false, status: 409, error: "this number already has an account", code: "number_registered" };
  }
  if (!rateAllow(`enrol:${o.volunteerId}`, enrolQuota(), 24 * 60 * 60 * 1000)) {
    audit(o.volunteerId, "volunteer_enrol_refused", "enrol", { reason: "quota" });
    return { ok: false, status: 429, error: "daily enrolment quota reached", code: "quota" };
  }
  if (!smsBudgetAllow(now.getTime())) return { ok: false, status: 429, error: "sms capacity reached; try again later", code: "sms_budget", degraded: true };
  const info = await getNumberIntelligence().lookup(o.phone);
  if (info.voip) return { ok: false, status: 403, error: "this number cannot be used to sign up", code: "number_blocked" };

  const personId = crypto.randomUUID(), enrolmentId = crypto.randomUUID();
  const code = newCode();
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const flags = [PENDING_FLAG, ...(info.recently_reissued ? ["recently_reissued"] : [])];
  const expires = new Date(now.getTime() + ENROLMENT_TTL_MS).toISOString();
  runInTransaction(() => {
    d.prepare(`INSERT INTO persons (id, tier, phone_hash, phone_enc, label, flags, created_at, eligible_from) VALUES (?, 'T0', ?, ?, ?, ?, ?, ?)`)
      .run(personId, phoneHash(o.phone), getKeys().encrypt("phone", o.phone), o.label ?? null, JSON.stringify(flags), now.toISOString(), new Date(now.getTime() + AGE_GATE_DAYS * 86400000).toISOString());
    d.prepare(`INSERT INTO enrolments (id, volunteer_id, context_kind, context_ref, label, person_id, code_hash, notice_version, status, created_at, expires_at)
               VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`).run(enrolmentId, o.volunteerId, o.contextKind, o.contextRef ?? null, o.label ?? null, personId, codeHash(code), o.noticeVersion, now.toISOString(), expires);
    storeOtp(o.phone, "enrol", otp, now.getTime());
  });
  try {
    await getSms().send(o.phone, `${o.noticeText}\n\nPeople Pulse activation. Code: ${showCode(code)}  OTP: ${otp}\nEnter both in the app and choose your OWN PIN. Never tell the PIN to anyone, including the volunteer. Valid 72 hours (OTP 5 minutes).`);
  } catch {
    runInTransaction(() => {
      d.prepare("DELETE FROM persons WHERE id = ?").run(personId);
      d.prepare("DELETE FROM enrolments WHERE id = ?").run(enrolmentId);
      d.prepare("DELETE FROM otps WHERE phone_hash = ? AND purpose = 'enrol'").run(phoneHash(o.phone));
    });
    return { ok: false, status: 502, error: "could not deliver the notice to the adult" };
  }
  audit(o.volunteerId, "volunteer_enrolment", "person:" + personId, { contextKind: o.contextKind, contextRef: o.contextRef ?? null, notice: o.noticeVersion, status: "pending" });
  return { ok: true, enrolmentId, personId, expiresAt: expires };
}

/** The adult proves phone control (OTP) and sets their own PIN. Returns a session on success. */
export async function activateEnrolment(o: { code: string; otp: string; pin: string; now?: Date }): Promise<{ ok: true; token: string; person: ReturnType<typeof publicPerson> } | Fail> {
  const d = getDb();
  const now = o.now ?? new Date();
  expirePendingEnrolments(now);
  const bad: Fail = { ok: false, status: 400, error: "code or OTP expired or invalid", code: "activation_invalid" };
  if (!normCode(o.code) || !/^\d{6}$/.test(o.otp)) return bad;
  const e = d.prepare("SELECT * FROM enrolments WHERE code_hash = ? AND status = 'pending' AND expires_at > ?").get(codeHash(o.code), now.toISOString()) as unknown as EnrolmentRow | undefined;
  if (!e || !e.person_id) return bad;
  const p = getPerson(e.person_id);
  if (!p?.phone_enc) return bad;
  if (!/^\d{4,6}$/.test(o.pin)) return { ok: false, status: 400, error: "PIN must be 4 to 6 digits" };
  if (weakPinReason(o.pin)) return { ok: false, status: 400, error: WEAK_PIN_MESSAGE, code: "weak_pin" };
  if (!consumeOtp(getKeys().decrypt("phone", p.phone_enc), "enrol", o.otp, now)) return bad;
  const h = await hashPinAsync(o.pin);
  runInTransaction(() => {
    d.prepare(`UPDATE persons SET pin_salt = ?, pin_hash = ?, eligible_from = ?, last_active_at = ?,
               flags = (SELECT json_group_array(value) FROM json_each(persons.flags) WHERE value <> ?) WHERE id = ?`)
      .run(h.salt, h.hash, new Date(now.getTime() + AGE_GATE_DAYS * 86400000).toISOString(), now.toISOString(), PENDING_FLAG, p.id);
    d.prepare("UPDATE enrolments SET status = 'activated', activated_at = ?, code_hash = NULL WHERE id = ?").run(now.toISOString(), e.id);
    recordConsent(p.id, "signup", e.notice_version ?? "v1");
    audit(p.id, "enrolment.activated", "enrolment:" + e.id, { volunteer: e.volunteer_id });
  });
  return { ok: true, token: createSession(p.id), person: publicPerson(getPerson(p.id) as PersonRow) };
}

export function listEnrolmentsOf(volunteerId: string): (Omit<EnrolmentRow, "volunteer_id" | "person_id">)[] {
  expirePendingEnrolments();
  return (getDb().prepare("SELECT * FROM enrolments WHERE volunteer_id = ? ORDER BY created_at DESC LIMIT 200").all(volunteerId) as unknown as EnrolmentRow[]).map((r) => ({
    id: r.id, context_kind: r.context_kind, context_ref: r.context_ref, label: r.label, notice_version: r.notice_version, status: r.status,
    created_at: r.created_at, expires_at: r.expires_at, activated_at: r.activated_at, recheck_state: r.recheck_state, recheck_at: r.recheck_at,
  }));
}

/** The volunteer withdraws a pending enrolment (frees the number). */
export function cancelEnrolment(volunteerId: string, enrolmentId: string): boolean {
  const d = getDb();
  const e = d.prepare("SELECT * FROM enrolments WHERE id = ? AND volunteer_id = ? AND status = 'pending'").get(enrolmentId, volunteerId) as unknown as EnrolmentRow | undefined;
  if (!e) return false;
  runInTransaction(() => {
    const p = e.person_id ? d.prepare("SELECT phone_hash, flags FROM persons WHERE id = ?").get(e.person_id) as { phone_hash: string | null; flags: string } | undefined : undefined;
    if (p && (JSON.parse(p.flags) as string[]).includes(PENDING_FLAG)) {
      if (p.phone_hash) d.prepare("DELETE FROM otps WHERE phone_hash = ? AND purpose = 'enrol'").run(p.phone_hash);
      d.prepare("DELETE FROM persons WHERE id = ?").run(e.person_id);
    }
    d.prepare("UPDATE enrolments SET status = 'cancelled', person_id = NULL, code_hash = NULL WHERE id = ?").run(e.id);
  });
  audit(volunteerId, "enrolment.cancelled", "enrolment:" + e.id, {});
  return true;
}

/** Enrolment context of a person (for the T2 independence check, audits and the re-check sampler), or null. */
export function getEnrolmentContext(personId: string): { enrolment_id: string; volunteer_id: string; context_kind: string; context_ref: string | null; label: string | null; status: string; activated_at: string | null } | null {
  const r = getDb().prepare("SELECT id, volunteer_id, context_kind, context_ref, label, status, activated_at FROM enrolments WHERE person_id = ? AND status IN ('activated','legacy','pending') ORDER BY created_at DESC LIMIT 1").get(personId) as unknown as
    { id: string; volunteer_id: string; context_kind: string; context_ref: string | null; label: string | null; status: string; activated_at: string | null } | undefined;
  return r ? { enrolment_id: r.id, volunteer_id: r.volunteer_id, context_kind: r.context_kind, context_ref: r.context_ref, label: r.label, status: r.status, activated_at: r.activated_at } : null;
}

/**
 * Random re-check sampler: picks activated enrolments from the last `sinceDays` that were never sampled, each with probability `fraction`
 * (default 10%, env CIVIC_RECHECK_FRACTION), marks them "requested" and returns them so a reviewer can phone the adult and confirm they
 * agreed and own the account. `rng` is injectable for tests.
 */
export function sampleEnrolmentsForRecheck(o: { fraction?: number; sinceDays?: number; limit?: number; now?: Date; rng?: () => number } = {}): { enrolment_id: string; person_id: string; volunteer_id: string; context_kind: string; context_ref: string | null }[] {
  const now = o.now ?? new Date();
  const fraction = o.fraction ?? Number(process.env.CIVIC_RECHECK_FRACTION || 0.1);
  const rng = o.rng ?? Math.random;
  const since = new Date(now.getTime() - (o.sinceDays ?? 90) * 86400000).toISOString();
  const d = getDb();
  const cands = d.prepare("SELECT id, person_id, volunteer_id, context_kind, context_ref FROM enrolments WHERE status = 'activated' AND recheck_state IS NULL AND activated_at >= ? ORDER BY activated_at").all(since) as unknown as
    { id: string; person_id: string; volunteer_id: string; context_kind: string; context_ref: string | null }[];
  const picked = cands.filter(() => rng() < fraction).slice(0, o.limit ?? 50);
  for (const c of picked) d.prepare("UPDATE enrolments SET recheck_state = 'requested', recheck_at = ? WHERE id = ?").run(now.toISOString(), c.id);
  if (picked.length) audit("system", "enrolment.recheck_sampled", "enrolment", { count: picked.length });
  return picked.map((c) => ({ enrolment_id: c.id, person_id: c.person_id, volunteer_id: c.volunteer_id, context_kind: c.context_kind, context_ref: c.context_ref }));
}
/** Record the outcome of a re-check. "disputed" is audited against the volunteer so repeated disputes can be acted on. */
export function recordRecheckResult(reviewerId: string, enrolmentId: string, outcome: "confirmed" | "disputed"): boolean {
  const e = getDb().prepare("SELECT volunteer_id FROM enrolments WHERE id = ? AND recheck_state = 'requested'").get(enrolmentId) as { volunteer_id: string } | undefined;
  if (!e) return false;
  getDb().prepare("UPDATE enrolments SET recheck_state = ?, recheck_at = ? WHERE id = ?").run(outcome, new Date().toISOString(), enrolmentId);
  audit(reviewerId, "enrolment.recheck_" + outcome, "enrolment:" + enrolmentId, { volunteer: e.volunteer_id });
  return true;
}

/** Residents a volunteer could vouch for: declared a residence, still T1, not on the volunteer's own SIM, not enrolled by them, not already attested by them. */
export function listAttestRequests(volunteerId: string, limit = 50): { person_id: string; label: string | null; village: string | null }[] {
  const d = getDb();
  const v = getPerson(volunteerId);
  if (!v) return [];
  const rows = d.prepare(
    `SELECT p.id AS person_id, p.label AS label, p.residence_unit AS village FROM persons p
      WHERE p.deleted_at IS NULL AND p.tier = 'T1' AND p.residence_declared_at IS NOT NULL AND p.id <> ?
        AND (p.phone_hash IS NULL OR p.phone_hash IS NOT ?)
        AND p.flags NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM attestations a WHERE a.subject_id = p.id AND a.attestor_id = ?)
        AND NOT EXISTS (SELECT 1 FROM enrolments e WHERE e.person_id = p.id AND e.volunteer_id = ? AND e.status IN ('activated','legacy'))
      ORDER BY p.residence_declared_at LIMIT ?`).all(volunteerId, v.phone_hash, `%${PENDING_FLAG}%`, volunteerId, volunteerId, Math.min(200, Math.max(1, limit))) as unknown as
    { person_id: string; label: string | null; village: string | null }[];
  return rows;
}
