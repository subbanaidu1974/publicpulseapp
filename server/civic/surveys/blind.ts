/**
 * RSA blind signatures for the anonymous survey credential (S-30). RFC 9474 RSABSSA-SHA384-PSS-Randomized, implemented here with
 * node:crypto + BigInt (no new dependency; no vetted pure-JS RFC 9474 library is in node_modules).
 *
 *   >>> NEEDS INDEPENDENT CRYPTOGRAPHIC REVIEW before the credential is relied on for anything beyond a pilot. <<<
 *   Specifically: the BigInt modular exponentiation is NOT constant time (we add server-side re-blinding, which reduces but does not
 *   remove the timing risk), the PSS encoding is hand-written (verification, however, is done by node's OpenSSL RSASSA-PSS), and the
 *   protocol composition (key classes, spent-token table, shuffled batches) is our own design, described in docs/SURVEYS.md.
 *
 * Roles
 *   client  (src/lib/blind.ts, WebCrypto + BigInt): prepare a random 32-byte token and 32-byte prefix, EMSA-PSS-encode prefix||token
 *           with SHA-384 / MGF1-SHA384 / 48-byte salt, blind with r^e, later unblind with r^-1.
 *   server  (this file): blindSign(sk, blinded) = blinded^d mod n, with a random re-blinding so that the private exponent is never
 *           applied to a value the caller chose; verify(pk, prefix||token, signature) with node's native RSA-PSS verifier.
 * Key sizes: RSA-2048 minimum (CIVIC_SURVEY_KEY_BITS may raise it to 3072/4096; never lower).
 */
import crypto from "node:crypto";

export const BLIND_ALG = "RSABSSA-SHA384-PSS-Randomized";
export const SALT_LEN = 48;
export const HASH_LEN = 48;
export const TOKEN_LEN = 32;
export const PREFIX_LEN = 32;

export const bytesToBig = (b: Uint8Array): bigint => (b.length ? BigInt("0x" + Buffer.from(b).toString("hex")) : 0n);
export function bigToBytes(x: bigint, len: number): Buffer {
  const h = x.toString(16);
  const b = Buffer.from(h.length % 2 ? "0" + h : h, "hex");
  if (b.length > len) throw new Error("integer too large");
  return Buffer.concat([Buffer.alloc(len - b.length), b]);
}
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n, b = ((base % mod) + mod) % mod, e = exp;
  while (e > 0n) { if (e & 1n) r = (r * b) % mod; e >>= 1n; b = (b * b) % mod; }
  return r;
}
export function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [m, ((a % m) + m) % m, 0n, 1n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  if (r0 !== 1n) throw new Error("not invertible");
  return ((s0 % m) + m) % m;
}
export const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };

export interface PublicKey { n: bigint; e: bigint; bits: number }
export interface PrivateKey extends PublicKey { d: bigint }
export const keyBytes = (k: PublicKey): number => Math.ceil(k.bits / 8);

export const minBits = (): number => Math.max(2048, Number(process.env.CIVIC_SURVEY_KEY_BITS) || 2048);

/** Generate an RSA key pair (async: key generation must not block the event loop). */
export function generateKey(bits: number = minBits()): Promise<PrivateKey> {
  if (bits < 2048) return Promise.reject(new Error("RSA keys below 2048 bits are refused"));
  return new Promise((resolve, reject) => crypto.generateKeyPair("rsa", { modulusLength: bits, publicExponent: 65537 }, (err, _pub, priv) => {
    if (err) return reject(err);
    const j = priv.export({ format: "jwk" }) as { n: string; e: string; d: string };
    const f = (s: string) => bytesToBig(Buffer.from(s, "base64url"));
    resolve({ n: f(j.n), e: f(j.e), d: f(j.d), bits });
  }));
}

export const publicOf = (k: PublicKey): PublicKey => ({ n: k.n, e: k.e, bits: k.bits });
export const publicJwk = (k: PublicKey): { kty: "RSA"; n: string; e: string; alg: string; ext: true } =>
  ({ kty: "RSA", n: bigToBytes(k.n, keyBytes(k)).toString("base64url"), e: bigToBytes(k.e, 3).toString("base64url"), alg: "PS384", ext: true });
export const keyFromJwk = (j: { n: string; e: string }): PublicKey => {
  const n = bytesToBig(Buffer.from(j.n, "base64url"));
  return { n, e: bytesToBig(Buffer.from(j.e, "base64url")), bits: n.toString(2).length };
};

