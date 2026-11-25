import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as client from "../../../src/lib/blind";
import { describe, expect, it } from "vitest";
import { blindSign, bytesToBig, emsaPssEncode, modInv, modPow, referenceBlind, referenceFinalize, type PrivateKey } from "../../../server/civic/surveys/blind";

/**
 * Official RFC 9474 Appendix A.1 test vector (RSABSSA-SHA384-PSS-Randomized), copied byte for byte from the RFC text into rfc9474.vector.json.
 * This is a third-party vector: it checks the EMSA-PSS encoder, blinding, blind signing and finalisation against the published values.
 * The survey credential uses a 32-byte token, the RFC message is 48 bytes, so the checks below go through the length-agnostic primitives
 * (emsaPssEncode, referenceBlind, blindSign, referenceFinalize) and OpenSSL for the final verification.
 */
const v = JSON.parse(readFileSync(resolve(__dirname, "rfc9474.vector.json"), "utf8")) as Record<string, string>;
const hex = (s: string) => Buffer.from(s, "hex");
const n = BigInt("0x" + v.n), e = BigInt("0x" + v.e), d = BigInt("0x" + v.d);
const bits = n.toString(2).length;
const sk: PrivateKey = { n, e, d, bits };

describe("@E2E-39 RFC 9474 Appendix A.1 official vector (RSABSSA-SHA384-PSS-Randomized)", () => {
  it("prepared message is prefix || msg", () => {
    expect(Buffer.concat([hex(v.msg_prefix), hex(v.msg)]).toString("hex")).toBe(v.prepared_msg);
  });
  it("EMSA-PSS encoding matches encoded_msg", () => {
    expect(emsaPssEncode(hex(v.prepared_msg), bits - 1, hex(v.salt)).toString("hex")).toBe(v.encoded_msg);
  });
  it("blinding with the vector's inverse gives blinded_msg", () => {
    const r = modInv(bytesToBig(hex(v.inv)), n);
    const st = referenceBlind({ n, e, bits }, { prefix: hex(v.msg_prefix), token: hex(v.msg), salt: hex(v.salt), r });
    expect(st.blinded.toString("hex")).toBe(v.blinded_msg);
    expect(st.inv).toBe(bytesToBig(hex(v.inv)));
  });
  it("blind signature, finalised signature and OpenSSL verification match the vector", () => {
    expect(blindSign(sk, hex(v.blinded_msg)).toString("hex")).toBe(v.blind_sig);
    const sig = referenceFinalize({ n, e, bits }, hex(v.blind_sig), bytesToBig(hex(v.inv)));
    expect(sig.toString("hex")).toBe(v.sig);
    expect(modPow(bytesToBig(sig), e, n)).toBe(bytesToBig(hex(v.encoded_msg)));
    const key = crypto.createPublicKey({ key: { kty: "RSA", n: Buffer.from(v.n, "hex").toString("base64url"), e: Buffer.from(v.e, "hex").toString("base64url") }, format: "jwk" });
    expect(crypto.verify("sha384", hex(v.prepared_msg), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, sig)).toBe(true);
  });
  it("the browser client (src/lib/blind.ts) reproduces the same encoding, blinded message and signature", async () => {
    expect(Buffer.from(await client.emsaPssEncode(hex(v.prepared_msg), bits - 1, hex(v.salt))).toString("hex")).toBe(v.encoded_msg);
    const key = client.keyFromJwk({ n: Buffer.from(v.n, "hex").toString("base64url"), e: Buffer.from(v.e, "hex").toString("base64url") });
    const r = modInv(bytesToBig(hex(v.inv)), n);
    const st = await client.blind(key, { prefix: hex(v.msg_prefix), token: hex(v.msg), salt: hex(v.salt), r });
    expect(Buffer.from(st.blinded).toString("hex")).toBe(v.blinded_msg);
    const sigB64 = await client.finalize(key, st, Buffer.from(v.blind_sig, "hex").toString("base64url"));
    expect(Buffer.from(sigB64, "base64url").toString("hex")).toBe(v.sig);
  });
});
