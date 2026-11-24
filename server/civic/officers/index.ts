/**
 * Verified government officer onboarding (S-141, docs/OFFICERS.md). Mounted at /api/v1/civic/officers.
 *
 *  Applicant (any signed-in person):
 *    GET  /domains                       public: the official e-mail domain allow-list
 *    POST /applications                  {full_name, department, designation?, official_email, jurisdiction?, letter_ref}; letter_ref is the
 *                                        "media:<id>" returned by POST /issues/media (JPEG or PNG scan, same size/scan/strip/encrypt rules)
 *    GET  /applications/mine             own applications and where they stand
 *    POST /applications/:id/withdraw     only before an admin has verified the letter
 *  Admin (role admin; actions also need the TOTP code, as everywhere in the admin API):
 *    GET  /admin/queue?status=           the verification queue (privileged read, audited)
 *    GET  /admin/applications/:id/letter the letter image (privileged read, audited, never cached)
 *    POST /admin/applications/:id/verify {letter_checked: true, note?}: first admin. Files the dual-control grant request.
 *    POST /admin/applications/:id/reject {note}: one admin may refuse; refusing is the safe direction.
 *
 * Two checks, two kinds of reviewer: the DOMAIN check is automated at submission (an address off the allow-list is refused and nothing is
 * stored); the LETTER check is human. A verified application becomes an ordinary dual-control role request (admin/routes.insertRoleRequest),
 * so a DIFFERENT admin approves it through the existing /admin/roles/requests/:id/approve, and only then the scoped officer role exists.
 * The application status follows that request (approved, rejected, expired). The applicant never holds a role until then.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { audit, auditPrivilegedRead, getDb, getKeys, getStore, hasRole, registerErasureHook, registerMigration, requireAuth, requireRole } from "../core";
import { rateAllow } from "../identity/service";
import { RoleRequestError, insertRoleRequest, requireMfa } from "../admin/routes";
import { MediaError, attachMedia, claimMedia, getMedia, readMediaFile } from "../issues/media";
import { CATEGORY_LIST } from "../issues/categories";
import { getUnit } from "../geo/service";
import { getMail } from "../providers/mail";
import { isLocalHost, isProductionEnv } from "../guards";
import { checkOfficialEmail, officerDomains } from "./domains";

export { checkOfficialEmail, officerDomains } from "./domains";

registerMigration("officers_001_application", `
CREATE TABLE IF NOT EXISTS officer_application (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  details_enc TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  department TEXT NOT NULL,
  designation TEXT NOT NULL DEFAULT '',
  jurisdiction TEXT NOT NULL DEFAULT '',
  letter_ref TEXT NOT NULL,
  domain_check TEXT NOT NULL,
  status TEXT NOT NULL,
  letter_checked INTEGER NOT NULL DEFAULT 0,
  role_request_id TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS officer_application_person ON officer_application(person_id, created_at);
CREATE INDEX IF NOT EXISTS officer_application_status ON officer_application(status, created_at);
`, "identity");

// Proof that the applicant controls the official address (a one-time code sent through the MailProvider). The code is stored only as a keyed hash.
registerMigration("officers_002_email_confirm", `
ALTER TABLE officer_application ADD COLUMN email_code_hash TEXT;
ALTER TABLE officer_application ADD COLUMN email_code_expires TEXT;
ALTER TABLE officer_application ADD COLUMN email_code_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE officer_application ADD COLUMN email_sends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE officer_application ADD COLUMN email_sent_at TEXT;
ALTER TABLE officer_application ADD COLUMN email_confirmed_at TEXT;
`, "identity");

// A person's application (name, work e-mail, the letter reference) goes with the account. The letter file itself is erased by the media hook.
registerErasureHook("officers.application", (personId) => { getDb().prepare("DELETE FROM officer_application WHERE person_id = ?").run(personId); });

export type ApplicationStatus = "submitted" | "awaiting_second_admin" | "approved" | "rejected" | "withdrawn" | "expired";
interface Row {
  id: string; person_id: string; details_enc: string; email_domain: string; department: string; designation: string; jurisdiction: string; letter_ref: string;
  domain_check: string; status: ApplicationStatus; letter_checked: number; role_request_id: string | null; reviewed_by: string | null; reviewed_at: string | null;
  review_note: string | null; created_at: string; updated_at: string;
  email_code_hash: string | null; email_code_expires: string | null; email_code_tries: number; email_sends: number; email_sent_at: string | null; email_confirmed_at: string | null;
}

const PURPOSE = "people_contact"; // the existing contact-details key purpose; no new key material needed for name and e-mail at rest
const applyPerPerson = () => Number(process.env.CIVIC_OFFICER_APPLY_PER_30D || 3);
const applyPerIpHour = () => Number(process.env.CIVIC_OFFICER_APPLY_PER_IP_HOUR || 20);
const DAY = 86400_000;
const EMAIL_CODE_TTL_MS = 15 * 60_000;
const EMAIL_RESEND_GAP_MS = 60_000;
const emailSendsMax = () => Math.max(1, Number(process.env.CIVIC_OFFICER_EMAIL_SENDS || 5));
const EMAIL_TRIES_MAX = 5;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clean = (v: unknown, max: number): string => str(v).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const JURISDICTION = /^[A-Za-z0-9][A-Za-z0-9-]{1,39}$/;
export const OFFICER_DEPARTMENTS: string[] = [...new Set(CATEGORY_LIST.map((c) => c.department))];

export class OfficerError extends Error { constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); } }

/** Bring the application in line with its dual-control request (approved, rejected or expired by the second admin or by time). */
function sync(row: Row): Row {
  if (row.status !== "awaiting_second_admin" || !row.role_request_id) return row;
  const rr = getDb().prepare("SELECT status, decided_by FROM role_requests WHERE id = ?").get(row.role_request_id) as { status: string; decided_by: string | null } | undefined;
  if (rr?.status === "pending" && new Date((getDb().prepare("SELECT expires_at FROM role_requests WHERE id = ?").get(row.role_request_id) as { expires_at: string }).expires_at) > new Date()) return row;
  let next: ApplicationStatus;
  if (!rr || rr.status === "pending" || rr.status === "expired") next = "expired";
  else if (rr.status === "approved") next = "approved";
  else next = "rejected";
  const now = new Date().toISOString();
  getDb().prepare("UPDATE officer_application SET status = ?, updated_at = ? WHERE id = ?").run(next, now, row.id);
  audit("system", "officer.application." + next, "application:" + row.id, { request: row.role_request_id, decided_by: rr?.decided_by ?? null });
  return { ...row, status: next, updated_at: now };
}
const rowOf = (id: string): Row | undefined => {
  const r = getDb().prepare("SELECT * FROM officer_application WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? sync(r) : undefined;
};
const details = (r: Row): { full_name: string; email: string } => { try { return JSON.parse(getKeys().decrypt(PURPOSE, r.details_enc)); } catch { return { full_name: "", email: "" }; } };

const mine = (r: Row) => ({
  id: r.id, status: r.status, department: r.department, designation: r.designation || null, jurisdiction: r.jurisdiction || null, email_domain: r.email_domain,
  domain_check: r.domain_check, letter_checked: !!r.letter_checked, email_confirmed: !!r.email_confirmed_at, can_confirm_email: r.status === "submitted" && !r.email_confirmed_at, created_at: r.created_at, updated_at: r.updated_at, can_withdraw: r.status === "submitted",
});
const adminView = (r: Row) => {
  const d = details(r);
  return { ...mine(r), person_id: r.person_id, full_name: d.full_name, official_email: d.email, role_request_id: r.role_request_id, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, review_note: r.review_note };
};

const codeHash = (appId: string, code: string): string => getKeys().hmac("otp", `officer-email:${appId}:${code}`);

/**
 * Send (or re-send) the one-time confirmation code to the application's official e-mail through the MailProvider. Returns the code only so the
 * route can echo it when CIVIC_EXPOSE_DEV_MAIL=1 outside production; callers never log it.
 */
export async function sendEmailConfirmation(personId: string, appId: string, now = new Date()): Promise<{ sent: true; expires_in_s: number; code: string }> {
  const r = rowOf(appId);
  if (!r || r.person_id !== personId) throw new OfficerError(404, "application not found");
  if (r.status !== "submitted") throw new OfficerError(409, `application is ${r.status}`, { code: "not_reviewable" });
  if (r.email_confirmed_at) throw new OfficerError(409, "this e-mail address is already confirmed", { code: "email_already_confirmed" });
  if (r.email_sent_at && now.getTime() - new Date(r.email_sent_at).getTime() < EMAIL_RESEND_GAP_MS) throw new OfficerError(429, "a code was just sent; wait a minute before asking again", { code: "email_resend_wait" });
  if (r.email_sends >= emailSendsMax()) throw new OfficerError(429, "too many confirmation e-mails for this application", { code: "email_send_limit" });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const t = now.toISOString();
  getDb().prepare("UPDATE officer_application SET email_code_hash = ?, email_code_expires = ?, email_code_tries = 0, email_sends = email_sends + 1, email_sent_at = ?, updated_at = ? WHERE id = ?")
    .run(codeHash(r.id, code), new Date(now.getTime() + EMAIL_CODE_TTL_MS).toISOString(), t, t, r.id);
  try {
    await getMail().send({
      to: details(r).email, subject: "People Pulse: confirm your official e-mail address",
      text: `Your People Pulse confirmation code is ${code}. It is valid for 15 minutes. Enter it in the officer application screen. If you did not apply, ignore this message.`,
      idempotencyKey: `officer-email:${r.id}:${r.email_sends + 1}`,
    });
  } catch {
    getDb().prepare("UPDATE officer_application SET email_code_hash = NULL, email_code_expires = NULL, email_sent_at = NULL WHERE id = ?").run(r.id);
    audit(personId, "officer.application.email_failed", "application:" + r.id, {});
    throw new OfficerError(502, "we could not send the e-mail; try again in a moment", { code: "email_delivery_failed", can_retry: true });
  }
  audit(personId, "officer.application.email_sent", "application:" + r.id, { n: r.email_sends + 1 });
  return { sent: true, expires_in_s: EMAIL_CODE_TTL_MS / 1000, code };
}

/** Check the code the applicant typed. Five wrong tries or the expiry burn the code (they ask for a new one). */
export function confirmEmail(personId: string, appId: string, codeIn: unknown, now = new Date()): { ok: true; email_confirmed: true } {
  const r = rowOf(appId);
  if (!r || r.person_id !== personId) throw new OfficerError(404, "application not found");
  if (r.status !== "submitted") throw new OfficerError(409, `application is ${r.status}`, { code: "not_reviewable" });
  if (r.email_confirmed_at) return { ok: true, email_confirmed: true };
  if (!rateAllow("officer-email-confirm:" + personId, 30, 3600_000, now.getTime())) throw new OfficerError(429, "too many attempts; wait and retry", { code: "rate_limited" });
  const code = str(codeIn).replace(/\s+/g, "");
  if (!r.email_code_hash || !r.email_code_expires || new Date(r.email_code_expires) <= now) throw new OfficerError(410, "the code has expired; ask for a new one", { code: "email_code_expired" });
  const ok = /^\d{6}$/.test(code) && crypto.timingSafeEqual(Buffer.from(codeHash(r.id, code)), Buffer.from(r.email_code_hash));
  if (!ok) {
    const tries = r.email_code_tries + 1;
    const burnt = tries >= EMAIL_TRIES_MAX;
    if (burnt) getDb().prepare("UPDATE officer_application SET email_code_hash = NULL, email_code_expires = NULL, email_code_tries = ? WHERE id = ?").run(tries, r.id);
    else getDb().prepare("UPDATE officer_application SET email_code_tries = ? WHERE id = ?").run(tries, r.id);
    throw new OfficerError(400, burnt ? "too many wrong codes; ask for a new one" : "that code is not right", { code: burnt ? "email_code_expired" : "email_code_wrong" });
  }
  const t = now.toISOString();
  getDb().prepare("UPDATE officer_application SET email_confirmed_at = ?, email_code_hash = NULL, email_code_expires = NULL, updated_at = ? WHERE id = ?").run(t, t, r.id);
  audit(personId, "officer.application.email_confirmed", "application:" + r.id, {});
  return { ok: true, email_confirmed: true };
}

export interface ApplyInput { full_name?: unknown; department?: unknown; designation?: unknown; official_email?: unknown; jurisdiction?: unknown; letter_ref?: unknown }

/** Submit an application. Throws OfficerError (status, message, extra.code); exported for tests and ops tooling. */
export function submitApplication(personId: string, input: ApplyInput, ip = "-", now = new Date()): { id: string; status: ApplicationStatus } {
  if (!rateAllow("officer-apply-ip:" + ip, applyPerIpHour(), 3600_000, now.getTime())) throw new OfficerError(429, "too many applications from this network; wait and retry", { code: "rate_limited" });
  if (!rateAllow("officer-apply-try:" + personId, 30, 3600_000, now.getTime())) throw new OfficerError(429, "too many attempts; wait and retry", { code: "rate_limited" }); // every attempt, valid or not
  const fullName = clean(input.full_name, 120), department = clean(input.department, 64), designation = clean(input.designation, 80), jurisdiction = clean(input.jurisdiction, 40);
  if (fullName.length < 3) throw new OfficerError(400, "full name is required", { code: "name_required" });
  if (!OFFICER_DEPARTMENTS.includes(department)) throw new OfficerError(400, "unknown department", { code: "unknown_department", departments: OFFICER_DEPARTMENTS });
  if (jurisdiction) {
    if (!JURISDICTION.test(jurisdiction)) throw new OfficerError(400, "invalid jurisdiction", { code: "jurisdiction_format" });
    const geo = (getStore("issues").prepare("SELECT COUNT(*) c FROM admin_unit").get() as { c: number } | undefined)?.c ?? 0;
    if (geo && !getUnit(jurisdiction)) throw new OfficerError(400, "unknown jurisdiction", { code: "unknown_jurisdiction" });
  }
  const dom = checkOfficialEmail(str(input.official_email));
  if ("reason" in dom) {
    audit(personId, "officer.application.domain_refused", "person:" + personId, { reason: dom.reason });
    throw new OfficerError(dom.reason === "bad_email" ? 400 : 422, dom.reason === "bad_email" ? "enter a valid official e-mail address" : "this e-mail domain is not on the official list", { code: dom.reason });
  }
  if (hasRole(personId, "officer")) throw new OfficerError(409, "you already hold the officer role", { code: "already_officer" });
  const d = getDb();
  for (const o of d.prepare("SELECT * FROM officer_application WHERE person_id = ? AND status = 'awaiting_second_admin'").all(personId) as unknown as Row[]) sync(o);
  if (d.prepare("SELECT 1 AS x FROM officer_application WHERE person_id = ? AND status IN ('submitted','awaiting_second_admin')").get(personId)) throw new OfficerError(409, "an application of yours is already under review", { code: "application_open" });
  const id = crypto.randomUUID();
  let mediaId: string;
  try { mediaId = claimMedia(str(input.letter_ref), personId, "photo"); } catch (e) { if (e instanceof MediaError) throw new OfficerError(400, "attach the letter first (a JPEG or PNG scan)", { code: "letter_required" }); throw e; }
  // only a complete, valid application uses up the monthly allowance, so a typo does not lock anyone out
  if (!rateAllow("officer-apply:" + personId, applyPerPerson(), 30 * DAY, now.getTime())) throw new OfficerError(429, "application limit reached; try again later", { code: "rate_limited" });
  const t = now.toISOString();
  d.prepare(`INSERT INTO officer_application (id, person_id, details_enc, email_domain, department, designation, jurisdiction, letter_ref, domain_check, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'pass', 'submitted', ?, ?)`)
    .run(id, personId, getKeys().encrypt(PURPOSE, JSON.stringify({ full_name: fullName, email: dom.email })), dom.domain, department, designation, jurisdiction, "media:" + mediaId, t, t);
  attachMedia(mediaId, "officer-application:" + id); // attached media is kept for the retention period instead of the 24 hour unattached purge
  audit(personId, "officer.application.submit", "application:" + id, { department, domain: dom.domain, jurisdiction });
  return { id, status: "submitted" };
}

export const officersRouter = Router();
officersRouter.use(express.json({ limit: "10kb" }));

const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
  try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); }
  catch (e) {
    if (e instanceof OfficerError || e instanceof RoleRequestError) return void res.status(e.status).json({ error: e.message, ...e.extra });
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
};

