import { randomBytes, randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { audit, getDb, getKeys, getSms, recordConsent, registerErasureHook, registerMigration, requireAuth } from "../core";
import { phoneHashCandidates } from "../providers/rehash";
import { DEGRADED_NOTICE, WEAK_PIN_MESSAGE, checkPin, getPerson, hashPinAsync, personsOnSim, phoneHash, rateAllow, rateCount, smsBudgetAllow, weakPinReason } from "../identity/service";
import { ENROL_CONTEXTS, createEnrolment, enrolQuota as enrolQuotaFn } from "../identity/enrolment";
import householdInviteV1 from "./notices/household_invite.v1.json";
import minorDependentV1 from "./notices/minor_dependent.v1.json";
import signupV1 from "./notices/signup.v1.json";
import grievanceOfficer from "./notices/grievance_officer.json";

/**
 * Households (S-21, S-22) and DPDP artefacts (S-44). All legal wording is DRAFT and needs counsel (DESIGN_2028 3.10).
 * Privacy rules enforced here: roster endpoints never return answers or phone numbers; a pending invite stores only a
 * keyed hash of the number; dependents are stored without a name and without a person account.
 */

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_PENDING_INVITES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
/** S-61 abuse caps. Per head per day (default 10), per target number per day across every head (3), cooldown after a decline/report (7 days). */
export const inviteDailyCap = () => Number(process.env.CIVIC_INVITE_DAILY_CAP || 10);
export const inviteTargetDailyCap = () => Number(process.env.CIVIC_INVITE_TARGET_DAILY_CAP || 3);
export const INVITE_COOLDOWN_MS = Number(process.env.CIVIC_INVITE_COOLDOWN_DAYS || 7) * DAY_MS;
/** S-149: dependents per household (default 8) and how long a head transfer waits for the recipient (72 h). */
export const maxDependents = () => Number(process.env.CIVIC_MAX_DEPENDENTS || 8);
export const TRANSFER_TTL_MS = 72 * 60 * 60 * 1000;
export const enrolQuota = enrolQuotaFn;
const ADULT_RELATIONS = ["spouse", "parent", "son", "daughter", "sibling", "relative", "other"] as const;
const DEPENDENT_RELATIONS = ["son", "daughter", "grandchild", "sibling", "ward", "other"] as const;

export interface Notice { purpose: string; version: string; status: string; title: { en: string; te: string }; text: { en: string; te: string } }
const NOTICES: Notice[] = [householdInviteV1, minorDependentV1, signupV1];
export function getNotice(purpose: string, version?: string): Notice | undefined {
  const list = NOTICES.filter((n) => n.purpose === purpose);
  if (version) return list.find((n) => n.version === version);
  return list[list.length - 1];
}

registerMigration("households_001", `
CREATE TABLE IF NOT EXISTS hh_household (
  id TEXT PRIMARY KEY,
  head_person_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hh_member (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  person_id TEXT,
  relation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','dependent')),
  year_of_birth INTEGER,
  consent_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK (status <> 'dependent' OR (person_id IS NULL AND year_of_birth IS NOT NULL)),
  CHECK (status <> 'accepted' OR (person_id IS NOT NULL AND year_of_birth IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS hh_member_person ON hh_member(person_id) WHERE person_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS hh_invite (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  phone_hash TEXT,
  relation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','reported','expired')),
  accepted_person_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hh_pin (
  person_id TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
`);

// The invitee PIN lives once, in identity (persons.pin_hash, scrypt). hh_pin held a keyed hash that cannot be converted to
// that format, so existing rows are not copied: a person with no identity PIN is flagged "pin_reset_required" and must set
// one through identity sign-in. Pending invites were bound to a household-specific phone hash, so they are expired and must
// be re-issued (invites are bound to the identity phone hash from now on).
registerMigration("households_002_single_pin", `
UPDATE persons SET flags = json_insert(flags, '$[#]', 'pin_reset_required')
  WHERE pin_hash IS NULL AND id IN (SELECT person_id FROM hh_pin) AND flags NOT LIKE '%pin_reset_required%';
DROP TABLE IF EXISTS hh_pin;
UPDATE hh_invite SET status='expired', phone_hash=NULL WHERE status='pending';
`);

// S-61: the keyed hash of a number that declined or reported an invite is kept for the cooldown only ('*' household = blocks every head).
// S-149: head transfers wait for the recipient to confirm.
registerMigration("households_003_caps_transfer", `
CREATE TABLE IF NOT EXISTS hh_invite_cooldown (
  target_hash TEXT NOT NULL,
  household_id TEXT NOT NULL,
  until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (target_hash, household_id)
);
CREATE TABLE IF NOT EXISTS hh_transfer (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  from_person TEXT NOT NULL,
  to_person TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hh_transfer_household ON hh_transfer(household_id, status);
`);

type Row = Record<string, unknown>;
const db = () => getDb();
let spSeq = 0;
/** Run fn atomically. Uses a SAVEPOINT so it also nests inside a caller's transaction. Never call audit() inside: it opens its own transaction. */
function tx<T>(fn: () => T): T {
  const d = db();
  const sp = `hh_sp_${++spSeq}`;
  d.exec(`SAVEPOINT ${sp}`);
  try {
    const r = fn();
    d.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    d.exec(`ROLLBACK TO ${sp}`);
    d.exec(`RELEASE ${sp}`);
    throw e;
  }
}
const fail = (res: Response, code: number, error: string, extra: Record<string, unknown> = {}) => { res.status(code).json({ error, ...extra }); };

/** Normalise an Indian mobile number to +91XXXXXXXXXX, or null if invalid. */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/[\s-]/g, "");
  const m = /^(?:\+?91)?([6-9]\d{9})$/.exec(d);
  return m ? `+91${m[1]}` : null;
}

