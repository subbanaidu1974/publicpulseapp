/**
 * Anonymous survey credential (S-29 eligibility + single shot, S-30 blind-signed token). Mounted by the registry at /api/v1/civic/surveys.
 *
 *   GET  /:id/credential/key?class=T1|T2|T1_LOW|T2_LOW  public: the survey's RSA public key for that key class
 *   GET  /:id/credential/eligibility                   auth:   can I answer, and with which key class
 *   POST /:id/credential/request {blinded,nonce,key_class}  auth: eligibility + has_responded + blind signature (issue at most once)
 *   POST /:id/respond {token,prefix,signature,answers,strata}  NO auth, NO cookies, no person id: redeem the credential
 *
 * Single shot: the has_responded(person, survey) row (IDENTITY store) is inserted in the SAME transaction that signs the blinded value,
 * so a credential is issued at most once per person per survey. A second request is 409 already_responded and never reissues.
 * Retry window: a client that lost the HTTP response may repeat the SAME request (same nonce, same blinded value) for 10 minutes and gets
 * the SAME blind signature back (stored encrypted in cred_idem, identity store, deleted after the window) - never a second credential.
 * Failure mode, stated openly to users: if the credential is issued but the answer is never submitted (the person closes the app, or
 * loses connection for good), their one shot is used. There is deliberately NO re-issue route.
 *
 * Key classes: one RSA key per (survey, class) so the tier (T1/T2) and the reduced-trust quality flag of a response are server-verified
 * without the server learning which response belongs to whom; the cost is that "which class" is visible at issuance and in the response.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { audit, getDb, getKeys, getStore, registerErasureHook, registerMigration, requireAuth, runInStore } from "../core";
import { hasResponded, networkPrefix } from "../identity/service";
import { BLIND_ALG, PREFIX_LEN, TOKEN_LEN, blindSign, bytesToBig, generateKey, keyBytes, keyFromJwk, publicJwk, spentKey, verifyCredential, bigToBytes, type PrivateKey, type PublicKey } from "./blind";
import { KEY_CLASSES, checkEligibility, isIneligible, mandalInScope, qualityOfClass, tierOfClass, type KeyClass } from "./eligibility";
import { registerJob } from "../jobs";
import { AGE_BANDS, GENDERS, ResponseInvalid, afterEnqueue, flushResponses, journalInsert, validateAnswers, type Strata } from "./responses";
import { getSurveyForResponse, isOpenNow, type SurveyForResponse } from "./source";

registerMigration("survey_cred_001_idem", `
CREATE TABLE cred_idem (
  person_id TEXT NOT NULL, survey_id TEXT NOT NULL, nonce_hash TEXT NOT NULL, blinded_hash TEXT NOT NULL, sig_enc TEXT NOT NULL, created_ms INTEGER NOT NULL,
  PRIMARY KEY (person_id, survey_id, nonce_hash)
);
CREATE INDEX idx_cred_idem_created ON cred_idem(created_ms);
`);

const PURPOSE = "survey-credential";
export const idemWindowMs = (): number => Math.max(1000, (Number(process.env.CIVIC_SURVEY_IDEM_MINUTES) || 10) * 60_000);
export const credentialClock = { now: () => new Date() };

registerErasureHook("identity.cred_idem", (personId) => { getDb().prepare("DELETE FROM cred_idem WHERE person_id = ?").run(personId); });
/** Job: drop retry-window rows past their window (they are also dropped lazily on every issuance). */
export function purgeCredentialIdem(now: Date = credentialClock.now()): number {
  return Number(getDb().prepare("DELETE FROM cred_idem WHERE created_ms <= ?").run(now.getTime() - idemWindowMs()).changes);
}

// ---- per-survey signing keys (survey store; private part encrypted by the civic key provider) ----
const inflight = new Map<string, Promise<PrivateKey>>();
const rowId = (surveyId: string, cls: KeyClass) => `${surveyId}|${cls}`;
const b64 = (x: bigint, len: number) => bigToBytes(x, len).toString("base64url");

