/**
 * Server-side WebAuthn (FIDO2) for notification senders (DESIGN_2028 3.8 item 4: FIDO2 hardware keys mandatory for senders).
 * In-house, node:crypto only, no dependency: a CBOR decoder (RFC 8949 subset: definite lengths), COSE key parsing for ES256 (alg -7,
 * P-256) and EdDSA (alg -8, Ed25519), registration verification with attestation "none", and assertion verification.
 *
 * What is checked on registration: clientDataJSON type/challenge/origin, authData rpIdHash, user-present AND user-verified flags,
 * attested credential data, supported COSE algorithm, attestation format "none" (anything else is refused, not trusted).
 * On assertion: type/challenge/origin, rpIdHash, UP and UV, signature over authData || SHA-256(clientDataJSON) with the stored key,
 * and the signature counter (a counter that does not increase, when either side is non-zero, is a clone signal and is refused).
 * NOT done: attestation statement verification / authenticator allow-listing (we accept "none"; a deployment that must pin hardware
 * models needs an attestation trust store), resident-key discovery, extensions. See docs/NOTIFICATIONS.md "WebAuthn: what needs review".
 *
 * rpId / origins come from NOTIFY_WEBAUTHN_RP_ID and NOTIFY_WEBAUTHN_ORIGINS (comma separated). In production both are required.
 */
import crypto from "node:crypto";

// ---------------------------------------------------------------------------------------------
// CBOR (decode only)
// ---------------------------------------------------------------------------------------------

export type CborValue = number | bigint | boolean | null | undefined | string | Buffer | CborValue[] | Map<CborValue, CborValue>;

