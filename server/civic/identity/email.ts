/**
 * Email sign-up and sign-in for people who have no phone number (S-165). Mounted by routes.ts under /api/v1/civic/identity:
 *
 *   POST /signup/email/request     { email }                                  -> 200 { ok, expires_in_s, dev_otp? }
 *   POST /signup/email/verify      { email, otp, pin, consent_version, label? } -> 201 { token, person }
 *   POST /login/email              { email, pin }                              -> 200 { token, person }
 *   POST /pin/recover/email/request{ email }                                  -> 200 { ok }
 *   POST /pin/recover/email        { email, otp, new_pin }                     -> 200 { ok }
 *
 * What an email account is, and is not (docs/EMAIL_ACCOUNTS.md):
 *  - Same PIN rules, lockout, session and erasure as a phone account. The address is stored as a keyed hash plus an encrypted copy, never in clear.
 *  - It carries the flag "email_only". An address is far cheaper to mass-create than a SIM, so an email-only account can report issues but is
 *    NOT survey-eligible, and cannot add household members or link a SIM. Adding a phone or a volunteer attestation is a later story (S-171).
 *  - Gmail dots and "+tags" are folded before hashing, and a short list of throwaway-mail domains is refused (CIVIC_EMAIL_BLOCKED_DOMAINS adds more).
 *  - The code request answers the same whether or not the address already has an account (no enumeration); the owner learns it at verify.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { isLocalHost, isProductionEnv } from "../guards";
import { audit, createSession, getDb, getKeys, recordConsent, requireAuth } from "../core";
import { getMail } from "../providers/mail";
import { hashCandidates } from "../providers/rehash";
import {
  AGE_GATE_DAYS, E164_IN, EMAIL_ONLY_FLAG, OTP_TTL_MS, PIN_RE, lookupNumber, numberFlags, personsOnPhone, phoneHash, WEAK_PIN_MESSAGE, checkPin, consumeOtp, discardOtp, getPerson, hashPinAsync,
  isPendingActivation, loginCeilingAllow, loginSourceAllow, loginSourceReset, networkKeys, otpNetworkLimit, otpRemainingMs, publicPerson, rateAllow,
  resetPinAsync, storeOtp, touchActive, verifyPinAsync, weakPinReason, OTP_NET_WINDOW_MS, hashPin,
} from "./service";
import type { PersonRow } from "./service";
import { capScale, requestContext, sourceKey } from "./network";

const MIN = 60 * 1000;
const DAY = 86_400_000;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const BUILTIN_BLOCKED = ["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "sharklasers.com", "trashmail.com", "getnada.com", "throwawaymail.com"];
const blockedDomains = (): Set<string> => new Set([...BUILTIN_BLOCKED, ...(process.env.CIVIC_EMAIL_BLOCKED_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]);

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
/** Canonical form of an address used for identity, or null when it is not a usable address. Gmail dots and +tags are folded. */
export function normalizeEmail(raw: unknown): string | null {
  const s = str(raw).trim().toLowerCase();
  if (s.length < 6 || s.length > 254 || !EMAIL_RE.test(s) || s.includes("..")) return null;
  const at = s.lastIndexOf("@");
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (local.startsWith(".") || local.endsWith(".")) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split("+")[0].replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}
export const isBlockedEmailDomain = (canonical: string): boolean => blockedDomains().has(canonical.slice(canonical.lastIndexOf("@") + 1));

/** The identifier under which OTP rows, rate limits and hashes are keyed. The prefix keeps it apart from "+91…" phone numbers. */
export const emailKey = (canonical: string): string => "email:" + canonical;
export const emailHash = (canonical: string): string => getKeys().hmac("phone", emailKey(canonical));
const emailHashCandidates = (canonical: string): string[] => hashCandidates("phone", emailKey(canonical));