function loadKey(surveyId: string, cls: KeyClass): PrivateKey | null {
  const r = getStore("survey").prepare("SELECT n_b64, e_b64, bits, d_enc FROM survey_signing_key WHERE survey_id = ? AND key_class = ?").get(surveyId, cls) as { n_b64: string; e_b64: string; bits: number; d_enc: string } | undefined;
  if (!r) return null;
  const pub = keyFromJwk({ n: r.n_b64, e: r.e_b64 });
  const { d } = JSON.parse(getKeys().decrypt(PURPOSE, r.d_enc)) as { d: string };
  return { ...pub, bits: r.bits, d: bytesToBig(Buffer.from(d, "base64url")) };
}
export function publicKeyOf(surveyId: string, cls: KeyClass): PublicKey | null {
  const r = getStore("survey").prepare("SELECT n_b64, e_b64, bits FROM survey_signing_key WHERE survey_id = ? AND key_class = ?").get(surveyId, cls) as { n_b64: string; e_b64: string; bits: number } | undefined;
  return r ? { ...keyFromJwk({ n: r.n_b64, e: r.e_b64 }), bits: r.bits } : null;
}
/** The signing key for (survey, class), created on first use. */
export async function ensureSigningKey(surveyId: string, cls: KeyClass): Promise<PrivateKey> {
  const have = loadKey(surveyId, cls);
  if (have) return have;
  const id = rowId(surveyId, cls);
  let p = inflight.get(id);
  if (!p) {
    p = (async () => {
      const k = await generateKey();
      const len = keyBytes(k);
      getStore("survey").prepare("INSERT OR IGNORE INTO survey_signing_key (survey_id, key_class, n_b64, e_b64, bits, d_enc) VALUES (?,?,?,?,?,?)")
        .run(surveyId, cls, b64(k.n, len), b64(k.e, 3), k.bits, getKeys().encrypt(PURPOSE, JSON.stringify({ d: b64(k.d, len) })));
      return loadKey(surveyId, cls)!;
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

// ---- helpers ----
const b64uRe = /^[A-Za-z0-9_-]+$/;
const decode = (v: unknown, len: number): Buffer | null => (typeof v === "string" && v.length <= 2 * len && b64uRe.test(v) && Buffer.from(v, "base64url").length === len ? Buffer.from(v, "base64url") : null);
const err = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) => res.status(status).json({ error: code, message, ...extra });
const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response) => {
  Promise.resolve().then(() => fn(req, res)).catch(() => { if (!res.headersSent) err(res, 500, "internal", "something went wrong; nothing was recorded"); });
};
const sha = (b: Uint8Array | string) => crypto.createHash("sha256").update(b).digest("hex");
const asKeyClass = (v: unknown): KeyClass | null => (typeof v === "string" && (KEY_CLASSES as string[]).includes(v) ? (v as KeyClass) : null);

export class AlreadyResponded extends Error { constructor() { super("already_responded"); } }

/**
 * Issue at most once. Runs in ONE identity transaction: retry-window lookup, has_responded insert, blind signature, retry-window store.
 * Returns the blind signature (base64url) and whether it came from the retry window.
 */
export function issueCredential(personId: string, surveyId: string, sk: PrivateKey, blinded: Buffer, nonce: string, now: Date = credentialClock.now()): { blindSignature: string; replayed: boolean } {
  const nonceHash = sha(`${surveyId}|${nonce}`), blindedHash = sha(blinded);
  purgeCredentialIdem(now); // expired retry-window rows go first, outside the transaction (a refused request rolls its transaction back)
  return runInStore("identity", () => {
    const d = getDb();
    const prior = d.prepare("SELECT blinded_hash, sig_enc FROM cred_idem WHERE person_id = ? AND survey_id = ? AND nonce_hash = ?").get(personId, surveyId, nonceHash) as { blinded_hash: string; sig_enc: string } | undefined;
    if (prior) {
      if (prior.blinded_hash !== blindedHash) throw new NonceReuse();
      return { blindSignature: getKeys().decrypt(PURPOSE, prior.sig_enc), replayed: true };
    }
    // day-granular ts: the identity side keeps "which day", never a time of day
    const ins = d.prepare("INSERT OR IGNORE INTO has_responded (person_id, survey_id, ts) VALUES (?,?,?)").run(personId, surveyId, now.toISOString().slice(0, 10));
    if (Number(ins.changes) !== 1) throw new AlreadyResponded();
    const sig = blindSign(sk, blinded).toString("base64url");
    d.prepare("INSERT INTO cred_idem (person_id, survey_id, nonce_hash, blinded_hash, sig_enc, created_ms) VALUES (?,?,?,?,?,?)")
      .run(personId, surveyId, nonceHash, blindedHash, getKeys().encrypt(PURPOSE, sig), now.getTime());
    return { blindSignature: sig, replayed: false };
  });
}
export class NonceReuse extends Error { constructor() { super("nonce_reuse"); } }

// ---- unauthenticated limiter: memory only, never persisted or logged (the respond path must leave no IP trace) ----
const hits = new Map<string, number[]>();
function allowRespond(req: Request): boolean {
  const key = networkPrefix(req.ip || req.socket.remoteAddress || "unknown");
  const now = Date.now(), limit = Number(process.env.CIVIC_SURVEY_RESPOND_PER_MIN) || 30;
  const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return arr.length <= limit;
}
export function resetRespondLimiter(): void { hits.clear(); }

export const credentialRouter = Router();

function loadOpen(req: Request, res: Response, needOpen = true): SurveyForResponse | null {
  const s = getSurveyForResponse(String(req.params.id));
  if (!s) { err(res, 404, "survey_not_found", "no such survey"); return null; }
  if (needOpen && !isOpenNow(s, credentialClock.now())) { err(res, 409, "survey_not_open", "this survey is not open for responses"); return null; }
  return s;
}

credentialRouter.get("/:id/credential/key", wrap(async (req, res) => {
  const s = getSurveyForResponse(String(req.params.id));
  if (!s) return err(res, 404, "survey_not_found", "no such survey");
  const cls = asKeyClass(req.query.class ?? "T1");
  if (!cls) return err(res, 400, "invalid_key_class", `class must be one of ${KEY_CLASSES.join(", ")}`);
  if (!["open", "closed"].includes(s.status) && !publicKeyOf(s.id, cls)) return err(res, 409, "survey_not_open", "keys exist only once a survey is open");
  const k = await ensureSigningKey(s.id, cls);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ survey_id: s.id, key_class: cls, alg: BLIND_ALG, bits: k.bits, key: publicJwk(k), wording_hash: s.wording_hash, review_note: "blind-signature implementation awaits independent cryptographic review" });
}));

