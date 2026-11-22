/**
 * Client side of the anonymous survey credential (S-30): RFC 9474 RSABSSA-SHA384-PSS-Randomized with BigInt + WebCrypto SHA-384.
 * The same math as server/civic/surveys/blind.ts, written independently, so a test can prove each side accepts the other's output.
 *
 *   NEEDS INDEPENDENT CRYPTOGRAPHIC REVIEW (hand-written PSS encoding and BigInt arithmetic; BigInt is not constant time, which matters
 *   little here because the secret values are random and used once, but is noted for the reviewer).
 *
 * Flow:  const k = keyFromJwk(await fetchKey());  const st = await blind(k);
 *        POST /credential/request { blinded: st.blindedB64, nonce }  ->  { blind_signature }
 *        const sig = await finalize(k, st, blindSignatureB64);
 *        POST /respond { token: st.tokenB64, prefix: st.prefixB64, signature: sig, answers, strata }   (no cookies, no Authorization header)
 * Keep `st` in memory only (never localStorage/analytics): it is the secret that links nothing to the person, but it is the voting right.
 */
const SALT_LEN = 48, HASH_LEN = 48, TOKEN_LEN = 32, PREFIX_LEN = 32;

export interface PublicJwk { n: string; e: string }
export interface BlindKey { n: bigint; e: bigint; bits: number; jwk: PublicJwk }
export interface BlindState { prefix: Uint8Array; token: Uint8Array; blinded: Uint8Array; inv: bigint; blindedB64: string; tokenB64: string; prefixB64: string }

const b64u = (b: Uint8Array): string => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s: string): Uint8Array => { const t = atob(s.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };
export const toB64 = b64u;
export const fromB64 = unb64u;

const bytesToBig = (b: Uint8Array): bigint => { let h = ""; for (const x of b) h += x.toString(16).padStart(2, "0"); return h ? BigInt("0x" + h) : 0n; };
function bigToBytes(x: bigint, len: number): Uint8Array {
  let h = x.toString(16); if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(len);
  const raw = h.match(/../g)?.map((p) => parseInt(p, 16)) ?? [];
  if (raw.length > len) throw new Error("integer too large");
  out.set(raw, len - raw.length);
  return out;
}
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n, b = ((base % mod) + mod) % mod, e = exp;
  while (e > 0n) { if (e & 1n) r = (r * b) % mod; e >>= 1n; b = (b * b) % mod; }
  return r;
}
function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [m, ((a % m) + m) % m, 0n, 1n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  if (r0 !== 1n) throw new Error("not invertible");
  return ((s0 % m) + m) % m;
}
const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
const rand = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (...p: Uint8Array[]): Uint8Array => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha384 = async (d: Uint8Array): Promise<Uint8Array> => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-384", d as BufferSource));

async function mgf1(seed: Uint8Array, len: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i * HASH_LEN < len; i++) parts.push(await sha384(concat(seed, new Uint8Array([0, 0, 0, i]))));
  return concat(...parts).subarray(0, len);
}
/** EMSA-PSS-ENCODE (RFC 8017 9.1.1) with SHA-384, MGF1-SHA384 and a 48-byte salt. */
export async function emsaPssEncode(msg: Uint8Array, emBits: number, salt: Uint8Array): Promise<Uint8Array> {
  const emLen = Math.ceil(emBits / 8);
  const mHash = await sha384(msg);
  const h = await sha384(concat(new Uint8Array(8), mHash, salt));
  const db = concat(new Uint8Array(emLen - SALT_LEN - HASH_LEN - 2), new Uint8Array([1]), salt);
  const mask = await mgf1(h, emLen - HASH_LEN - 1);
  const masked = db.map((b, i) => b ^ mask[i]);
  masked[0] &= 0xff >> (8 * emLen - emBits);
  return concat(masked, h, new Uint8Array([0xbc]));
}

export function keyFromJwk(j: PublicJwk): BlindKey {
  const n = bytesToBig(unb64u(j.n));
  return { n, e: bytesToBig(unb64u(j.e)), bits: n.toString(2).length, jwk: { n: j.n, e: j.e } };
}
export const keyBytes = (k: BlindKey): number => Math.ceil(k.bits / 8);

/** Step 1: choose a random token + prefix, encode, blind. `fixed` exists only for test vectors. */
export async function blind(k: BlindKey, fixed: { prefix?: Uint8Array; token?: Uint8Array; salt?: Uint8Array; r?: bigint } = {}): Promise<BlindState> {
  const prefix = fixed.prefix ?? rand(PREFIX_LEN), token = fixed.token ?? rand(TOKEN_LEN), salt = fixed.salt ?? rand(SALT_LEN);
  const len = keyBytes(k);
  const m = bytesToBig(await emsaPssEncode(concat(prefix, token), k.bits - 1, salt));
  let r = fixed.r ?? 0n;
  if (!r) do { r = bytesToBig(rand(len)) % k.n; } while (r < 2n || gcd(r, k.n) !== 1n);
  const blinded = bigToBytes((m * modPow(r, k.e, k.n)) % k.n, len);
  return { prefix, token, blinded, inv: modInv(r, k.n), blindedB64: b64u(blinded), tokenB64: b64u(token), prefixB64: b64u(prefix) };
}

/** Step 2 (after the server signed): unblind and verify the result is a valid RSA-PSS signature on prefix||token. Throws if not. */
export async function finalize(k: BlindKey, st: BlindState, blindSignatureB64: string): Promise<string> {
  const len = keyBytes(k);
  const bs = unb64u(blindSignatureB64);
  if (bs.length !== len) throw new Error("bad blind signature length");
  const sig = bigToBytes((bytesToBig(bs) * st.inv) % k.n, len);
  const key = await globalThis.crypto.subtle.importKey("jwk", { kty: "RSA", n: k.jwk.n, e: k.jwk.e, alg: "PS384", ext: true }, { name: "RSA-PSS", hash: "SHA-384" }, false, ["verify"]);
  const ok = await globalThis.crypto.subtle.verify({ name: "RSA-PSS", saltLength: SALT_LEN }, key, sig as BufferSource, concat(st.prefix, st.token) as BufferSource);
  if (!ok) throw new Error("the server's blind signature did not verify");
  return b64u(sig);
}