export function cborDecodeAt(buf: Buffer, start = 0, depth = 0): { value: CborValue; end: number } {
  if (depth > 16) throw new Error("cbor: nesting too deep");
  if (start >= buf.length) throw new Error("cbor: truncated");
  const ib = buf[start];
  const major = ib >> 5, info = ib & 31;
  let p = start + 1;
  const need = (n: number) => { if (p + n > buf.length) throw new Error("cbor: truncated"); };
  let arg: number | bigint;
  if (info < 24) arg = info;
  else if (info === 24) { need(1); arg = buf[p]; p += 1; }
  else if (info === 25) { need(2); arg = buf.readUInt16BE(p); p += 2; }
  else if (info === 26) { need(4); arg = buf.readUInt32BE(p); p += 4; }
  else if (info === 27) { need(8); arg = buf.readBigUInt64BE(p); p += 8; }
  else if (major === 7 && info >= 24) throw new Error("cbor: unsupported");
  else throw new Error("cbor: indefinite length not supported");
  const small = (): number => { if (typeof arg === "bigint") { if (arg > 0xffffffn) throw new Error("cbor: length too large"); return Number(arg); } return arg; };
  switch (major) {
    case 0: return { value: typeof arg === "bigint" && arg <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(arg) : arg, end: p };
    case 1: { const v = typeof arg === "bigint" ? -1n - arg : -1 - arg; return { value: typeof v === "bigint" && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v, end: p }; }
    case 2: { const n = small(); need(n); return { value: Buffer.from(buf.subarray(p, p + n)), end: p + n }; }
    case 3: { const n = small(); need(n); return { value: buf.subarray(p, p + n).toString("utf8"), end: p + n }; }
    case 4: {
      const n = small(); if (n > 4096) throw new Error("cbor: array too large");
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) { const r = cborDecodeAt(buf, p, depth + 1); out.push(r.value); p = r.end; }
      return { value: out, end: p };
    }
    case 5: {
      const n = small(); if (n > 4096) throw new Error("cbor: map too large");
      const m = new Map<CborValue, CborValue>();
      for (let i = 0; i < n; i++) {
        const k = cborDecodeAt(buf, p, depth + 1); const v = cborDecodeAt(buf, k.end, depth + 1);
        m.set(k.value, v.value); p = v.end;
      }
      return { value: m, end: p };
    }
    case 6: return cborDecodeAt(buf, p, depth + 1); // tags are ignored
    default: // major 7
      if (info === 20) return { value: false, end: p };
      if (info === 21) return { value: true, end: p };
      if (info === 22) return { value: null, end: p };
      if (info === 23) return { value: undefined, end: p };
      throw new Error("cbor: unsupported simple value or float");
  }
}
export const cborDecode = (buf: Buffer): CborValue => { const r = cborDecodeAt(buf, 0); if (r.end !== buf.length) throw new Error("cbor: trailing bytes"); return r.value; };

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const isProd = () => process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production";
export interface WebAuthnConfig { rpId: string; rpName: string; origins: string[] }
let override: WebAuthnConfig | null = null;
/** Tests only. */
export function setWebAuthnConfig(c: WebAuthnConfig | null): void { override = c; }
export function webauthnConfig(): WebAuthnConfig {
  if (override) return override;
  const rpId = process.env.NOTIFY_WEBAUTHN_RP_ID || "";
  const origins = (process.env.NOTIFY_WEBAUTHN_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (isProd() && (!rpId || origins.length === 0)) throw new Error("NOTIFY_WEBAUTHN_RP_ID and NOTIFY_WEBAUTHN_ORIGINS are required in production");
  return { rpId: rpId || "localhost", rpName: process.env.NOTIFY_WEBAUTHN_RP_NAME || "People Pulse", origins: origins.length ? origins : ["http://localhost:5173", "http://localhost:3000"] };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export const b64u = (b: Buffer): string => b.toString("base64url");
export const fromB64u = (s: string): Buffer => { if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url"); return Buffer.from(s, "base64url"); };
const sha256 = (b: Buffer | string): Buffer => crypto.createHash("sha256").update(b).digest();

export class WebAuthnError extends Error { constructor(public code: string, m?: string) { super(m ?? code); this.name = "WebAuthnError"; } }
const bad = (code: string): never => { throw new WebAuthnError(code); };

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

export interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }
function parseClientData(json: Buffer, type: "webauthn.create" | "webauthn.get", challenge: string, cfg: WebAuthnConfig): void {
  let cd: ClientData;
  try { cd = JSON.parse(json.toString("utf8")) as ClientData; } catch { return bad("client_data_invalid"); }
  if (cd.type !== type) bad("client_data_type");
  if (typeof cd.challenge !== "string" || cd.challenge.length !== challenge.length || !crypto.timingSafeEqual(Buffer.from(cd.challenge), Buffer.from(challenge))) bad("challenge_mismatch");
  if (!cfg.origins.includes(cd.origin)) bad("origin_not_allowed");
  if (cd.crossOrigin === true) bad("cross_origin");
}

interface AuthData { rpIdHash: Buffer; flags: number; counter: number; credId?: Buffer; coseKey?: Map<CborValue, CborValue> }
function parseAuthData(ad: Buffer, cfg: WebAuthnConfig, o: { requireUv: boolean; attested: boolean }): AuthData {
  if (ad.length < 37) bad("authdata_short");
  const rpIdHash = ad.subarray(0, 32), flags = ad[32], counter = ad.readUInt32BE(33);
  if (!crypto.timingSafeEqual(rpIdHash, sha256(cfg.rpId))) bad("rp_id_mismatch");
  if (!(flags & FLAG_UP)) bad("user_not_present");
  if (o.requireUv && !(flags & FLAG_UV)) bad("user_not_verified");
  const out: AuthData = { rpIdHash, flags, counter };
  if (o.attested) {
    if (!(flags & FLAG_AT)) bad("no_attested_credential");
    if (ad.length < 55) bad("authdata_short");
    const idLen = ad.readUInt16BE(53);
    if (idLen < 1 || idLen > 1023 || ad.length < 55 + idLen) bad("credential_id_invalid");
    out.credId = Buffer.from(ad.subarray(55, 55 + idLen));
    let key: CborValue;
    try { key = cborDecodeAt(ad, 55 + idLen).value; } catch { return bad("cose_key_invalid"); }
    if (!(key instanceof Map)) bad("cose_key_invalid");
    out.coseKey = key as Map<CborValue, CborValue>;
  }
  return out;
}

export type CoseAlg = -7 | -8;
/** COSE_Key -> SPKI DER (base64) and the algorithm. Supports EC2/P-256/ES256 and OKP/Ed25519/EdDSA only. */
export function coseToSpki(key: Map<CborValue, CborValue>): { spki: string; alg: CoseAlg } {
  const kty = key.get(1), alg = key.get(3);
  try {
    if (kty === 2 && alg === -7 && key.get(-1) === 1) {
      const x = key.get(-2), y = key.get(-3);
      if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) return bad("cose_key_invalid");
      const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) }, format: "jwk" });
      return { spki: (pub.export({ type: "spki", format: "der" }) as Buffer).toString("base64"), alg: -7 };
    }
    if (kty === 1 && alg === -8 && key.get(-1) === 6) {
      const x = key.get(-2);
      if (!Buffer.isBuffer(x) || x.length !== 32) return bad("cose_key_invalid");
      const pub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(x) }, format: "jwk" });
      return { spki: (pub.export({ type: "spki", format: "der" }) as Buffer).toString("base64"), alg: -8 };
    }
  } catch (e) { if (e instanceof WebAuthnError) throw e; return bad("cose_key_invalid"); }
  return bad("unsupported_algorithm");
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export interface RegistrationInput { id: string; rawId?: string; type?: string; response: { clientDataJSON: string; attestationObject: string } }
export interface VerifiedRegistration { credentialId: string; spki: string; alg: CoseAlg; counter: number; aaguid: string }