function householdOf(personId: string): { household: Row; isHead: boolean } | null {
  const head = db().prepare("SELECT * FROM hh_household WHERE head_person_id = ?").get(personId) as Row | undefined;
  if (head) return { household: head, isHead: true };
  const mem = db().prepare("SELECT household_id FROM hh_member WHERE person_id = ?").get(personId) as Row | undefined;
  if (!mem) return null;
  const h = db().prepare("SELECT * FROM hh_household WHERE id = ?").get(mem.household_id as string) as Row;
  return { household: h, isHead: false };
}

function expireStaleInvites(now: number): void {
  // Expired invites lose their phone hash: nothing about the invitee remains.
  db().prepare("UPDATE hh_invite SET status='expired', phone_hash=NULL WHERE status='pending' AND expires_at <= ?").run(now);
  db().prepare("DELETE FROM hh_invite_cooldown WHERE until <= ?").run(now);
  db().prepare("UPDATE hh_transfer SET status='expired' WHERE status='pending' AND expires_at <= ?").run(now);
}
const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");
/** (S-161) Does this person's verified number match a stored invite hash, whichever key version either side was written under? */
function samePhone(me: { phone_hash: string | null; phone_enc?: string | null }, inviteHash: string): boolean {
  if (me.phone_hash === inviteHash) return true;
  if (!me.phone_enc) return false;
  try { return phoneHashCandidates(getKeys().decrypt("phone", me.phone_enc)).includes(inviteHash); } catch { return false; }
}
function startCooldown(targetHash: string | null | undefined, householdId: string, reason: "declined" | "reported", now: number): void {
  if (!targetHash) return;
  // A report protects the number from every head; a decline only from the household that asked.
  db().prepare("INSERT OR REPLACE INTO hh_invite_cooldown (target_hash, household_id, until, reason) VALUES (?,?,?,?)")
    .run(targetHash, reason === "reported" ? "*" : householdId, now + INVITE_COOLDOWN_MS, reason);
}

/** Job: erase dependents who have turned (or are turning this calendar year) 18. All-or-nothing; audit entries follow the commit. Returns number erased. */
export function eraseDependentsAt18(now: Date = new Date()): number {
  const cutoff = now.getFullYear() - 18; // born in or before this year: erase (conservative: never keep past 18th birthday)
  const erased = tx(() => {
    const rows = db().prepare("SELECT id, household_id FROM hh_member WHERE status='dependent' AND year_of_birth <= ?").all(cutoff) as Row[];
    const del = db().prepare("DELETE FROM hh_member WHERE id = ?");
    for (const r of rows) del.run(r.id as string);
    return rows;
  });
  for (const r of erased) audit("system", "dependent_erased_at_18", String(r.household_id), {});
  return erased.length;
}