credentialRouter.get("/:id/credential/eligibility", requireAuth, wrap((req, res) => {
  const s = getSurveyForResponse(String(req.params.id));
  const e = checkEligibility(req.person!.id, s, credentialClock.now());
  res.setHeader("Cache-Control", "no-store");
  if (isIneligible(e)) return res.json({ eligible: false, code: e.code, message: e.message, ...(e.eligible_from ? { eligible_from: e.eligible_from } : {}) });
  if (hasResponded(req.person!.id, s!.id)) return res.json({ eligible: false, code: "already_responded", message: "one response per person; yours is final" });
  res.json({ eligible: true, key_class: e.keyClass, tier: e.tier, quality: e.quality, mandal: e.mandal, channel: "app", secrecy: "blind_signed" });
}));

credentialRouter.post("/:id/credential/request", requireAuth, express.json({ limit: "8kb" }), wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const s = loadOpen(req, res);
  if (!s) return;
  const personId = req.person!.id;
  const e = checkEligibility(personId, s, credentialClock.now());
  if (isIneligible(e)) return err(res, e.status, e.code, e.message, e.eligible_from ? { eligible_from: e.eligible_from } : {});
  const cls = asKeyClass(req.body?.key_class);
  if (!cls) return err(res, 400, "invalid_key_class", `key_class must be one of ${KEY_CLASSES.join(", ")}`);
  if (cls !== e.keyClass) return err(res, 409, "key_class_mismatch", "use the key class from /credential/eligibility", { key_class: e.keyClass });
  const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return err(res, 400, "invalid_nonce", "nonce must be 16 to 64 URL-safe characters, random per attempt");
  const sk = await ensureSigningKey(s.id, e.keyClass);
  const blinded = decode(req.body?.blinded, keyBytes(sk));
  if (!blinded) return err(res, 400, "invalid_blinded", "blinded must be the base64url of exactly the key length");
  try {
    const out = issueCredential(personId, s.id, sk, blinded, nonce);
    audit(personId, out.replayed ? "survey.credential_retry" : "survey.credential_issued", "survey:" + s.id, {}); // no answer, no token: only that one shot was used
    res.json({ blind_signature: out.blindSignature, key_class: e.keyClass, replayed: out.replayed, note: "this is your one response: if you lose connection after receiving it you may not be able to answer" });
  } catch (x) {
    if (x instanceof AlreadyResponded) return err(res, 409, "already_responded", "one response per person; it is final and cannot be re-issued");
    if (x instanceof NonceReuse) return err(res, 409, "nonce_reuse", "that nonce was used with a different request");
    if (x instanceof Error && /blinded message/.test(x.message)) return err(res, 400, "invalid_blinded", "blinded value out of range");
    throw x;
  }
}));

