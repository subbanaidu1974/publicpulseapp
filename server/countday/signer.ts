/**
 * Count-day signer backed by the civic KeyProvider (purpose "countday-signing").
 * KeyProvider exposes only symmetric operations, so an Ed25519 key pair is derived from hmac(countday-signing, seed label): same provider key,
 * same pair; rotating the purpose changes the key id, and old public keys stay in keys.json so old snapshots still verify.
 * LIMITATION (documented in docs/COUNT_DAY.md): whoever can call hmac() on this purpose can derive the private key. A production HSM should
 * implement the Signer interface directly (non-exportable Ed25519 key) and be passed to ingestOnce().
 */
import crypto from "node:crypto";
import { getKeys } from "../civic/core";
import type { KeyProvider } from "../civic/core";
import { sha256Hex } from "../../pipeline/countday/canonical";
import type { Signer } from "../../pipeline/countday/types";

export const COUNTDAY_PURPOSE = "countday-signing";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function signerFromKeys(keys: KeyProvider = getKeys()): Signer {
  const seed = Buffer.from(keys.hmac(COUNTDAY_PURPOSE, "ed25519-seed:v1"), "hex");
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const x = String(crypto.createPublicKey(priv).export({ format: "jwk" }).x);
  return { keyId: "cd-" + sha256Hex(Buffer.from(x, "base64url")).slice(0, 16), publicKey: x, sign: (d) => crypto.sign(null, d, priv).toString("base64url") };
}