/** Remove a household and everything hanging off it (members incl. dependents, invites). Atomic; the caller audits after commit. */
function dissolveHousehold(householdId: string): void {
  tx(() => {
    db().prepare("DELETE FROM hh_member WHERE household_id = ?").run(householdId);
    db().prepare("DELETE FROM hh_invite WHERE household_id = ?").run(householdId);
    db().prepare("DELETE FROM hh_household WHERE id = ?").run(householdId);
  });
}

/** Job: purge invites that expired (hash already nulled). */
export function expireInvites(now: number = Date.now()): void { expireStaleInvites(now); }

export const householdRouter = Router();
householdRouter.use(express.json({ limit: "10kb" }));

// ---- Public, static compliance artefacts (no personal data; the invitee must be able to read the notice before signing up)
householdRouter.get("/notices/:purpose", (req, res) => {
  const n = getNotice(req.params.purpose, typeof req.query.version === "string" ? req.query.version : undefined);
  if (!n) return fail(res, 404, "unknown notice");
  res.json(n);
});
householdRouter.get("/grievance-officer", (_req, res) => { res.json(grievanceOfficer); });
householdRouter.get("/invites/:inviteId/notice", (req, res) => {
  expireStaleInvites(Date.now());
  const inv = db().prepare("SELECT status, expires_at FROM hh_invite WHERE id = ?").get(req.params.inviteId) as Row | undefined;
  if (!inv) return fail(res, 404, "invite not found");
  res.json({ status: inv.status, expiresAt: inv.expires_at, notice: getNotice("household_invite") });
});

householdRouter.use(requireAuth);

// ---- Consent record API (S-44)
householdRouter.post("/consents", (req: Request, res: Response) => {
  const { purpose, version } = (req.body ?? {}) as { purpose?: string; version?: string };
  if (typeof purpose !== "string" || typeof version !== "string" || !getNotice(purpose, version)) return fail(res, 400, "unknown purpose or version");
  const consentId = recordConsent(req.person!.id, purpose, version);
  res.status(201).json({ consentId, purpose, version });
});

// ---- Household
householdRouter.post("/", (req: Request, res: Response) => {
  const pid = req.person!.id;
  if (householdOf(pid)) return fail(res, 409, "already in a household");
  const id = randomUUID();
  db().prepare("INSERT INTO hh_household (id, head_person_id, created_at) VALUES (?,?,?)").run(id, pid, Date.now());
  audit(pid, "household_created", id);
  res.status(201).json({ id });
});

householdRouter.get("/mine", (req: Request, res: Response) => {
  const pid = req.person!.id;
  const now = Date.now();
  expireStaleInvites(now);
  const h = householdOf(pid);
  if (!h) return fail(res, 404, "no household");
  const hid = h.household.id as string;
  const headId = h.household.head_person_id as string;
  const members = (db().prepare("SELECT id, person_id, relation, status, year_of_birth FROM hh_member WHERE household_id = ? ORDER BY created_at").all(hid) as Row[]).map((m) => ({
    id: m.id,
    relation: m.relation,
    status: m.status,
    isHead: false,
    isYou: m.person_id === pid,
    ...(m.status === "accepted" ? { personId: m.person_id } : {}),
    ...(m.status === "dependent" && h.isHead ? { yearOfBirth: m.year_of_birth } : {}),
  }));
  const roster = [{ id: "head", relation: "head", status: "accepted", isHead: true, isYou: headId === pid, personId: headId }, ...members];
  const invites = h.isHead
    ? (db().prepare("SELECT id, relation, status, expires_at FROM hh_invite WHERE household_id = ? AND status='pending' ORDER BY created_at").all(hid) as Row[]).map((i) => ({ id: i.id, relation: i.relation, status: i.status, expiresAt: i.expires_at }))
    : [];
  const tr = db().prepare("SELECT id, from_person, to_person, expires_at FROM hh_transfer WHERE household_id = ? AND status = 'pending'").get(hid) as Row | undefined;
  const pendingTransfer = tr && (tr.from_person === pid || tr.to_person === pid)
    ? { id: tr.id, role: tr.from_person === pid ? "sender" : "recipient", expiresAt: tr.expires_at, ...(tr.from_person === pid ? { toPersonId: tr.to_person } : {}) } : null;
  res.json({ id: hid, isHead: h.isHead, members: roster, invites, pendingTransfer });
});