export function verifyRegistration(input: RegistrationInput, expectedChallenge: string, o: { requireUv?: boolean; config?: WebAuthnConfig } = {}): VerifiedRegistration {
  const cfg = o.config ?? webauthnConfig();
  if (!input || typeof input !== "object" || !input.response) return bad("malformed");
  if (input.type !== undefined && input.type !== "public-key") bad("malformed");
  let cdj: Buffer, att: CborValue;
  try { cdj = fromB64u(input.response.clientDataJSON); att = cborDecode(fromB64u(input.response.attestationObject)); } catch { return bad("malformed"); }
  parseClientData(cdj, "webauthn.create", expectedChallenge, cfg);
  if (!(att instanceof Map)) return bad("malformed");
  const fmt = att.get("fmt"), authDataRaw = att.get("authData");
  if (fmt !== "none") return bad("attestation_unsupported"); // only "none" is accepted; nothing else is trusted
  if (!Buffer.isBuffer(authDataRaw)) return bad("malformed");
  const ad = parseAuthData(authDataRaw, cfg, { requireUv: o.requireUv ?? true, attested: true });
  const { spki, alg } = coseToSpki(ad.coseKey!);
  const credentialId = b64u(ad.credId!);
  if (typeof input.id === "string" && input.id !== credentialId) bad("credential_id_mismatch");
  return { credentialId, spki, alg, counter: ad.counter, aaguid: authDataRaw.subarray(37, 53).toString("hex") };
}

// ---------------------------------------------------------------------------------------------
// Assertion
// ---------------------------------------------------------------------------------------------

export interface AssertionInput { id: string; rawId?: string; type?: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null } }
export interface StoredCredential { id: string; spki: string; alg: CoseAlg; counter: number }

/** Verifies the assertion against the stored credential and the exact challenge. Returns the new counter. Throws WebAuthnError. */
export function verifyAssertion(input: AssertionInput, cred: StoredCredential, expectedChallenge: string, o: { requireUv?: boolean; config?: WebAuthnConfig } = {}): { counter: number } {
  const cfg = o.config ?? webauthnConfig();
  if (!input || typeof input !== "object" || !input.response) return bad("malformed");
  if (input.type !== undefined && input.type !== "public-key") bad("malformed");
  if (input.id !== cred.id) bad("credential_mismatch");
  let cdj: Buffer, adRaw: Buffer, sig: Buffer;
  try { cdj = fromB64u(input.response.clientDataJSON); adRaw = fromB64u(input.response.authenticatorData); sig = fromB64u(input.response.signature); } catch { return bad("malformed"); }
  parseClientData(cdj, "webauthn.get", expectedChallenge, cfg);
  const ad = parseAuthData(adRaw, cfg, { requireUv: o.requireUv ?? true, attested: false });
  const signed = Buffer.concat([adRaw, sha256(cdj)]);
  let ok: boolean;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(cred.spki, "base64"), format: "der", type: "spki" });
    ok = cred.alg === -8 ? crypto.verify(null, signed, pub, sig) : crypto.verify("sha256", signed, pub, sig); // ES256 signatures are DER-encoded
  } catch { ok = false; }
  if (!ok) bad("signature_invalid");
  if ((ad.counter !== 0 || cred.counter !== 0) && ad.counter <= cred.counter) bad("counter_regressed");
  return { counter: ad.counter };
}

/** The WebAuthn challenge bound to one message hash and purpose (the authenticator's signature therefore covers the message hash). */
export function assertionChallenge(purpose: string, messageId: string, msgHash: string, nonce: string): string {
  return b64u(sha256(`notify-assert|${purpose}|${messageId}|${msgHash}|${nonce}`));
}