/**
 * RSA private operation on an already-encoded integer. Re-blinded: (m * r^e)^d * r^-1 = m^d, with a fresh random r, so the caller never
 * controls the value exponentiated by d (a defence against timing probes of the private exponent). Checks the result with the public key.
 */
export function blindSign(sk: PrivateKey, blinded: Uint8Array): Buffer {
  const k = keyBytes(sk);
  if (blinded.length !== k) throw new Error("blinded message has the wrong length");
  const m = bytesToBig(blinded);
  if (m >= sk.n || m === 0n) throw new Error("blinded message out of range");
  let r: bigint;
  do { r = bytesToBig(crypto.randomBytes(k)) % sk.n; } while (r < 2n || gcd(r, sk.n) !== 1n);
  const s = (modPow((m * modPow(r, sk.e, sk.n)) % sk.n, sk.d, sk.n) * modInv(r, sk.n)) % sk.n;
  if (modPow(s, sk.e, sk.n) !== m) throw new Error("signing fault"); // fault / bug check: never release a bad signature
  return bigToBytes(s, k);
}

/** Verify a finalized credential: RSASSA-PSS(SHA-384, MGF1-SHA384, 48-byte salt) over prefix||token, using node's OpenSSL verifier. */
export function verifyCredential(pk: PublicKey, prefix: Uint8Array, token: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (prefix.length !== PREFIX_LEN || token.length !== TOKEN_LEN || signature.length !== keyBytes(pk)) return false;
    const key = crypto.createPublicKey({ key: publicJwk(pk) as unknown as crypto.JsonWebKey, format: "jwk" });
    return crypto.verify("sha384", Buffer.concat([prefix, token]), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: SALT_LEN }, signature);
  } catch { return false; }
}

/** The spent-token key: sha256 over prefix||token (hex). */
export const spentKey = (prefix: Uint8Array, token: Uint8Array): string => crypto.createHash("sha256").update(prefix).update(token).digest("hex");

// ---- reference client for server tests and vectors (the real client is src/lib/blind.ts) ----
export interface BlindState { prefix: Buffer; token: Buffer; blinded: Buffer; inv: bigint }
function mgf1(seed: Buffer, len: number): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i * HASH_LEN < len; i++) out.push(crypto.createHash("sha384").update(seed).update(Buffer.from([0, 0, 0, i])).digest());
  return Buffer.concat(out).subarray(0, len);
}
export function emsaPssEncode(msg: Buffer, emBits: number, salt: Buffer): Buffer {
  const emLen = Math.ceil(emBits / 8);
  const mHash = crypto.createHash("sha384").update(msg).digest();
  const h = crypto.createHash("sha384").update(Buffer.concat([Buffer.alloc(8), mHash, salt])).digest();
  const db = Buffer.concat([Buffer.alloc(emLen - SALT_LEN - HASH_LEN - 2), Buffer.from([1]), salt]);
  const mask = mgf1(h, emLen - HASH_LEN - 1);
  const masked = Buffer.from(db.map((b, i) => b ^ mask[i]));
  masked[0] &= 0xff >> (8 * emLen - emBits);
  return Buffer.concat([masked, h, Buffer.from([0xbc])]);
}
export function referenceBlind(pk: PublicKey, o: { prefix?: Buffer; token?: Buffer; salt?: Buffer; r?: bigint } = {}): BlindState {
  const prefix = o.prefix ?? crypto.randomBytes(PREFIX_LEN), token = o.token ?? crypto.randomBytes(TOKEN_LEN), salt = o.salt ?? crypto.randomBytes(SALT_LEN);
  const k = keyBytes(pk);
  const em = emsaPssEncode(Buffer.concat([prefix, token]), pk.bits - 1, salt);
  const m = bytesToBig(em);
  let r = o.r ?? 0n;
  if (!r) do { r = bytesToBig(crypto.randomBytes(k)) % pk.n; } while (r < 2n || gcd(r, pk.n) !== 1n);
  return { prefix, token, blinded: bigToBytes((m * modPow(r, pk.e, pk.n)) % pk.n, k), inv: modInv(r, pk.n) };
}
export const referenceFinalize = (pk: PublicKey, blindSig: Uint8Array, inv: bigint): Buffer => bigToBytes((bytesToBig(blindSig) * inv) % pk.n, keyBytes(pk));
