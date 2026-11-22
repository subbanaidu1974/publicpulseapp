/**
 * S-30 (@E2E-39) RSA blind signature primitives: interoperability between the server (node:crypto + BigInt) and the browser client
 * (src/lib/blind.ts, WebCrypto + BigInt), fixed test vectors, forgery and tamper rejection.
 */
import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { blindSign, generateKey, keyFromJwk, publicJwk, referenceBlind, referenceFinalize, spentKey, verifyCredential, bigToBytes, bytesToBig, type PrivateKey } from "../../../server/civic/surveys/blind";
import * as client from "../../../src/lib/blind";
import vectors from "./blind.vectors.json";

let sk: PrivateKey;
beforeAll(async () => { sk = await generateKey(2048); }, 60_000);

describe("blind signatures", () => {
  it("@E2E-39 a credential produced by the browser client verifies on the server, and the server's signature verifies in the client", async () => {
    const ck = client.keyFromJwk(publicJwk(sk));
    const st = await client.blind(ck);
    const blindSig = blindSign(sk, Buffer.from(st.blinded)).toString("base64url");
    const sig = await client.finalize(ck, st, blindSig); // throws when the unblinded signature does not verify
    expect(verifyCredential(sk, st.prefix, st.token, client.fromB64(sig))).toBe(true);
  });

  it("@E2E-39 the server's reference client and the browser client are interchangeable", async () => {
    const st = referenceBlind(sk);
    const sig = referenceFinalize(sk, blindSign(sk, st.blinded), st.inv);
    expect(verifyCredential(sk, st.prefix, st.token, sig)).toBe(true);
    // browser finalize accepts a blinding made by the server-side reference client? (different inv type is the same bigint)
    const ck = client.keyFromJwk(publicJwk(sk));
    expect(await client.finalize(ck, { ...st, prefixB64: "", tokenB64: "", blindedB64: "" } as unknown as client.BlindState, blindSign(sk, st.blinded).toString("base64url"))).toBeTypeOf("string");
  });

  it("@E2E-39 the blinded value reveals nothing the server can match to the final token (distinct r per request, same message)", () => {
    const base = { prefix: Buffer.alloc(32, 1), token: Buffer.alloc(32, 2), salt: Buffer.alloc(48, 3) };
    const a = referenceBlind(sk, base), b = referenceBlind(sk, base);
    expect(a.blinded.equals(b.blinded)).toBe(false);
    expect(referenceFinalize(sk, blindSign(sk, a.blinded), a.inv).equals(referenceFinalize(sk, blindSign(sk, b.blinded), b.inv))).toBe(true); // same unblinded signature
  });

  it("@E2E-39 forged, altered and out-of-range inputs are rejected", () => {
    const st = referenceBlind(sk);
    const sig = referenceFinalize(sk, blindSign(sk, st.blinded), st.inv);
    const flip = Buffer.from(sig); flip[10] ^= 1;
    expect(verifyCredential(sk, st.prefix, st.token, flip)).toBe(false);
    expect(verifyCredential(sk, st.prefix, crypto.randomBytes(32), sig)).toBe(false);
    expect(verifyCredential(sk, crypto.randomBytes(32), st.token, sig)).toBe(false);
    expect(verifyCredential(sk, st.prefix, st.token, crypto.randomBytes(256))).toBe(false);
    expect(verifyCredential(sk, st.prefix, st.token, Buffer.alloc(10))).toBe(false);
    expect(() => blindSign(sk, Buffer.alloc(256))).toThrow();
    expect(() => blindSign(sk, bigToBytes(sk.n + 1n, 256))).toThrow();
    expect(() => blindSign(sk, Buffer.alloc(10, 1))).toThrow();
    // a signature of another key
    return generateKey(2048).then((other) => { expect(verifyCredential(other, st.prefix, st.token, sig)).toBe(false); });
  }, 60_000);

  it("@E2E-39 keys below 2048 bits are refused", async () => {
    await expect(generateKey(1024)).rejects.toThrow(/2048/);
  });

  it("@E2E-39 shared test vectors (fixed key, prefix, token, salt, r): blinded message, blind signature and credential are byte-exact on both implementations", async () => {
    const key = keyFromJwk(vectors.publicJwk);
    const priv: PrivateKey = { ...key, d: bytesToBig(Buffer.from(vectors.d, "base64url")) };
    for (const v of vectors.cases) {
      const o = { prefix: Buffer.from(v.prefix, "hex"), token: Buffer.from(v.token, "hex"), salt: Buffer.from(v.salt, "hex"), r: BigInt("0x" + v.r) };
      const s = referenceBlind(key, o);
      expect(s.blinded.toString("base64url")).toBe(v.blinded);
      const c = await client.blind(client.keyFromJwk(vectors.publicJwk), { prefix: new Uint8Array(o.prefix), token: new Uint8Array(o.token), salt: new Uint8Array(o.salt), r: o.r });
      expect(c.blindedB64).toBe(v.blinded);
      // The RSA private operation is deterministic: the blind signature is fixed (our re-blinding does not change the result).
      const bs = blindSign(priv, s.blinded);
      expect(bs.toString("base64url")).toBe(v.blindSignature);
      const sig = referenceFinalize(key, bs, s.inv);
      expect(sig.toString("base64url")).toBe(v.signature);
      expect(await client.finalize(client.keyFromJwk(vectors.publicJwk), c, v.blindSignature)).toBe(v.signature);
      expect(verifyCredential(key, s.prefix, s.token, sig)).toBe(true);
      expect(spentKey(s.prefix, s.token)).toBe(v.spentKey);
    }
  });
});
