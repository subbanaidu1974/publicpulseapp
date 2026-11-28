import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { isLocalHost, isProductionEnv } from "../guards";
import {
  audit, auditPrivilegedRead, createSession, getDb, getKeys, getSms, listRoles, listSessions, requireAuth, revokeSessionById, revokeSessions,
} from "../core";
import {
  DEGRADED_NOTICE, E164_IN, OTP_NET_WINDOW_MS, OTP_TTL_MS, PIN_RE, WEAK_PIN_MESSAGE, attest, checkPin, consumeOtp, createPersonAsync, deleteAccount,
  discardOtp, getPerson, hashPin, isElevatedRisk, isLockedAnywhere, isPendingActivation, lookupNumber, loginCeilingAllow, loginSourceAllow, loginSourceReset, networkKeys,
  numberFlags, numberRisk, otpNetworkLimit, otpRemainingMs, personsOnPhone, publicPerson, rateAllow, resetPinAsync, riskCapFactor, sendSmsReport, simMembers,
  smsBudgetAllow, smsHourlyBudget, storeOtp, touchActive, verifyPinAsync, weakPinReason,
} from "./service";
import type { OtpPurpose, SmsDelivery } from "./service";
import { capScale, requestContext, sourceKey } from "./network";
import { ENROL_CONTEXTS, activateEnrolment, cancelEnrolment, createEnrolment, listAttestRequests, listEnrolmentsOf, listRecheckTasks, runRecheckSampler, submitRecheckResult } from "./enrolment";
import { registerJob } from "../jobs";
import { getNotice } from "../households/routes";
import { markSmsExhausted, otpQueue } from "../../degraded";
import { createEmailRouter } from "./email";

export * from "./service";
export * from "./network";
export * from "./enrolment";
export { normalizeEmail } from "./email";

/** Mounted at /api/v1/civic/identity. */
export const identityRouter = Router();
identityRouter.use(express.json({ limit: "10kb" }));
identityRouter.use(createEmailRouter()); // S-165: sign-up and sign-in by email for people with no phone

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const MAX_SIM = Number(process.env.CIVIC_MAX_ADULTS_PER_SIM || 5);
const MIN = 60 * 1000;
/** Bilingual notice on the OTP capacity (429) and queue-full (503) answers, like the degraded shed gate (the sign-up UI prefers these). */
const OTP_NOTICE = {
  notice_en: "Sign-up codes are paused for a short while because of high demand. Existing sessions keep working. Please try again soon.",
  notice_te: "అధిక రద్దీ కారణంగా సైన్ అప్ కోడ్‌లు కొద్దిసేపు నిలిపివేయబడ్డాయి. ఇప్పటికే ఉన్న సెషన్లు పనిచేస్తాయి. దయచేసి కొద్దిసేపటి తర్వాత ప్రయత్నించండి.",
} as const;

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}) {
  if (status === 429 && !res.getHeader("Retry-After")) res.setHeader("Retry-After", String(extra.retry_after_s ?? 600));
  res.status(status).json({ error, ...extra });
}
const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch { if (!res.headersSent) fail(res, 500, "internal error"); } // no detail: errors could carry PII
};
/** Short, display-only name of the calling device (shown in the sessions list). */
const deviceLabel = (req: Request): string => str(req.headers["x-device-name"] || req.headers["user-agent"]).replace(/[^\x20-\x7e]/g, "").slice(0, 60);
const weakPin = (res: Response, pin: string): boolean => {
  const why = weakPinReason(pin);
  if (!why) return false;
  fail(res, 400, WEAK_PIN_MESSAGE, { code: "weak_pin", reason: why });
  return true;
};
/** +91XXXXXXXXXX from "+91…", "91…" or a bare 10-digit number; null when invalid. */
const normPhone = (raw: unknown): string | null => {
  const m = /^(?:\+?91)?([6-9]\d{9})$/.exec(str(raw).replace(/[\s-]/g, ""));
  return m ? "+91" + m[1] : null;
};

// Timing-equalising dummy hash for unknown phones.
const DUMMY = hashPin("000000");