// ---- Adult invite
householdRouter.post("/members/invite", async (req: Request, res: Response) => {
  const pid = req.person!.id;
  const h = householdOf(pid);
  if (!h?.isHead) return fail(res, 403, "only the household head can invite");
  const { phone, relation } = (req.body ?? {}) as { phone?: unknown; relation?: unknown };
  const norm = normalisePhone(phone);
  if (!norm) return fail(res, 400, "invalid phone");
  if (typeof relation !== "string" || !(ADULT_RELATIONS as readonly string[]).includes(relation)) return fail(res, 400, "invalid relation");
  const hid = h.household.id as string;
  const now = Date.now();
  expireStaleInvites(now);
  // S-161: the WRITE hash is the current key version; every duplicate / cooldown / cap check reads under ALL active versions.
  const cands = phoneHashCandidates(norm);
  const hash = cands[0] ?? phoneHash(norm);
  const marks = inList(cands.length);
  if (db().prepare(`SELECT 1 FROM hh_invite WHERE household_id=? AND phone_hash IN (${marks}) AND status='pending'`).get(hid, ...cands)) return fail(res, 409, "already invited");
  const cool = db().prepare(`SELECT until FROM hh_invite_cooldown WHERE target_hash IN (${marks}) AND (household_id=? OR household_id='*') AND until > ? ORDER BY until DESC`).get(...cands, hid, now) as Row | undefined;
  if (cool) return fail(res, 429, "this number recently declined or reported an invitation; it cannot be invited again yet", { code: "invite_cooldown", retryAt: cool.until });
  const pending = (db().prepare("SELECT COUNT(*) AS c FROM hh_invite WHERE household_id=? AND status='pending'").get(hid) as { c: number }).c;
  if (pending >= MAX_PENDING_INVITES) return fail(res, 429, "too many pending invites");
  if (rateCount(`invite:head:${pid}`, DAY_MS, now) >= inviteDailyCap()) return fail(res, 429, "daily invitation limit reached", { code: "invite_daily_cap" });
  if (Math.max(...cands.map((c) => rateCount(`invite:target:${c}`, DAY_MS, now))) >= inviteTargetDailyCap()) return fail(res, 429, "this number has received too many invitations today", { code: "invite_target_cap" });
  if (!smsBudgetAllow(now)) return fail(res, 429, "sms capacity reached; try again later", { code: "sms_budget", degraded: true, notice: DEGRADED_NOTICE });
  rateAllow(`invite:head:${pid}`, Number.MAX_SAFE_INTEGER, DAY_MS, now);
  rateAllow(`invite:target:${hash}`, Number.MAX_SAFE_INTEGER, DAY_MS, now);
  const inviteId = randomBytes(18).toString("base64url"); // unguessable: possession proves the SMS was received
  const notice = getNotice("household_invite")!;
  // Only a keyed hash of the number is stored; the plaintext goes to the SMS provider and is never persisted here.
  db().prepare("INSERT INTO hh_invite (id, household_id, phone_hash, relation, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(inviteId, hid, hash, relation, "pending", now, now + INVITE_TTL_MS);
  try {
    await getSms().send(norm, `${notice.text.te}\n\n${notice.text.en}\n\nInvite code: ${inviteId}\nValid 72 hours. [DRAFT NOTICE ${notice.version}]`);
  } catch {
    db().prepare("DELETE FROM hh_invite WHERE id = ?").run(inviteId);
    return fail(res, 502, "could not deliver the invitation notice");
  }
  audit(pid, "household_invite_sent", inviteId, { relation });
  res.status(201).json({ inviteId, expiresAt: now + INVITE_TTL_MS });
});

function loadPendingInvite(inviteId: unknown): { invite?: Row; error?: [number, string] } {
  if (typeof inviteId !== "string") return { error: [400, "inviteId required"] };
  expireStaleInvites(Date.now());
  const invite = db().prepare("SELECT * FROM hh_invite WHERE id = ?").get(inviteId) as Row | undefined;
  if (!invite) return { error: [404, "invite not found"] };
  if (invite.status === "expired") return { error: [410, "invite expired"] };
  if (invite.status !== "pending") return { error: [409, `invite already ${invite.status}`] };
  return { invite };
}

householdRouter.post("/invites/accept", async (req: Request, res: Response) => {
  const pid = req.person!.id;
  const { inviteId, pin } = (req.body ?? {}) as { inviteId?: unknown; pin?: unknown };
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) return fail(res, 400, "pin must be 4 to 6 digits");
  const { invite, error } = loadPendingInvite(inviteId);
  if (!invite) return fail(res, error![0], error![1]);
  const me = getPerson(pid);
  // The code alone is not enough: the signed-in person's verified phone must be the number the invite was issued for.
  if (!me || !me.phone_hash || !invite.phone_hash || !samePhone(me, invite.phone_hash as string)) {
    audit(pid, "household_invite_phone_mismatch", String(invite.id), { householdId: invite.household_id });
    return fail(res, 403, "this invite was not issued for your verified phone number", { code: "phone_mismatch" });
  }
  const hh = db().prepare("SELECT head_person_id FROM hh_household WHERE id = ?").get(invite.household_id as string) as Row | undefined;
  if (!hh) return fail(res, 404, "invite not found");
  if (hh.head_person_id === pid) return fail(res, 400, "cannot accept your own invite");
  if (householdOf(pid)) return fail(res, 409, "already in a household");
  // One PIN, in identity. If the person already has one, accepting must prove it rather than overwrite it.
  const hasPin = !!(me.pin_salt && me.pin_hash);
  if (hasPin) {
    const r = await checkPin(me, pin);
    if (r !== "ok") return r === "wrong" ? fail(res, 403, "wrong pin", { code: "wrong_pin" }) : fail(res, r === "limited" ? 429 : 423, r === "limited" ? "too many wrong PINs; wait and retry" : "pin locked", { code: "pin_locked" });
  } else if (weakPinReason(pin)) return fail(res, 400, WEAK_PIN_MESSAGE, { code: "weak_pin" });
  const newHash = hasPin ? null : await hashPinAsync(pin);
  const notice = getNotice("household_invite")!;
  const consentId = recordConsent(pid, "household_invite", notice.version);
  const now = Date.now();
  tx(() => {
    db().prepare("INSERT INTO hh_member (id, household_id, person_id, relation, status, consent_id, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), invite.household_id as string, pid, invite.relation as string, "accepted", consentId, now);
    if (newHash) {
      const { salt, hash } = newHash;
      db().prepare("UPDATE persons SET pin_salt = ?, pin_hash = ? WHERE id = ?").run(salt, hash, pid);
    }
    db().prepare("UPDATE hh_invite SET status='accepted', phone_hash=NULL, accepted_person_id=? WHERE id=?").run(pid, invite.id as string);
  });
  audit(pid, "household_invite_accepted", String(invite.id), { consent: consentId });
  res.json({ ok: true, householdId: invite.household_id });
});

householdRouter.post("/invites/decline", (req: Request, res: Response) => {
  const { invite, error } = loadPendingInvite((req.body ?? {}).inviteId);
  if (!invite) return fail(res, error![0], error![1]);
  startCooldown(invite.phone_hash as string | null, String(invite.household_id), "declined", Date.now());
  db().prepare("UPDATE hh_invite SET status='declined', phone_hash=NULL WHERE id=?").run(invite.id as string);
  audit(req.person!.id, "household_invite_declined", String(invite.id));
  res.json({ ok: true });
});

/** "I did not agree to this": works on a pending invite, or after acceptance (removes the membership). */
householdRouter.post("/invites/report-not-agreed", (req: Request, res: Response) => {
  const pid = req.person!.id;
  const inviteId = (req.body ?? {}).inviteId;
  if (typeof inviteId !== "string") return fail(res, 400, "inviteId required");
  expireStaleInvites(Date.now());
  const invite = db().prepare("SELECT * FROM hh_invite WHERE id = ?").get(inviteId) as Row | undefined;
  if (!invite) return fail(res, 404, "invite not found");
  if (invite.status === "accepted" && invite.accepted_person_id !== pid) return fail(res, 403, "not your invite");
  startCooldown((invite.phone_hash as string | null) ?? getPerson(pid)?.phone_hash, String(invite.household_id), "reported", Date.now());
  if (invite.status === "accepted") db().prepare("DELETE FROM hh_member WHERE person_id = ? AND household_id = ?").run(pid, invite.household_id as string);
  db().prepare("UPDATE hh_invite SET status='reported', phone_hash=NULL WHERE id=?").run(inviteId);
  audit(pid, "household_invite_reported_not_agreed", inviteId, { householdId: invite.household_id });
  res.json({ ok: true });
});

// ---- Minor dependents
householdRouter.post("/dependents", (req: Request, res: Response) => {
  const pid = req.person!.id;
  const h = householdOf(pid);
  if (!h?.isHead) return fail(res, 403, "only the household head can add dependents");
  const { relation, yearOfBirth, parentalConsentVersion } = (req.body ?? {}) as { relation?: unknown; yearOfBirth?: unknown; parentalConsentVersion?: unknown };
  if (typeof relation !== "string" || !(DEPENDENT_RELATIONS as readonly string[]).includes(relation)) return fail(res, 400, "invalid relation");
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(yearOfBirth) || (yearOfBirth as number) > thisYear || (yearOfBirth as number) < thisYear - 120) return fail(res, 400, "invalid yearOfBirth");
  if (thisYear - (yearOfBirth as number) >= 18) return fail(res, 400, "dependents must be under 18; adults must be invited");
  if (typeof parentalConsentVersion !== "string" || !getNotice("minor_dependent", parentalConsentVersion)) return fail(res, 400, "parental consent version required");
  const nDeps = (db().prepare("SELECT COUNT(*) AS c FROM hh_member WHERE household_id = ? AND status = 'dependent'").get(h.household.id as string) as { c: number }).c;
  if (nDeps >= maxDependents()) return fail(res, 409, `a household can list at most ${maxDependents()} dependents`, { code: "dependents_cap" });
  const consentId = recordConsent(pid, "minor_dependent", parentalConsentVersion);
  const id = randomUUID();
  // Deliberately no name, no phone, no person_id: the schema CHECK makes a dependent unable to hold an account.
  db().prepare("INSERT INTO hh_member (id, household_id, person_id, relation, status, year_of_birth, consent_id, created_at) VALUES (?,?,NULL,?,?,?,?,?)")
    .run(id, h.household.id as string, relation, "dependent", yearOfBirth as number, consentId, Date.now());
  audit(pid, "dependent_added", id, { consent: consentId });
  res.status(201).json({ id, consentId });
});

