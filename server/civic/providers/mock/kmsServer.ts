/**
 * Reference mock KMS for the NEUTRAL wrap/unwrap/hmac shape (server/civic/providers/keys.ts). Tests / local development only.
 * KEKs live in this process (generated per key_id); a real KMS/HSM never lets them out. Unwrap binds the AAD.
 */
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { verifySignature } from "../util";

export type MockKmsMode = "ok" | "error500" | "timeout" | "garbage";
export interface MockKmsServer {
  url: string; secret: string; mode: MockKmsMode;
  calls: { wrap: number; unwrap: number; hmac: number }; unauthorised: number;
  /** Every request body, so tests can assert no clear data key is ever sent to /unwrap or logged. */
  bodies: string[];
  close(): Promise<void>;
}

export async function startMockKmsServer(secret = "mock-kms-secret"): Promise<MockKmsServer> {
  const keks = new Map<string, Buffer>();
  const kek = (id: string) => { let k = keks.get(id); if (!k) { k = crypto.randomBytes(32); keks.set(id, k); } return k; };
  const hanging = new Set<http.ServerResponse>();
  const s: MockKmsServer = {
    url: "", secret, mode: "ok", calls: { wrap: 0, unwrap: 0, hmac: 0 }, unauthorised: 0, bodies: [],
    close: () => new Promise<void>((resolve) => { for (const r of hanging) r.destroy(); srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      s.bodies.push(raw);
      if (!verifySignature(secret, req.headers["x-civic-timestamp"] as string, req.headers["x-civic-signature"] as string, raw)) { s.unauthorised++; res.writeHead(401).end("{}"); return; }
      if (s.mode === "timeout") { hanging.add(res); return; }
      if (s.mode === "error500") { res.writeHead(500).end("{}"); return; }
      if (s.mode === "garbage") { res.writeHead(200).end("???"); return; }
      const reply = (o: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
      try {
        const b = JSON.parse(raw) as Record<string, string>;
        if (req.url === "/v1/wrap") {
          s.calls.wrap++;
          const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", kek(b.key_id), iv);
          c.setAAD(Buffer.from(b.aad));
          const ct = Buffer.concat([c.update(Buffer.from(b.plaintext_b64, "base64")), c.final()]);
          return reply({ ciphertext: `mk1.${Buffer.from(b.key_id).toString("base64url")}.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}` });
        }
        if (req.url === "/v1/unwrap") {
          s.calls.unwrap++;
          const m = /^mk1\.([^.]+)\.(.+)$/.exec(b.ciphertext);
          if (!m) return reply({ error: "bad_ciphertext" }, 400);
          const raw2 = Buffer.from(m[2], "base64url");
          const d = crypto.createDecipheriv("aes-256-gcm", kek(Buffer.from(m[1], "base64url").toString()), raw2.subarray(0, 12));
          d.setAAD(Buffer.from(b.aad)); d.setAuthTag(raw2.subarray(12, 28));
          return reply({ plaintext_b64: Buffer.concat([d.update(raw2.subarray(28)), d.final()]).toString("base64") });
        }
        if (req.url === "/v1/hmac") {
          s.calls.hmac++;
          return reply({ mac_hex: crypto.createHmac("sha256", kek(b.key_id)).update(Buffer.from(b.data_b64, "base64")).digest("hex") });
        }
        return reply({ error: "not_found" }, 404);
      } catch { return reply({ error: "bad_request" }, 400); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return s;
}
