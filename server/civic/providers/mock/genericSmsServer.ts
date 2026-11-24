/**
 * Local simulator of a "generic Indian DLT SMS gateway" for tests of providers/smsgeneric.ts. Tests and local development only.
 * Deliberately NOT the neutral shape: custom request field names, header-key auth, nested response, vendor status words, and receipts
 * posted as `{ "dlr": [ { "id", "state", "err" } ] }` signed with a bare hex HMAC in `x-signature`. It is invented for testing; it does
 * not describe any real vendor.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

export type GenericMode = "ok" | "error500" | "timeout" | "reject400";
export interface GenericRecord { to: string; text: string; reference: string; sender: string | null; dltTemplateId: string | null; entityId: string | null; messageId: string }
export interface GenericSmsServer {
  url: string; authValue: string; receiptSecret: string;
  mode: GenericMode; price: number | null;
  received: GenericRecord[]; requests: number; unauthorised: number; lastBody: Record<string, unknown> | null;
  sendReceipt(callbackUrl: string, dlr: { id: string; state: string; err?: string }[], opts?: { secret?: string }): Promise<number>;
  close(): Promise<void>;
}

export async function startGenericSmsServer(authValue = "gw-test-key", receiptSecret = "gw-receipt-secret"): Promise<GenericSmsServer> {
  const byRef = new Map<string, GenericRecord>();
  const hanging = new Set<http.ServerResponse>();
  const s: GenericSmsServer = {
    url: "", authValue, receiptSecret, mode: "ok", price: null, received: [], requests: 0, unauthorised: 0, lastBody: null,
    async sendReceipt(cb, dlr, opts) {
      const body = JSON.stringify({ dlr });
      const sig = crypto.createHmac("sha256", opts?.secret ?? receiptSecret).update(body).digest("hex");
      return (await fetch(cb, { method: "POST", headers: { "content-type": "application/json", "x-signature": sig }, body })).status;
    },
    close: () => new Promise<void>((r) => { for (const x of hanging) x.destroy(); srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
  const srv = http.createServer((req, res) => {
    s.requests++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.headers["x-gw-key"] !== authValue) { s.unauthorised++; res.writeHead(401).end("{}"); return; }
      if (s.mode === "timeout") { hanging.add(res); return; }
      if (s.mode === "error500") { res.writeHead(500).end("{}"); return; }
      if (s.mode === "reject400") { res.writeHead(400).end(JSON.stringify({ error: "bad number" })); return; }
      let b: Record<string, string>;
      try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400).end("{}"); return; }
      s.lastBody = b;
      let rec = byRef.get(b.ref);
      if (!rec) {
        rec = { to: b.mobile, text: b.message, reference: b.ref, sender: b.senderid ?? null, dltTemplateId: b.dlt_te_id ?? null, entityId: b.dlt_pe_id ?? null, messageId: "gw_" + crypto.randomBytes(6).toString("hex") };
        byRef.set(b.ref, rec); s.received.push(rec);
      }
      const data: Record<string, unknown> = { id: rec.messageId, state: "ACCEPTED" };
      if (s.price !== null) { data.price = s.price; data.cur = "INR"; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/send`;
  return s;
}