// ---- Head transfer and removal
/** S-149: the head proposes; nothing changes until the recipient confirms (72 h). One pending proposal per household. */
householdRouter.post("/transfer-head", (req: Request, res: Response) => {
  const pid = req.person!.id;
  const h = householdOf(pid);
  if (!h?.isHead) return fail(res, 403, "only the head can transfer the role");
  const to = (req.body ?? {}).toPersonId;
  if (typeof to !== "string") return fail(res, 400, "toPersonId required");
  const hid = h.household.id as string;
  const m = db().prepare("SELECT id FROM hh_member WHERE household_id=? AND person_id=? AND status='accepted'").get(hid, to) as Row | undefined;
  if (!m) return fail(res, 400, "target must be an accepted adult member");
  const now = Date.now();
  expireStaleInvites(now);
  if (db().prepare("SELECT 1 FROM hh_transfer WHERE household_id = ? AND status = 'pending'").get(hid)) return fail(res, 409, "a transfer is already waiting for confirmation", { code: "transfer_pending" });
  const id = randomUUID();
  db().prepare("INSERT INTO hh_transfer (id, household_id, from_person, to_person, status, created_at, expires_at) VALUES (?,?,?,?,'pending',?,?)").run(id, hid, pid, to, now, now + TRANSFER_TTL_MS);
  audit(pid, "household_head_transfer_proposed", hid, { transfer: id });
  res.status(202).json({ transferId: id, status: "pending", expiresAt: now + TRANSFER_TTL_MS });
});

