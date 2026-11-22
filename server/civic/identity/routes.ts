import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { audit, createSession, getDb, getKeys, getSms, requireAuth, revokeSessions } from "../core";
import {
  E164_IN, OTP_TTL_MS, PIN_RE, attest, checkPin, createPerson, deleteAccount, getNumberIntelligence, getPerson, hashPin,
  personsOnSim, phoneHash, publicPerson, rateAllow, verifyPin,
} from "./service";

export * from "./service";

/** Mounted at /api/v1/civic/identity. */
export const identityRouter = Router();
identityRouter.use(express.json({ limit: "10kb" }));

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const MAX_SIM = Number(process.env.CIVIC_MAX_ADULTS_PER_SIM || 5);
const MIN = 60 * 1000;

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ error, ...extra });
}
const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch { if (!res.headersSent) fail(res, 500, "internal error"); } // no detail: errors could carry PII
};
const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || "unknown";
const deviceOf = (req: Request) => str(req.headers["x-device-id"]).slice(0, 64);

// Timing-equalising dummy hash for unknown phones.
const DUMMY = hashPin("000000");

identityRouter.post("/signup/request", wrap(async (req, res) => {
  const phone = str(req.body?.phone);
  if (!E164_IN.test(phone)) return fail(res, 400, "phone must be an Indian mobile number in +91 E.164 form");
  const hourlyBudget = Number(process.env.CIVIC_SMS_HOURLY_BUDGET || 2000);
  if (!rateAllow("sms:global", hourlyBudget, 60 * MIN)) return fail(res, 503, "sms capacity reached; try again later", { degraded: true });
  const dev = deviceOf(req);
  if (!rateAllow("otp:phone:" + phone, 3, 10 * MIN) || !rateAllow("otp:ip:" + ipOf(req), 10, 10 * MIN) || (dev && !rateAllow("otp:dev:" + dev, 5, 10 * MIN))) {
    return fail(res, 429, "too many OTP requests; wait and retry");
  }
  const info = await getNumberIntelligence().lookup(phone);
  if (info.voip) { audit("system", "signup.blocked", "number_intel", { reason: "voip" }); return fail(res, 403, "this number cannot be used to sign up"); }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const k = getKeys();
  getDb().prepare("INSERT OR REPLACE INTO otps (phone_hash, code_hash, expires_at, attempts) VALUES (?,?,?,0)")
    .run(phoneHash(phone), k.hmac("otp", code), new Date(Date.now() + OTP_TTL_MS).toISOString());
  await getSms().send(phone, `People Pulse code: ${code}. Valid for 5 minutes. Do not share it.`);
  const body: Record<string, unknown> = { ok: true, expires_in_s: OTP_TTL_MS / 1000 };
  if (process.env.CIVIC_EXPOSE_DEV_OTP === "1" && process.env.NODE_ENV !== "production") body.dev_otp = code;
  res.json(body);
}));