/** Validate the coarse strata against allowed values and the survey scope. Tier and quality come from the verified key class. */
export function validateStrata(survey: SurveyForResponse, raw: unknown, cls: KeyClass, allowNa = true): Strata {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["age_band", "gender", "tier", "mandal"].includes(k));
  if (extra.length) throw new ResponseInvalid("strata allows only age_band, gender, tier, mandal");
  if (!(AGE_BANDS as readonly string[]).includes(o.age_band as string)) throw new ResponseInvalid(`age_band must be one of ${AGE_BANDS.join(", ")}`);
  if (!(GENDERS as readonly string[]).includes(o.gender as string)) throw new ResponseInvalid(`gender must be one of ${GENDERS.join(", ")}`);
  if (o.tier !== undefined && o.tier !== tierOfClass(cls)) throw new ResponseInvalid("tier does not match the credential");
  const mandal = typeof o.mandal === "string" ? o.mandal : "";
  if (!(allowNa && mandal === "NA") && !mandalInScope(mandal, survey.scope)) throw new ResponseInvalid("mandal is not a mandal inside this survey's scope");
  return { age_band: o.age_band as Strata["age_band"], gender: o.gender as Strata["gender"], tier: tierOfClass(cls), quality: qualityOfClass(cls), mandal };
}

/**
 * Redeem a credential. Deliberately reads nothing about the caller: no Authorization header, no cookies, no IP (the in-memory limiter
 * keys on the network prefix and is never persisted), no request logging; the response carries no id and no timestamp.
 */
credentialRouter.post("/:id/respond", express.json({ limit: "16kb" }), (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("Set-Cookie");
  try {
    if (!allowRespond(req)) return void err(res, 429, "slow_down", "too many attempts; try again in a minute");
    const s = loadOpen(req, res);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = decode(b.token, TOKEN_LEN), prefix = decode(b.prefix, PREFIX_LEN);
    if (!token || !prefix || typeof b.signature !== "string" || !b64uRe.test(b.signature) || b.signature.length > 1400) return void err(res, 400, "invalid_credential", "token, prefix and signature are required");
    const sigBytes = Buffer.from(b.signature, "base64url");
    // which key class signed it (at most four public-key verifications)
    let cls: KeyClass | null = null;
    for (const c of KEY_CLASSES) {
      const pk = publicKeyOf(s.id, c);
      if (pk && verifyCredential(pk, prefix, token, sigBytes)) { cls = c; break; }
    }
    if (!cls) return void err(res, 401, "invalid_credential", "the credential was not issued for this survey");
    let strata: Strata, answers;
    try { answers = validateAnswers(s, b.answers); strata = validateStrata(s, b.strata, cls); }
    catch (x) { if (x instanceof ResponseInvalid) return void err(res, 422, "invalid_response", x.detail); throw x; }
    const key = spentKey(prefix, token);
    try {
      runInStore("survey", () => {
        const ins = getStore("survey").prepare("INSERT OR IGNORE INTO spent_token (survey_id, token_hash) VALUES (?, ?)").run(s.id, key);
        if (Number(ins.changes) !== 1) throw new TokenSpent();
        journalInsert({ survey_id: s.id, answers, strata, kind: "app" });
      });
    } catch (x) {
      if (x instanceof TokenSpent) return void err(res, 409, "token_spent", "this credential was already used");
      throw x;
    }
    afterEnqueue();
    res.status(201).json({ ok: true, message: "recorded; there is no receipt by design" });
  } catch {
    if (!res.headersSent) err(res, 500, "internal", "nothing was recorded; try again");
  }
});
class TokenSpent extends Error { constructor() { super("token_spent"); } }

// Periodic work: flush the shuffled batch buffer (also recovers a journal left by a crash) and drop expired retry-window rows.
registerJob({ name: "surveyResponseFlush", intervalMs: 30_000, run: () => ({ moved: flushResponses(), idemPurged: purgeCredentialIdem() }) });