function loadTransfer(req: Request, res: Response, who: "to" | "from"): Row | null {
  const id = (req.body ?? {}).transferId;
  if (typeof id !== "string") { fail(res, 400, "transferId required"); return null; }
  expireStaleInvites(Date.now());
  const t = db().prepare("SELECT * FROM hh_transfer WHERE id = ?").get(id) as Row | undefined;
  if (!t || t[who === "to" ? "to_person" : "from_person"] !== req.person!.id) { fail(res, 404, "transfer not found"); return null; }
  if (t.status === "expired") { fail(res, 410, "transfer expired", { code: "transfer_expired" }); return null; }
  if (t.status !== "pending") { fail(res, 409, `transfer already ${t.status}`); return null; }
  return t;
}

householdRouter.post("/transfer-head/accept", (req: Request, res: Response) => {
  const t = loadTransfer(req, res, "to");
  if (!t) return;
  const hid = t.household_id as string;
  const hh = db().prepare("SELECT head_person_id FROM hh_household WHERE id = ?").get(hid) as Row | undefined;
  const m = db().prepare("SELECT id FROM hh_member WHERE household_id=? AND person_id=? AND status='accepted'").get(hid, req.person!.id) as Row | undefined;
  if (!hh || hh.head_person_id !== t.from_person || !m) {
    db().prepare("UPDATE hh_transfer SET status='cancelled' WHERE id = ?").run(t.id as string);
    return fail(res, 409, "the household changed; the transfer was cancelled");
  }
  // Old head becomes a regular member (relation 'other'); new head's member row is removed.
  tx(() => {
    db().prepare("DELETE FROM hh_member WHERE id = ?").run(m.id as string);
    db().prepare("UPDATE hh_household SET head_person_id = ? WHERE id = ?").run(req.person!.id, hid);
    db().prepare("INSERT INTO hh_member (id, household_id, person_id, relation, status, created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), hid, t.from_person as string, "other", "accepted", Date.now());
    db().prepare("UPDATE hh_transfer SET status='accepted' WHERE id = ?").run(t.id as string);
  });
  audit(req.person!.id, "household_head_transferred", hid, { from: t.from_person, transfer: t.id });
  res.json({ ok: true });
});
householdRouter.post("/transfer-head/decline", (req: Request, res: Response) => {
  const t = loadTransfer(req, res, "to");
  if (!t) return;
  db().prepare("UPDATE hh_transfer SET status='declined' WHERE id = ?").run(t.id as string);
  audit(req.person!.id, "household_head_transfer_declined", String(t.household_id), { transfer: t.id });
  res.json({ ok: true });
});
householdRouter.post("/transfer-head/cancel", (req: Request, res: Response) => {
  const t = loadTransfer(req, res, "from");
  if (!t) return;
  db().prepare("UPDATE hh_transfer SET status='cancelled' WHERE id = ?").run(t.id as string);
  audit(req.person!.id, "household_head_transfer_cancelled", String(t.household_id), { transfer: t.id });
  res.json({ ok: true });
});

householdRouter.delete("/members/:id", (req: Request, res: Response) => {
  const pid = req.person!.id;
  const h = householdOf(pid);
  if (!h) return fail(res, 404, "no household");
  const m = db().prepare("SELECT * FROM hh_member WHERE id=? AND household_id=?").get(req.params.id, h.household.id as string) as Row | undefined;
  if (!m) return fail(res, 404, "member not found");
  if (!h.isHead && m.person_id !== pid) return fail(res, 403, "members may only remove themselves");
  db().prepare("DELETE FROM hh_member WHERE id = ?").run(m.id as string);
  audit(pid, "household_member_removed", String(m.id));
  res.json({ ok: true });
});

// Account erasure (DELETE /me in identity calls every registered hook): remove this person's household footprint.
// Head dissolves the household: members (including dependents) and invites go in one transaction.
householdRouter.delete("/", (req: Request, res: Response) => {
  const pid = req.person!.id;
  const h = householdOf(pid);
  if (!h?.isHead) return fail(res, 403, "only the household head can delete the household");
  const hid = h.household.id as string;
  dissolveHousehold(hid);
  audit(pid, "household_deleted", hid);
  res.json({ ok: true });
});

// ---- Volunteer enrolment (S-136): the volunteer never chooses or knows the adult's PIN. Creates a PENDING person; the adult activates with the
// code + OTP texted to their own phone and sets their own PIN (POST /identity/activate). Breaking change: `pin` is rejected and the response is
// `{enrolmentId, personId, status: "pending", expiresAt}` (it was `{personId, tier}`).
householdRouter.post("/volunteer/enrol", async (req: Request, res: Response) => {
  const vid = req.person!.id;
  const v = getPerson(vid);
  if (!v || v.role !== "volunteer") return fail(res, 403, "only enrolled volunteers can enrol adults");
  const b = (req.body ?? {}) as { phone?: unknown; pin?: unknown; noticeVersion?: unknown; noticeShown?: unknown; contextKind?: unknown; contextRef?: unknown; label?: unknown };
  // Nothing is stored, and no quota is spent, until the notice is confirmed shown and the input is valid.
  if (b.pin !== undefined) return fail(res, 400, "a volunteer must not set or know the adult's PIN; the adult chooses it when activating", { code: "pin_not_allowed" });
  if (b.noticeShown !== true || typeof b.noticeVersion !== "string" || !getNotice("signup", b.noticeVersion)) return fail(res, 400, "the signup notice must be shown to the adult first (noticeShown and a valid noticeVersion)");
  const norm = normalisePhone(b.phone);
  if (!norm) return fail(res, 400, "invalid phone");
  if (typeof b.contextKind !== "string" || !(ENROL_CONTEXTS as readonly string[]).includes(b.contextKind)) return fail(res, 400, "contextKind must be household or shg");
  if (b.contextRef !== undefined && (typeof b.contextRef !== "string" || b.contextRef.length > 64)) return fail(res, 400, "invalid contextRef");
  if (b.label !== undefined && (typeof b.label !== "string" || b.label.length > 40)) return fail(res, 400, "invalid label");
  const notice = getNotice("signup", b.noticeVersion)!;
  const r = await createEnrolment({
    volunteerId: vid, phone: norm, contextKind: b.contextKind, contextRef: (b.contextRef as string | undefined) ?? null, label: (b.label as string | undefined) ?? null,
    noticeVersion: notice.version, noticeText: `${notice.text.te}\n\n${notice.text.en}\n\n[DRAFT NOTICE ${notice.version}]`,
  });
  if ("error" in r) return fail(res, r.status, r.error, { ...(r.code ? { code: r.code } : {}), ...(r.degraded ? { degraded: true, notice: DEGRADED_NOTICE } : {}) });
  res.status(201).json({ enrolmentId: r.enrolmentId, personId: r.personId, status: "pending", expiresAt: r.expiresAt });
});

// Account erasure (DELETE /me in identity calls every registered hook): remove this person's household footprint, atomically.
registerErasureHook("households", (personId) => {
  const d = db();
  let dissolved: string | null = null;
  tx(() => {
    d.prepare("UPDATE hh_transfer SET status='cancelled' WHERE status='pending' AND (from_person = ? OR to_person = ?)").run(personId, personId);
    d.prepare("DELETE FROM hh_member WHERE person_id = ?").run(personId);
    d.prepare("UPDATE hh_invite SET accepted_person_id = NULL WHERE accepted_person_id = ?").run(personId);
    // A departing head with no accepted adult members dissolves the household (and its dependents); otherwise the role passes to the oldest adult member.
    const h = d.prepare("SELECT id FROM hh_household WHERE head_person_id = ?").get(personId) as { id: string } | undefined;
    if (h) {
      const next = d.prepare("SELECT id, person_id FROM hh_member WHERE household_id = ? AND status='accepted' ORDER BY created_at LIMIT 1").get(h.id) as { id: string; person_id: string } | undefined;
      if (!next) {
        dissolveHousehold(h.id);
        dissolved = h.id;
      } else {
        d.prepare("DELETE FROM hh_member WHERE id = ?").run(next.id);
        d.prepare("UPDATE hh_household SET head_person_id = ? WHERE id = ?").run(next.person_id, h.id);
      }
    }
  });
  if (dissolved) audit("system", "household_dissolved_on_erasure", dissolved);
});