officersRouter.get("/domains", (req, res) => {
  if (!rateAllow("officer-domains:" + (req.ip || "?"), 60, 60_000)) return void res.status(429).json({ error: "too many requests; wait and retry" });
  res.set("Cache-Control", "public, max-age=300");
  res.json({ domains: officerDomains().map((d) => ({ domain: d.domain, body_en: d.body_en, body_te: d.body_te })), departments: OFFICER_DEPARTMENTS });
});

officersRouter.post("/applications", requireAuth, wrap(async (req, res) => {
  const out = submitApplication(req.person!.id, req.body ?? {}, req.ip || "-");
  res.status(201);
  // the e-mail goes out after the application is stored; a mail failure leaves the application in place and the person can ask again
  const body: Record<string, unknown> = { ...out, email_confirmation: "sent" };
  try {
    const sent = await sendEmailConfirmation(req.person!.id, out.id);
    if (process.env.CIVIC_EXPOSE_DEV_MAIL === "1" && !isProductionEnv() && isLocalHost(req)) body.dev_email_code = sent.code;
  } catch { body.email_confirmation = "failed"; }
  return body;
}));

officersRouter.post("/applications/:id/email/resend", requireAuth, wrap(async (req) => {
  const sent = await sendEmailConfirmation(req.person!.id, String(req.params.id));
  const body: Record<string, unknown> = { ok: true, expires_in_s: sent.expires_in_s };
  if (process.env.CIVIC_EXPOSE_DEV_MAIL === "1" && !isProductionEnv() && isLocalHost(req)) body.dev_email_code = sent.code;
  return body;
}));