/** Request a one-time code. purpose = signup (default) | recovery. A still-valid code for the same number and purpose is never replaced. */
async function requestOtp(req: Request, res: Response, purpose: OtpPurpose) {
  const phone = str(req.body?.phone);
  if (!E164_IN.test(phone)) return fail(res, 400, "phone must be an Indian mobile number in +91 E.164 form");
  const ctx = await requestContext(req);
  // Per-network cap (IP prefix, plus the ASN only when it is attested/edge-vouched) on top of the per-phone / per-IP / per-device caps.
  for (const k of networkKeys(ctx.ip, ctx.asn)) {
    if (!rateAllow("otp:" + k, capScale(ctx, otpNetworkLimit()), OTP_NET_WINDOW_MS)) return fail(res, 429, "too many OTP requests from this network; wait and retry");
  }
  if (!rateAllow("otp:phone:" + phone, 3, 10 * MIN) || !rateAllow("otp:ip:" + ctx.ip, capScale(ctx, Number(process.env.CIVIC_OTP_IP_LIMIT || 10)), 10 * MIN) || (ctx.device && !rateAllow("otp:dev:" + ctx.device, 5, 10 * MIN))) {
    return fail(res, 429, "too many OTP requests; wait and retry");
  }
  const left = await otpRemainingMs(phone, purpose);
  if (left > 0) return void res.json({ ok: true, already_sent: true, expires_in_s: Math.ceil(left / 1000) }); // do not let a flood invalidate the owner's pending code
  if (!smsBudgetAllow()) { markSmsExhausted(); return fail(res, 429, "sms capacity reached; try again later", { degraded: true, notice: DEGRADED_NOTICE, ...OTP_NOTICE }); }
  const lane = otpQueue.admit(smsHourlyBudget()); // budget smoothing: a burst beyond the slot allowance waits in a bounded queue
  if (lane.lane === "full") { res.set("Retry-After", String(lane.retryAfterSeconds)); return fail(res, 503, "sms queue is full; try again shortly", { degraded: true, notice: DEGRADED_NOTICE, ...OTP_NOTICE, retry_after_seconds: lane.retryAfterSeconds }); }
  const info = await lookupNumber(phone); // S-162: never throws; a vendor failure is an "unknown" verdict, not a refusal
  if (info.voip && purpose === "signup") { audit("system", "signup.blocked", "number_intel", { reason: "voip" }); return fail(res, 403, "this number cannot be used to sign up"); }
  // S-162: ported / young-prepaid / otherwise elevated-risk numbers get a stricter per-phone cap (CIVIC_RISK_CAP_FACTOR), like capScale for unverified clients.
  if (isElevatedRisk(numberRisk(info)) && !rateAllow("otp:riskphone:" + phone, Math.max(1, Math.floor(3 * riskCapFactor())), 10 * MIN)) return fail(res, 429, "too many OTP requests; wait and retry");
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await storeOtp(phone, purpose, code);
  const text = `People Pulse code: ${code}. Valid for 5 minutes. Do not share it.`;
  // S-164: report what really happened. A failed send drops the stored code so a resend is allowed at once (still inside the per-phone cap and the SMS budget).
  let delivery: SmsDelivery = "queued";
  if (lane.lane === "now") delivery = await sendSmsReport(phone, text);
  else otpQueue.enqueue(async () => { if ((await sendSmsReport(phone, text)) === "failed") await discardOtp(phone, purpose); }, smsHourlyBudget());
  if (delivery === "failed") {
    await discardOtp(phone, purpose);
    audit("system", "otp.delivery_failed", "otp", { purpose });
    return fail(res, 502, "we could not send the code; try again in a moment", { delivery: "failed", can_retry: true });
  }
  const body: Record<string, unknown> = { ok: true, purpose, delivery, expires_in_s: OTP_TTL_MS / 1000, ...(lane.lane === "queued" ? { queued: true, expected_delay_s: lane.retryAfterSeconds } : {}) };
  if (process.env.CIVIC_EXPOSE_DEV_OTP === "1" && !isProductionEnv() && isLocalHost(req)) body.dev_otp = code;
  res.json(body);
}
identityRouter.post("/signup/request", wrap((req, res) => requestOtp(req, res, str(req.body?.purpose) === "recovery" ? "recovery" : "signup")));
/** Recovery code request (forgot PIN). Same limits as sign-up; the code only works for POST /pin/recover. */
identityRouter.post("/pin/recover/request", wrap((req, res) => requestOtp(req, res, "recovery")));

