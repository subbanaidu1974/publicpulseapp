/**
 * Local simulator of the AWS KMS JSON API (TrentService.Encrypt / Decrypt / GenerateDataKey) for tests and local development only.
 * Written from the public API + SigV4 documentation, and it verifies SigV4 independently of the adapter's signer (recomputes the signature
 * from the received request). It mimics: x-amz-target routing, application/x-amz-json-1.1, base64 blobs, EncryptionContext binding,
 * {"__type": "..."} error bodies, ThrottlingException, AccessDeniedException, DisabledException, NotFoundException, InvalidCiphertextException.
 * It is NOT AWS: real latency, quotas, key policies, grants and multi-region behaviour are not simulated.
 */
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

export type AwsKmsMode = "ok" | "error500" | "timeout" | "garbage" | "throttle" | "accessDenied";
export interface AwsKmsSim {
  url: string; region: string; accessKeyId: string; secretAccessKey: string; mode: AwsKmsMode;
  calls: { Encrypt: number; Decrypt: number; GenerateDataKey: number }; badSignatures: number;
  /** Key ids that answer DisabledException. */
  disabled: Set<string>;
  bodies: string[]; lastHeaders: Record<string, string | string[] | undefined>;
  close(): Promise<void>;
}

const h256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const mac = (k: string | Buffer, s: string) => crypto.createHmac("sha256", k).update(s).digest();

function verifySigV4(req: http.IncomingMessage, body: string, o: { region: string; ak: string; sk: string }): boolean {
  const auth = String(req.headers.authorization ?? "");
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  const [, ak, day, region, service, signed, sig] = m;
  if (ak !== o.ak || region !== o.region || service !== "kms") return false;
  const amz = String(req.headers["x-amz-date"] ?? "");
  if (!/^\d{8}T\d{6}Z$/.test(amz) || amz.slice(0, 8) !== day) return false;
  const t = Date.parse(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 15 * 60_000) return false;
  const names = signed.split(";");
  if (!["host", "x-amz-date", "x-amz-target", "content-type"].every((n) => names.includes(n))) return false;
  const canonical = ["POST", req.url!.split("?")[0] || "/", "", names.map((n) => `${n}:${String(req.headers[n] ?? "").trim().replace(/\s+/g, " ")}\n`).join(""), signed, h256(body)].join("\n");
  const sts = ["AWS4-HMAC-SHA256", amz, `${day}/${region}/${service}/aws4_request`, h256(canonical)].join("\n");
  const key = mac(mac(mac(mac("AWS4" + o.sk, day), region), service), "aws4_request");
  const want = crypto.createHmac("sha256", key).update(sts).digest();
  return crypto.timingSafeEqual(want, Buffer.from(sig, "hex"));
}