/** The live account on an address (at most one: the hash column is unique), found under any active key version. */
export function personOnEmail(canonical: string): PersonRow | undefined {
  const cands = emailHashCandidates(canonical);
  const d = getDb();
  const rows = d.prepare(`SELECT * FROM persons WHERE email_hash IN (${cands.map(() => "?").join(",")}) AND deleted_at IS NULL`).all(...cands) as unknown as PersonRow[];
  const row = rows.sort((a, b) => cands.indexOf(a.email_hash as string) - cands.indexOf(b.email_hash as string))[0];
  if (row && row.email_hash !== cands[0]) { // lazy move to the current key version, like personsOnPhone
    d.prepare("UPDATE persons SET email_hash = ?, email_enc = ? WHERE id = ?").run(cands[0], getKeys().encrypt("phone", emailKey(canonical)), row.id);
    row.email_hash = cands[0];
  }
  return row;
}

/** Create an email-only account (no phone). Flagged "email_only", so it is not survey-eligible. */
export async function createEmailPerson(opts: { email: string; pin: string; label?: string; consentVersion: string; now?: Date }): Promise<PersonRow> {
  const now = opts.now ?? new Date();
  const h = await hashPinAsync(opts.pin);
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO persons (id, tier, phone_hash, phone_enc, email_hash, email_enc, pin_salt, pin_hash, label, flags, created_at, eligible_from)
     VALUES (?, 'T0', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, emailHash(opts.email), getKeys().encrypt("phone", emailKey(opts.email)), h.salt, h.hash, opts.label ?? null, JSON.stringify([EMAIL_ONLY_FLAG]),
    now.toISOString(), new Date(now.getTime() + AGE_GATE_DAYS * DAY).toISOString());
  touchActive(id, now);
  recordConsent(id, "signup", opts.consentVersion);
  return getPerson(id)!;
}

export const emailHourlyBudget = (): number => Number(process.env.CIVIC_EMAIL_HOURLY_BUDGET || 2000);
const OTP_NOTICE_EN = "Email codes are paused for a short while because of high demand. Please try again soon.";

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}) {
  if (status === 429 && !res.getHeader("Retry-After")) res.setHeader("Retry-After", String(extra.retry_after_s ?? 600));
  res.status(status).json({ error, ...extra });
}
const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch { if (!res.headersSent) fail(res, 500, "internal error"); } // no detail: errors could carry the address
};
const deviceLabel = (req: Request): string => str(req.headers["x-device-name"] || req.headers["user-agent"]).replace(/[^\x20-\x7e]/g, "").slice(0, 60);

/** Shared by sign-up and recovery: validate, rate-limit, store a code and mail it. Answers 200 whether or not the address has an account. */
async function requestEmailCode(req: Request, res: Response, purpose: "signup" | "recovery") {
  const email = normalizeEmail(req.body?.email);
  if (!email) return fail(res, 400, "enter a valid email address");
  if (purpose === "signup" && isBlockedEmailDomain(email)) return fail(res, 400, "this kind of email address cannot be used to sign up; use a regular email address", { code: "email_domain_blocked" });
  const key = emailKey(email);
  const ctx = await requestContext(req);
  for (const k of networkKeys(ctx.ip, ctx.asn)) {
    if (!rateAllow("emailotp:" + k, capScale(ctx, otpNetworkLimit()), OTP_NET_WINDOW_MS)) return fail(res, 429, "too many code requests from this network; wait and retry");
  }
  if (!rateAllow("emailotp:addr:" + key, 3, 10 * MIN) || !rateAllow("emailotp:ip:" + ctx.ip, capScale(ctx, Number(process.env.CIVIC_OTP_IP_LIMIT || 10)), 10 * MIN)
    || (ctx.device && !rateAllow("emailotp:dev:" + ctx.device, 5, 10 * MIN))) return fail(res, 429, "too many code requests; wait and retry");
  const left = otpRemainingMs(key, purpose);
  if (left > 0) return void res.json({ ok: true, already_sent: true, expires_in_s: Math.ceil(left / 1000) });
  if (!rateAllow("email:global", emailHourlyBudget(), 60 * MIN)) return fail(res, 429, "email capacity reached; try again later", { degraded: true, notice_en: OTP_NOTICE_EN });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  storeOtp(key, purpose, code);
  const existing = personOnEmail(email);
  const text = purpose === "signup" && existing
    ? `People Pulse: someone asked to create an account with this address, but it already has one. Sign in with your PIN, or use "forgot PIN". If this was not you, ignore this message.`
    : `People Pulse code: ${code}. Valid for 5 minutes. Do not share it. If you did not ask for this, ignore this message.\nపీపుల్ పల్స్ కోడ్: ${code}. 5 నిమిషాలు చెల్లుతుంది. ఎవరితోనూ పంచుకోవద్దు.`;
  try {
    await getMail().send({ to: email, subject: "People Pulse: your code", text, idempotencyKey: `otp:${purpose}:${crypto.createHash("sha256").update(key + code).digest("hex").slice(0, 24)}` });
  } catch {
    discardOtp(key, purpose);
    audit("system", "email_otp.delivery_failed", "otp", { purpose });
    return fail(res, 502, "we could not send the code; try again in a moment", { delivery: "failed", can_retry: true });
  }
  const body: Record<string, unknown> = { ok: true, purpose, expires_in_s: OTP_TTL_MS / 1000 };
  if (process.env.CIVIC_EXPOSE_DEV_OTP === "1" && !isProductionEnv() && isLocalHost(req) && !(purpose === "signup" && existing)) body.dev_otp = code;
  res.json(body);
}