identityRouter.post("/signup/verify", wrap(async (req, res) => {
  const phone = str(req.body?.phone), otp = str(req.body?.otp), pin = str(req.body?.pin);
  if (!E164_IN.test(phone) || !/^\d{6}$/.test(otp)) return fail(res, 400, "invalid phone or otp");
  if (!PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
  if (weakPin(res, pin)) return; // checked before the code is consumed
  if (!(await consumeOtp(phone, "signup", otp))) return fail(res, 400, "code expired or invalid; request a new one");
  if (personsOnPhone(phone).length > 0) return fail(res, 409, "this number already has an account; sign in, or have an adult on it link you", { code: "number_registered" });
  const info = await lookupNumber(phone);
  if (info.voip) return fail(res, 403, "this number cannot be used to sign up");
  const flags = numberFlags(info); // S-162: recycled => recently_reissued (survey-ineligible until a volunteer confirms); risk / ported / unverified flags weight the survey key class
  const p = await createPersonAsync({ phone, pin, label: str(req.body?.label).slice(0, 40) || undefined, flags, consentVersion: str(req.body?.consent_version) || "v1" });
  if (flags.length) audit("system", "signup.flagged", "person:" + p.id, { flags });
  audit(p.id, "signup.complete", "person:" + p.id, {});
  res.status(201).json({ token: createSession(p.id, { label: deviceLabel(req) }), person: publicPerson(p) });
}));

identityRouter.post("/sim/link", requireAuth, wrap(async (req, res) => {
  const pin = str(req.body?.pin);
  if (!PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
  if (weakPin(res, pin)) return;
  if (!str(req.body?.consent_version)) return fail(res, 400, "consent_version is required: the new adult must have accepted the notice");
  if (!rateAllow("link:" + req.person!.id, 5, 60 * MIN)) return fail(res, 429, "too many link attempts");
  const me = getPerson(req.person!.id);
  if (!me?.phone_hash || !me.phone_enc) return fail(res, 409, "your number is no longer on file");
  const members = simMembers(me);
  if (members.length >= MAX_SIM) return fail(res, 409, `at most ${MAX_SIM} adults can share one number`);
  const phone = getKeys().decrypt("phone", me.phone_enc);
  const p = await createPersonAsync({ phone, pin, label: str(req.body?.label).slice(0, 40) || undefined, flags: (JSON.parse(me.flags) as string[]).filter((f) => f !== "pin_reset_required"), consentVersion: str(req.body?.consent_version) });
  audit(me.id, "sim.link", "person:" + p.id, {});
  try { await getSms().send(phone, "People Pulse: another adult was added to your number. If this was not you, reply STOP or contact the grievance officer."); } catch { /* best effort */ }
  // The PIN is never echoed. The new adult signs in with their own person_id and PIN.
  res.status(201).json({ person: publicPerson(p) });
}));

identityRouter.get("/sim/members", requireAuth, wrap((req, res) => {
  const me = getPerson(req.person!.id);
  if (!me?.phone_hash) return fail(res, 404, "not found");
  res.json({ members: simMembers(me).filter((m) => !isPendingActivation(m)).map((m) => ({ person_id: m.id, label: m.label, locked: isLockedAnywhere(m.id), self: m.id === me.id })) });
}));

identityRouter.post("/login", wrap(async (req, res) => {
  const phone = str(req.body?.phone), pin = str(req.body?.pin), personId = str(req.body?.person_id);
  if (!E164_IN.test(phone) || !PIN_RE.test(pin)) return fail(res, 400, "invalid phone or PIN");
  const ctx = await requestContext(req);
  const src = sourceKey(ctx);
  // Limits are per (phone, person, source): someone flooding this phone from their own source only slows themselves.
  if (!rateAllow("login:ip:" + ctx.ip, capScale(ctx, 60), 15 * MIN) || !loginSourceAllow(phone, personId, src)) return fail(res, 429, "too many attempts; wait and retry");
  const cands = personsOnPhone(phone).filter((c) => !isPendingActivation(c));
  if (!loginCeilingAllow(phone, cands.map((c) => c.id), src)) return fail(res, 429, "too many sign-in attempts for this number; wait and retry, or reset your PIN with a code sent to your number", { limited: true });
  if (cands.length === 0) { await verifyPinAsync(pin, DUMMY.salt, DUMMY.hash); return fail(res, 401, "wrong phone or PIN"); }
  let target = cands[0];
  if (personId) {
    const t = cands.find((c) => c.id === personId);
    if (!t) { await verifyPinAsync(pin, DUMMY.salt, DUMMY.hash); return fail(res, 401, "wrong phone or PIN"); }
    target = t;
  } else if (cands.length > 1) {
    return fail(res, 400, "several adults share this number; send person_id", {
      code: "person_required", members: cands.map((c) => ({ person_id: c.id, label: c.label, locked: isLockedAnywhere(c.id) })),
    });
  }
  const r = await checkPin(target, pin, new Date(), src);
  if (r === "limited") return fail(res, 429, "too many wrong PINs for this sign-in; wait and retry, or reset your PIN with a code sent to your number", { limited: true });
  if (r === "ok") {
    loginSourceReset(phone, personId, src);
    touchActive(target.id); audit(target.id, "login", "person:" + target.id, {});
    return void res.json({ token: createSession(target.id, { label: deviceLabel(req) }), person: publicPerson(getPerson(target.id)!) });
  }
  if (r === "locked" || r === "just_locked") return fail(res, 423, "too many wrong PINs from this device; sign-in from here is locked for 30 minutes. The number's owner has been told and can reset the PIN with a code.", { locked: true });
  fail(res, 401, "wrong phone or PIN");
}));

identityRouter.post("/logout", requireAuth, wrap(async (req, res) => {
  if (req.sessionId) await revokeSessionById(req.person!.id, req.sessionId);
  audit(req.person!.id, "logout", "person:" + req.person!.id, {});
  res.json({ ok: true });
}));

identityRouter.get("/sessions", requireAuth, wrap(async (req, res) => {
  res.json({
    sessions: (await listSessions(req.person!.id)).map((s) => ({
      id: s.id, created_at: s.created_at, last_seen: s.last_seen_at, expires_at: s.expires_at, device: s.label, current: s.id === req.sessionId,
    })),
  });
}));
const revokeOne = wrap(async (req, res) => {
  const ok = await revokeSessionById(req.person!.id, str(req.params.id));
  if (!ok) return fail(res, 404, "session not found");
  audit(req.person!.id, "session.revoke", "person:" + req.person!.id, {});
  res.json({ ok: true, current: str(req.params.id) === req.sessionId });
});
identityRouter.post("/sessions/:id/revoke", requireAuth, revokeOne);
identityRouter.delete("/sessions/:id", requireAuth, revokeOne);

/** Owner recovery: a fresh OTP on the number (POST /pin/recover/request) resets the PIN of a person on that number, clears all locks and signs out every device. */
identityRouter.post("/pin/recover", wrap(async (req, res) => {
  const phone = str(req.body?.phone), otp = str(req.body?.otp), pin = str(req.body?.new_pin), personId = str(req.body?.person_id);
  if (!E164_IN.test(phone) || !/^\d{6}$/.test(otp)) return fail(res, 400, "invalid phone or otp");
  if (!PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
  if (weakPin(res, pin)) return;
  const ctx = await requestContext(req);
  if (!rateAllow("recover:ip:" + ctx.ip, capScale(ctx, 20), 15 * MIN)) return fail(res, 429, "too many attempts; wait and retry");
  // A recovery code, or (older clients) the code from /signup/request, both prove control of the number.
  if (!(await consumeOtp(phone, "recovery", otp)) && !(await consumeOtp(phone, "signup", otp))) return fail(res, 400, "code expired or invalid; request a new one");
  const cands = personsOnPhone(phone).filter((c) => !isPendingActivation(c));
  const target = personId ? cands.find((c) => c.id === personId) : cands.length === 1 ? cands[0] : undefined;
  if (!target) return fail(res, 400, cands.length > 1 ? "several adults share this number; send person_id" : "no account on this number", cands.length > 1 ? { code: "person_required", members: cands.map((c) => ({ person_id: c.id, label: c.label, locked: isLockedAnywhere(c.id) })) } : {});
  await resetPinAsync(target.id, pin);
  res.json({ ok: true });
}));

/** Change the PIN while signed in: proves the old PIN, signs out every device, returns a fresh session for this one. */
identityRouter.post("/pin/change", requireAuth, wrap(async (req, res) => {
  const oldPin = str(req.body?.old_pin), pin = str(req.body?.new_pin);
  if (!PIN_RE.test(oldPin) || !PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
  if (weakPin(res, pin)) return;
  const me = getPerson(req.person!.id);
  if (!me) return fail(res, 404, "not found");
  const ctx = await requestContext(req);
  const r = await checkPin(me, oldPin, new Date(), sourceKey(ctx));
  if (r === "locked" || r === "just_locked") return fail(res, 423, "too many wrong PINs; locked for 30 minutes", { locked: true });
  if (r === "limited") return fail(res, 429, "too many wrong PINs; wait and retry", { limited: true });
  if (r !== "ok") return fail(res, 401, "current PIN is wrong");
  await resetPinAsync(me.id, pin);
  res.json({ ok: true, token: createSession(me.id, { label: deviceLabel(req) }) });
}));

identityRouter.get("/me", requireAuth, wrap((req, res) => {
  const p = getPerson(req.person!.id);
  if (!p) return fail(res, 404, "not found");
  // Deliberately no attestor identities, no phone, no PIN data.
  res.json({ person: publicPerson(p), role: p.role, roles: listRoles(p.id).map((r) => r.role) });
}));

identityRouter.post("/residence", requireAuth, wrap((req, res) => {
  const residence = str(req.body?.residence).trim();
  if (residence.length < 2 || residence.length > 200) return fail(res, 400, "residence must be 2 to 200 characters");
  const unit = str(req.body?.unit_id).slice(0, 64) || null;
  const p = getPerson(req.person!.id)!;
  const d = getDb();
  d.prepare("UPDATE persons SET residence_enc = ?, residence_unit = ?, residence_declared_at = ?, tier = 'T1' WHERE id = ?")
    .run(getKeys().encrypt("residence", residence), unit, new Date().toISOString(), p.id);
  if (p.tier === "T2") d.prepare("DELETE FROM attestations WHERE subject_id = ?").run(p.id); // moved: earlier confirmations no longer apply
  touchActive(p.id);
  audit(p.id, "residence.declare", "person:" + p.id, { unit: unit ?? "" });
  res.json({ person: publicPerson(getPerson(p.id)!) });
}));

identityRouter.get("/attest/requests", requireAuth, wrap((req, res) => {
  const me = getPerson(req.person!.id);
  if (!me || me.role !== "volunteer") return fail(res, 403, "only enrolled volunteers can see attestation requests");
  auditPrivilegedRead(me.id, "attest_requests", "volunteer attestation queue");
  res.json({ requests: listAttestRequests(me.id) });
}));

identityRouter.post("/attest", requireAuth, wrap((req, res) => {
  const r = attest(req.person!.id, str(req.body?.person_id));
  if ("error" in r) return fail(res, r.status, r.error);
  res.json({ ok: true, tier: r.tier, independent_attestors: r.independent_attestors });
}));

// ---- Volunteer enrolment (S-136). The volunteer never sees or sets the adult's PIN.
identityRouter.post("/volunteer/enrol", requireAuth, wrap(async (req, res) => {
  const vid = req.person!.id;
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (b.pin !== undefined) return fail(res, 400, "a volunteer must not set or know the adult's PIN; the adult chooses it when activating", { code: "pin_not_allowed" });
  const norm = normPhone(b.phone);
  if (!norm) return fail(res, 400, "invalid phone");
  const ctxIn = b.context;
  const kind = typeof ctxIn === "string" ? ctxIn : typeof ctxIn === "object" && ctxIn !== null ? str((ctxIn as Record<string, unknown>).kind) : str(b.context_kind) || "household";
  const ref = (typeof ctxIn === "object" && ctxIn !== null ? str((ctxIn as Record<string, unknown>).ref) : str(b.context_ref)) || null;
  if (!(ENROL_CONTEXTS as readonly string[]).includes(kind)) return fail(res, 400, "context must be household or shg");
  if (ref && ref.length > 64) return fail(res, 400, "invalid context reference");
  const label = str(b.label).slice(0, 40) || null;
  const notice = getNotice("signup", str(b.notice_version) || undefined) ?? getNotice("signup")!;
  const r = await createEnrolment({ volunteerId: vid, phone: norm, contextKind: kind, contextRef: ref, label, noticeVersion: notice.version, noticeText: `${notice.text.te}\n\n${notice.text.en}\n\n[DRAFT NOTICE ${notice.version}]` });
  if ("error" in r) return fail(res, r.status, r.error, { ...(r.code ? { code: r.code } : {}), ...(r.degraded ? { degraded: true, notice: DEGRADED_NOTICE } : {}) });
  res.status(201).json({ status: "pending", enrolment_id: r.enrolmentId, person_id: r.personId, expires_at: r.expiresAt, enrolmentId: r.enrolmentId, personId: r.personId, expiresAt: r.expiresAt });
}));
identityRouter.get("/volunteer/enrolments", requireAuth, wrap((req, res) => {
  const me = getPerson(req.person!.id);
  if (!me || me.role !== "volunteer") return fail(res, 403, "only enrolled volunteers");
  auditPrivilegedRead(me.id, "enrolments", "volunteer lists own enrolments");
  res.json({ enrolments: listEnrolmentsOf(me.id) });
}));
identityRouter.post("/volunteer/enrolments/:id/cancel", requireAuth, wrap((req, res) => {
  if (!cancelEnrolment(req.person!.id, str(req.params.id))) return fail(res, 404, "no pending enrolment with that id");
  res.json({ ok: true });
}));

// ---- Re-check sampler (S-159). A scheduled job draws a share (CIVIC_RECHECK_FRACTION) of activated enrolments and queues a task for an
// independent volunteer to confirm that the adult agreed and owns the account. No phone number is ever shown to the reviewer.
registerJob({ name: "enrolmentRecheck", intervalMs: 6 * 3_600_000, run: (now) => runRecheckSampler({ now }) });
identityRouter.get("/volunteer/rechecks", requireAuth, wrap((req, res) => {
  const me = getPerson(req.person!.id);
  if (!me || me.role !== "volunteer") return fail(res, 403, "only enrolled volunteers");
  auditPrivilegedRead(me.id, "enrolment_rechecks", "volunteer lists re-check tasks");
  res.json({ rechecks: listRecheckTasks(me.id) });
}));
identityRouter.post("/volunteer/rechecks/:id/result", requireAuth, wrap((req, res) => {
  const r = submitRecheckResult(req.person!.id, str(req.params.id), str(req.body?.outcome));
  if ("error" in r) return fail(res, r.status, r.error);
  res.json({ ok: true, outcome: (r as { outcome: string }).outcome });
}));

/** The adult activates: the code and OTP texted to their own phone, plus a PIN of their own choosing. Public (no session yet). */
identityRouter.post("/activate", wrap(async (req, res) => {
  const ctx = await requestContext(req);
  if (!rateAllow("activate:ip:" + ctx.ip, capScale(ctx, 20), 15 * MIN)) return fail(res, 429, "too many attempts; wait and retry");
  const r = await activateEnrolment({ code: str(req.body?.code), otp: str(req.body?.otp), pin: str(req.body?.pin) });
  if ("error" in r) return fail(res, r.status, r.error, r.code ? { code: r.code } : {});
  res.status(201).json({ token: r.token, person: r.person });
}));

identityRouter.delete("/me", requireAuth, wrap(async (req, res) => {
  const p = getPerson(req.person!.id);
  if (!p) return fail(res, 404, "not found");
  const pin = str(req.body?.pin);
  if (!p.pin_salt || !p.pin_hash || !(await verifyPinAsync(pin, p.pin_salt, p.pin_hash))) return fail(res, 401, "PIN required to delete the account");
  const out = deleteAccount(p.id);
  await revokeSessions(p.id);
  res.json({ deleted: true, audit_rows_redacted: out.audit_rows_redacted });
}));