export async function startAwsKmsSim(region = "ap-south-1"): Promise<AwsKmsSim> {
  const keks = new Map<string, Buffer>();
  const kek = (id: string) => { let k = keks.get(id); if (!k) { k = crypto.randomBytes(32); keks.set(id, k); } return k; };
  const hanging = new Set<http.ServerResponse>();
  const s: AwsKmsSim = {
    url: "", region, accessKeyId: "AKIASIMULATEDKEY0001", secretAccessKey: "simulated/secret+access/key0123456789ABCDEFGH", mode: "ok",
    calls: { Encrypt: 0, Decrypt: 0, GenerateDataKey: 0 }, badSignatures: 0, disabled: new Set(), bodies: [], lastHeaders: {},
    close: () => new Promise<void>((resolve) => { for (const r of hanging) r.destroy(); srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
  const err = (res: http.ServerResponse, code: number, type: string, message = type) =>
    res.writeHead(code, { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": type, "x-amzn-requestid": crypto.randomUUID() }).end(JSON.stringify({ __type: type, message }));
  const ctxAad = (c: unknown) => Buffer.from(JSON.stringify(Object.entries((c ?? {}) as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : 1))));
  const seal = (keyId: string, pt: Buffer, ctx: unknown) => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", kek(keyId), iv);
    c.setAAD(ctxAad(ctx));
    const ct = Buffer.concat([c.update(pt), c.final()]);
    const id = Buffer.from(keyId);
    return Buffer.concat([Buffer.from([id.length]), id, iv, c.getAuthTag(), ct]).toString("base64");
  };

  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      s.bodies.push(raw); s.lastHeaders = req.headers;
      if (!verifySigV4(req, raw, { region: s.region, ak: s.accessKeyId, sk: s.secretAccessKey })) { s.badSignatures++; return err(res, 400, "InvalidSignatureException", "The request signature we calculated does not match the signature you provided."); }
      if (s.mode === "timeout") { hanging.add(res); return; }
      if (s.mode === "error500") return err(res, 500, "KMSInternalException");
      if (s.mode === "throttle") return err(res, 400, "ThrottlingException", "Rate exceeded");
      if (s.mode === "accessDenied") return err(res, 400, "AccessDeniedException", "User is not authorized to perform kms:Encrypt");
      if (s.mode === "garbage") { res.writeHead(200).end("???"); return; }
      if (req.headers["content-type"] !== "application/x-amz-json-1.1") return err(res, 400, "SerializationException");
      const target = String(req.headers["x-amz-target"] ?? "").replace(/^TrentService\./, "") as keyof AwsKmsSim["calls"];
      if (!(target in s.calls)) return err(res, 400, "UnknownOperationException");
      let b: Record<string, unknown>;
      try { b = JSON.parse(raw) as Record<string, unknown>; } catch { return err(res, 400, "SerializationException"); }
      s.calls[target]++;
      const reply = (o: unknown) => res.writeHead(200, { "content-type": "application/x-amz-json-1.1", "x-amzn-requestid": crypto.randomUUID() }).end(JSON.stringify(o));
      if (target === "Encrypt" || target === "GenerateDataKey") {
        const keyId = String(b.KeyId ?? "");
        if (!keyId) return err(res, 400, "ValidationException", "1 validation error detected: KeyId is required");
        if (s.disabled.has(keyId)) return err(res, 400, "DisabledException", `${keyId} is disabled.`);
        const ctx = b.EncryptionContext;
        if (target === "Encrypt") {
          if (typeof b.Plaintext !== "string") return err(res, 400, "ValidationException", "Plaintext is required");
          const pt = Buffer.from(b.Plaintext, "base64");
          if (pt.length < 1 || pt.length > 4096) return err(res, 400, "ValidationException", "Plaintext length out of range");
          return reply({ CiphertextBlob: seal(keyId, pt, ctx), KeyId: `arn:aws:kms:${s.region}:111122223333:key/${keyId}`, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
        }
        const dk = crypto.randomBytes(b.KeySpec === "AES_128" ? 16 : 32);
        return reply({ Plaintext: dk.toString("base64"), CiphertextBlob: seal(keyId, dk, ctx), KeyId: `arn:aws:kms:${s.region}:111122223333:key/${keyId}` });
      }
      // Decrypt
      try {
        const blob = Buffer.from(String(b.CiphertextBlob ?? ""), "base64");
        const idLen = blob[0] ?? 0, keyId = blob.subarray(1, 1 + idLen).toString();
        if (!blob.length || !keks.has(keyId)) return err(res, 400, "InvalidCiphertextException");
        if (s.disabled.has(keyId)) return err(res, 400, "DisabledException", `${keyId} is disabled.`);
        const iv = blob.subarray(1 + idLen, 13 + idLen), tag = blob.subarray(13 + idLen, 29 + idLen), ct = blob.subarray(29 + idLen);
        const d = crypto.createDecipheriv("aes-256-gcm", kek(keyId), iv);
        d.setAAD(ctxAad(b.EncryptionContext)); d.setAuthTag(tag);
        const pt = Buffer.concat([d.update(ct), d.final()]);
        return reply({ Plaintext: pt.toString("base64"), KeyId: `arn:aws:kms:${s.region}:111122223333:key/${keyId}`, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
      } catch { return err(res, 400, "InvalidCiphertextException"); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return s;
}