officersRouter.post("/applications/:id/email/confirm", requireAuth, wrap((req) => confirmEmail(req.person!.id, String(req.params.id), req.body?.code)));

officersRouter.get("/applications/mine", requireAuth, wrap((req) => {
  const rows = getDb().prepare("SELECT * FROM officer_application WHERE person_id = ? ORDER BY created_at DESC LIMIT 20").all(req.person!.id) as unknown as Row[];
  return { applications: rows.map((r) => mine(sync(r))) };
}));

officersRouter.post("/applications/:id/withdraw", requireAuth, wrap((req) => {
  const r = rowOf(String(req.params.id));
  if (!r || r.person_id !== req.person!.id) throw new OfficerError(404, "application not found");
  if (r.status !== "submitted") throw new OfficerError(409, "this application can no longer be withdrawn", { code: "not_withdrawable" });
  getDb().prepare("UPDATE officer_application SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
  audit(req.person!.id, "officer.application.withdraw", "application:" + r.id, {});
  return { ok: true, status: "withdrawn" };
}));

// ---------------------------------------------------------------------------------------------
// Admin verification queue
// ---------------------------------------------------------------------------------------------

officersRouter.get("/admin/queue", requireRole("admin"), wrap((req) => {
  const status = clean(req.query.status, 32) || "submitted";
  for (const r of getDb().prepare("SELECT * FROM officer_application WHERE status = 'awaiting_second_admin'").all() as unknown as Row[]) sync(r); // so the status filter is accurate
  const rows = getDb().prepare("SELECT * FROM officer_application WHERE status = ? ORDER BY created_at ASC LIMIT 200").all(status) as unknown as Row[];
  auditPrivilegedRead(req.person!.id, "officer_applications", "admin lists the officer verification queue");
  return { applications: rows.map(adminView) };
}));

officersRouter.get("/admin/applications/:id/letter", requireRole("admin"), (req, res) => {
  const r = rowOf(String(req.params.id));
  const m = r ? getMedia(r.letter_ref.replace(/^media:/, "")) : null;
  const buf = m ? readMediaFile(m) : null;
  if (!r || !m || !buf) return void res.status(404).json({ error: "letter not found" });
  auditPrivilegedRead(req.person!.id, "officer_letter:" + r.id, "admin views an officer application letter");
  res.set({ "Content-Type": m.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'" });
  res.send(buf);
});

officersRouter.post("/admin/applications/:id/verify", requireRole("admin"), requireMfa, wrap((req, res) => {
  const me = req.person!.id;
  const r = rowOf(String(req.params.id));
  if (!r) throw new OfficerError(404, "application not found");
  if (r.person_id === me) throw new OfficerError(403, "you cannot review your own application", { code: "self_grant" });
  if (r.status !== "submitted") throw new OfficerError(409, `application is ${r.status}`, { code: "not_reviewable" });
  if (!r.email_confirmed_at) throw new OfficerError(409, "the applicant has not confirmed the official e-mail address yet", { code: "email_not_confirmed" });
  if (req.body?.letter_checked !== true) throw new OfficerError(400, "confirm that you checked the letter against the application", { code: "letter_check_required" });
  const note = clean(req.body?.note, 300);
  if (!checkOfficialEmail(details(r).email).ok) throw new OfficerError(422, "the e-mail domain is no longer on the official list", { code: "domain_not_allowed" }); // the registry may have changed since submission
  const rr = insertRoleRequest(me, { action: "grant", personId: r.person_id, role: "officer", jurisdiction: r.jurisdiction, department: r.department, reason: `officer application ${r.id.slice(0, 8)}: letter checked` });
  const now = new Date().toISOString();
  getDb().prepare("UPDATE officer_application SET status = 'awaiting_second_admin', letter_checked = 1, role_request_id = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?")
    .run(rr.id, me, now, note || null, now, r.id);
  audit(me, "officer.application.verify", "application:" + r.id, { request: rr.id, department: r.department });
  res.status(201);
  return { id: r.id, status: "awaiting_second_admin", role_request_id: rr.id, expires_at: rr.expires_at, next: "a different admin approves the role request" };
}));

officersRouter.post("/admin/applications/:id/reject", requireRole("admin"), requireMfa, wrap((req) => {
  const me = req.person!.id;
  const r = rowOf(String(req.params.id));
  if (!r) throw new OfficerError(404, "application not found");
  if (r.status !== "submitted" && r.status !== "awaiting_second_admin") throw new OfficerError(409, `application is ${r.status}`, { code: "not_reviewable" });
  const note = clean(req.body?.note, 300);
  if (note.length < 5) throw new OfficerError(400, "a short reason is required", { code: "note_required" });
  const now = new Date().toISOString();
  if (r.role_request_id) getDb().prepare("UPDATE role_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(me, now, r.role_request_id);
  getDb().prepare("UPDATE officer_application SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?").run(me, now, note, now, r.id);
  audit(me, "officer.application.reject", "application:" + r.id, { request: r.role_request_id });
  return { ok: true, status: "rejected" };
}));