export function createEmailRouter(): Router {
  const r = Router();
  r.use(express.json({ limit: "10kb" }));

  r.post("/signup/email/request", wrap((req, res) => requestEmailCode(req, res, "signup")));
  r.post("/pin/recover/email/request", wrap((req, res) => requestEmailCode(req, res, "recovery")));

  r.post("/signup/email/verify", wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email), otp = str(req.body?.otp), pin = str(req.body?.pin);
    if (!email || !/^\d{6}$/.test(otp)) return fail(res, 400, "invalid email or code");
    if (!PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
    const why = weakPinReason(pin);
    if (why) return fail(res, 400, WEAK_PIN_MESSAGE, { code: "weak_pin", reason: why });
    if (isBlockedEmailDomain(email)) return fail(res, 400, "this kind of email address cannot be used to sign up", { code: "email_domain_blocked" });
    if (!consumeOtp(emailKey(email), "signup", otp)) return fail(res, 400, "code expired or invalid; request a new one");
    if (personOnEmail(email)) return fail(res, 409, "this email already has an account; sign in, or use forgot PIN", { code: "email_registered" });
    let p: PersonRow;
    try { p = await createEmailPerson({ email, pin, label: str(req.body?.label).slice(0, 40) || undefined, consentVersion: str(req.body?.consent_version) || "v1" }); }
    catch { return fail(res, 409, "this email already has an account; sign in, or use forgot PIN", { code: "email_registered" }); } // lost a race on the unique index
    audit(p.id, "signup.complete", "person:" + p.id, { via: "email" });
    res.status(201).json({ token: createSession(p.id, { label: deviceLabel(req) }), person: publicPerson(p) });
  }));

  const DUMMY = hashPin("000000");
  r.post("/login/email", wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email), pin = str(req.body?.pin);
    if (!email || !PIN_RE.test(pin)) return fail(res, 400, "invalid email or PIN");
    const key = emailKey(email);
    const ctx = await requestContext(req);
    const src = sourceKey(ctx);
    if (!rateAllow("login:ip:" + ctx.ip, capScale(ctx, 60), 15 * MIN) || !loginSourceAllow(key, "", src)) return fail(res, 429, "too many attempts; wait and retry");
    const target = personOnEmail(email);
    if (!target || isPendingActivation(target)) { await verifyPinAsync(pin, DUMMY.salt, DUMMY.hash); return fail(res, 401, "wrong email or PIN"); }
    if (!loginCeilingAllow(key, [target.id], src)) return fail(res, 429, "too many sign-in attempts for this address; wait and retry, or reset your PIN with a code sent to your email", { limited: true });
    const result = await checkPin(target, pin, new Date(), src);
    if (result === "limited") return fail(res, 429, "too many wrong PINs for this sign-in; wait and retry, or reset your PIN with a code sent to your email", { limited: true });
    if (result === "ok") {
      loginSourceReset(key, "", src);
      touchActive(target.id); audit(target.id, "login", "person:" + target.id, { via: "email" });
      return void res.json({ token: createSession(target.id, { label: deviceLabel(req) }), person: publicPerson(getPerson(target.id)!) });
    }
    if (result === "locked" || result === "just_locked") return fail(res, 423, "too many wrong PINs from this device; sign-in from here is locked for 30 minutes. You can reset the PIN with a code sent to your email.", { locked: true });
    fail(res, 401, "wrong email or PIN");
  }));

  /**
   * Upgrade path (S-167): an email-only account adds a phone number. The code is requested with POST /signup/request {phone} (same limits and
   * number checks as any sign-up); this route consumes it. On success the account gets the phone, loses "email_only" and takes the number's
   * intelligence flags, so it becomes survey-eligible once its own 14-day waiting period is over. At most one phone per account, and the usual
   * cap of adults per number applies.
   */
  r.post("/phone/add", requireAuth, wrap(async (req, res) => {
    const phone = str(req.body?.phone), otp = str(req.body?.otp);
    if (!E164_IN.test(phone) || !/^\d{6}$/.test(otp)) return fail(res, 400, "invalid phone or code");
    const me = getPerson(req.person!.id);
    if (!me) return fail(res, 404, "not found");
    if (me.phone_hash) return fail(res, 409, "this account already has a phone number", { code: "phone_already_set" });
    if (!rateAllow("phoneadd:" + me.id, 5, 60 * MIN)) return fail(res, 429, "too many attempts; wait and retry");
    if (!consumeOtp(phone, "signup", otp)) return fail(res, 400, "code expired or invalid; request a new one");
    if (personsOnPhone(phone).length >= Number(process.env.CIVIC_MAX_ADULTS_PER_SIM || 5)) return fail(res, 409, "this number already has the most adults it can have", { code: "sim_full" });
    const info = await lookupNumber(phone);
    if (info.voip) return fail(res, 403, "this number cannot be used on an account");
    const flags = [...(JSON.parse(me.flags) as string[]).filter((f) => f !== EMAIL_ONLY_FLAG), ...numberFlags(info)];
    getDb().prepare("UPDATE persons SET phone_hash = ?, phone_enc = ?, flags = ? WHERE id = ? AND phone_hash IS NULL")
      .run(phoneHash(phone), getKeys().encrypt("phone", phone), JSON.stringify(flags), me.id);
    audit(me.id, "phone.add", "person:" + me.id, { flagged: flags.length > 0 });
    res.json({ person: publicPerson(getPerson(me.id)!) });
  }));

  r.post("/pin/recover/email", wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email), otp = str(req.body?.otp), pin = str(req.body?.new_pin);
    if (!email || !/^\d{6}$/.test(otp)) return fail(res, 400, "invalid email or code");
    if (!PIN_RE.test(pin)) return fail(res, 400, "PIN must be 4 to 6 digits");
    const why = weakPinReason(pin);
    if (why) return fail(res, 400, WEAK_PIN_MESSAGE, { code: "weak_pin", reason: why });
    const ctx = await requestContext(req);
    if (!rateAllow("recover:ip:" + ctx.ip, capScale(ctx, 20), 15 * MIN)) return fail(res, 429, "too many attempts; wait and retry");
    if (!consumeOtp(emailKey(email), "recovery", otp)) return fail(res, 400, "code expired or invalid; request a new one");
    const target = personOnEmail(email);
    if (!target) return fail(res, 400, "no account on this email");
    await resetPinAsync(target.id, pin);
    audit(target.id, "pin.recover", "person:" + target.id, { via: "email" });
    res.json({ ok: true });
  }));

  return r;
}