identityRouter.post("/signup/verify", wrap(async (req, res) => {
  const phone = str(req.body?.phone), otp = str(req.body?.otp), pin = str(req.body?.pin);
  if (!E164_IN.test(phone) || !/^\d{6}$/.test(otp)) return fail(res, 400, "invalid phone or otp");
  if (!PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
  const d = getDb();
  const ph = phoneHash(phone);
  const row = d.prepare("SELECT code_hash, expires_at, attempts FROM otps WHERE phone_hash = ?").get(ph) as { code_hash: string; expires_at: string; attempts: number } | undefined;
  if (!row || row.expires_at < new Date().toISOString() || row.attempts >= 5) return fail(res, 400, "code expired or invalid; request a new one");
  const given = Buffer.from(getKeys().hmac("otp", otp), "hex"), want = Buffer.from(row.code_hash, "hex");
  if (!crypto.timingSafeEqual(given, want)) {
    d.prepare("UPDATE otps SET attempts = attempts + 1 WHERE phone_hash = ?").run(ph);
    return fail(res, 400, "code expired or invalid; request a new one");
  }
  d.prepare("DELETE FROM otps WHERE phone_hash = ?").run(ph);
  if (personsOnSim(ph).length > 0) return fail(res, 409, "this number already has an account; sign in, or have an adult on it link you", { code: "number_registered" });
  const info = await getNumberIntelligence().lookup(phone);
  if (info.voip) return fail(res, 403, "this number cannot be used to sign up");
  const flags = info.recently_reissued ? ["recently_reissued"] : [];
  const p = createPerson({ phone, pin, label: str(req.body?.label).slice(0, 40) || undefined, flags, consentVersion: str(req.body?.consent_version) || "v1" });
  if (flags.length) audit("system", "signup.flagged", "person:" + p.id, { flags });
  audit(p.id, "signup.complete", "person:" + p.id, {});
  res.status(201).json({ token: createSession(p.id), person: publicPerson(p) });
}));

identityRouter.post("/sim/link", requireAuth, wrap(async (req, res) => {
  const pin = str(req.body?.pin);
  if (!PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
  if (!str(req.body?.consent_version)) return fail(res, 400, "consent_version is required: the new adult must have accepted the notice");
  if (!rateAllow("link:" + req.person!.id, 5, 60 * MIN)) return fail(res, 429, "too many link attempts");
  const me = getPerson(req.person!.id);
  if (!me?.phone_hash || !me.phone_enc) return fail(res, 409, "your number is no longer on file");
  const members = personsOnSim(me.phone_hash);
  if (members.length >= MAX_SIM) return fail(res, 409, `at most ${MAX_SIM} adults can share one number`);
  const phone = getKeys().decrypt("phone", me.phone_enc);
  const p = createPerson({ phone, pin, label: str(req.body?.label).slice(0, 40) || undefined, flags: JSON.parse(me.flags) as string[], consentVersion: str(req.body?.consent_version) });
  audit(me.id, "sim.link", "person:" + p.id, {});
  try { await getSms().send(phone, "People Pulse: another adult was added to your number. If this was not you, reply STOP or contact the grievance officer."); } catch { /* best effort */ }
  // The PIN is never echoed. The new adult signs in with their own person_id and PIN.
  res.status(201).json({ person: publicPerson(p) });
}));

identityRouter.get("/sim/members", requireAuth, wrap((req, res) => {
  const me = getPerson(req.person!.id);
  if (!me?.phone_hash) return fail(res, 404, "not found");
  const now = new Date().toISOString();
  res.json({ members: personsOnSim(me.phone_hash).map((m) => ({ person_id: m.id, label: m.label, locked: !!m.locked_until && m.locked_until > now, self: m.id === me.id })) });
}));

identityRouter.post("/login", wrap(async (req, res) => {
  const phone = str(req.body?.phone), pin = str(req.body?.pin), personId = str(req.body?.person_id);
  if (!E164_IN.test(phone) || !PIN_RE.test(pin)) return fail(res, 400, "invalid phone or PIN");
  if (!rateAllow("login:phone:" + phone, 30, 15 * MIN) || !rateAllow("login:ip:" + ipOf(req), 60, 15 * MIN)) return fail(res, 429, "too many attempts; wait and retry");
  const cands = personsOnSim(phoneHash(phone));
  if (cands.length === 0) { verifyPin(pin, DUMMY.salt, DUMMY.hash); return fail(res, 401, "wrong phone or PIN"); }
  let target = cands[0];
  if (personId) {
    const t = cands.find((c) => c.id === personId);
    if (!t) { verifyPin(pin, DUMMY.salt, DUMMY.hash); return fail(res, 401, "wrong phone or PIN"); }
    target = t;
  } else if (cands.length > 1) {
    return fail(res, 400, "several adults share this number; send person_id", { code: "person_required" });
  }
  const r = await checkPin(target, pin);
  if (r === "ok") { audit(target.id, "login", "person:" + target.id, {}); return void res.json({ token: createSession(target.id), person: publicPerson(getPerson(target.id)!) }); }
  if (r === "locked" || r === "just_locked") return fail(res, 423, "too many wrong PINs; this sign-in is locked for 30 minutes. The number's owner has been told.", { locked: true });
  fail(res, 401, "wrong phone or PIN");
}));

identityRouter.get("/me", requireAuth, wrap((req, res) => {
  const p = getPerson(req.person!.id);
  if (!p) return fail(res, 404, "not found");
  // Deliberately no attestor identities, no phone, no PIN data.
  res.json({ person: publicPerson(p) });
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
  audit(p.id, "residence.declare", "person:" + p.id, { unit: unit ?? "" });
  res.json({ person: publicPerson(getPerson(p.id)!) });
}));

identityRouter.post("/attest", requireAuth, wrap((req, res) => {
  const r = attest(req.person!.id, str(req.body?.person_id));
  if ("error" in r) return fail(res, r.status, r.error);
  res.json({ ok: true, tier: r.tier, independent_attestors: r.independent_attestors });
}));

identityRouter.delete("/me", requireAuth, wrap((req, res) => {
  const p = getPerson(req.person!.id);
  if (!p) return fail(res, 404, "not found");
  const pin = str(req.body?.pin);
  if (!p.pin_salt || !p.pin_hash || !verifyPin(pin, p.pin_salt, p.pin_hash)) return fail(res, 401, "PIN required to delete the account");
  const out = deleteAccount(p.id);
  revokeSessions(p.id);
  res.json({ deleted: true, audit_rows_redacted: out.audit_rows_redacted });
}));

