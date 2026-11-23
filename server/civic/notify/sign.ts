/**
 * Payload signing (DESIGN_2028 3.8 item 4). The platform notification key is the civic KeyProvider purpose "notify-signing".
 * The provider only exposes hmac/encrypt, so an Ed25519 key pair is DERIVED: seed = SHA-256(provider.hmac("notify-signing", "ed25519-seed:v1")).
 * Clients verify against the PUBLIC key published at GET /notify/keys (key id + version). Honest limit: the private key exists in process
 * memory while signing (with the envelope provider it is derived from the KMS-unwrapped data key). Signing INSIDE an HSM needs a `sign`
 * operation in a KMS adapter; that is not built (docs/NOTIFICATIONS.md).
 */
import crypto from "node:crypto";
import { canonicalJson, getKeys } from "../core";
import { isKeyProviderV2 } from "../providers/keys";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PURPOSE = "notify-signing";

function seed(version: number | null): Buffer {
  const k = getKeys();
  const mac = isKeyProviderV2(k) && version !== null ? k.hmacVersioned(PURPOSE, "ed25519-seed:v1", version) : k.hmac(PURPOSE, "ed25519-seed:v1");
  return crypto.createHash("sha256").update(mac).digest();
}
export interface NotifyKey { key_id: string; version: number; alg: "Ed25519"; public_key: string; spki: string }
function keyFor(version: number | null): { priv: crypto.KeyObject; info: NotifyKey } {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed(version)]), format: "der", type: "pkcs8" });
  const spki = crypto.createPublicKey(priv).export({ type: "spki", format: "der" }) as Buffer;
  return { priv, info: { key_id: crypto.createHash("sha256").update(spki).digest("hex").slice(0, 16), version: version ?? 1, alg: "Ed25519", public_key: spki.subarray(spki.length - 32).toString("base64url"), spki: spki.toString("base64") } };
}
function currentVersion(): number | null { const k = getKeys(); return isKeyProviderV2(k) ? k.keyInfo(PURPOSE).version : null; }

/** All public keys a client may need (current first); old versions stay listed so earlier messages still verify. */
export function publishedKeys(): NotifyKey[] {
  const k = getKeys();
  if (!isKeyProviderV2(k)) return [keyFor(null).info];
  const cur = k.keyInfo(PURPOSE).version;
  return [cur, ...k.activeVersions(PURPOSE).filter((v) => v !== cur)].map((v) => keyFor(v).info);
}
export function signPayload(payload: Record<string, unknown>): { signature: string; key_id: string; key_version: number; canonical: string } {
  const { priv, info } = keyFor(currentVersion());
  const canonical = canonicalJson({ ...payload, key_id: info.key_id });
  return { signature: crypto.sign(null, Buffer.from(canonical), priv).toString("base64url"), key_id: info.key_id, key_version: info.version, canonical };
}
/** What a client does: verify the canonical bytes with the pinned public key (base64url, raw 32 bytes). */
export function verifySignature(canonical: string, signature: string, publicKeyB64u: string): boolean {
  try {
    const spki = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyB64u, "base64url")]);
    return crypto.verify(null, Buffer.from(canonical), crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(signature, "base64url"));
  } catch { return false; }
}
