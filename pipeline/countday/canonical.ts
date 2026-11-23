import crypto from "node:crypto";

/** Canonical JSON: object keys sorted, no whitespace. The bytes that are hashed and signed. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
export const sha256Hex = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export function verifyEd25519(xB64url: string, data: Buffer, sigB64url: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(xB64url, "base64url")]), format: "der", type: "spki" });
    return crypto.verify(null, data, key, Buffer.from(sigB64url, "base64url"));
  } catch { return false; }
}
