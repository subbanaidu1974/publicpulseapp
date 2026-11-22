/**
 * Reference mock SMS vendor for the NEUTRAL submit/receipt shape (server/civic/providers/sms.ts). Tests and local development only:
 * never started by the app. A vendor-specific adapter author copies this to build a vendor simulator with the same controls.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { signedHeaders, verifySignature } from "../util";

export type MockSmsMode = "ok" | "error500" | "timeout" | "reject400" | "garbage" | "no_id";
export interface MockSmsRecord { to: string; text: string; idempotencyKey: string; senderId: string | null; templateId: string | null; dltTemplateId: string | null; variables: Record<string, string>; messageId: string }

export interface MockSmsServer {
  url: string; secret: string;
  mode: MockSmsMode; unitCost: number | null;
  /** Every accepted submission, in order (one entry per DISTINCT idempotency key, like a real vendor). */
  received: MockSmsRecord[];
  /** Every HTTP request including rejected ones (signature/auth failures count). */
  requests: number; unauthorised: number;
  /** POST a neutral receipt to the app's receipt endpoint (HMAC signed with `receiptSecret`). */
  sendReceipt(callbackUrl: string, receiptSecret: string, receipts: { message_id: string; status: string; error_code?: string }[]): Promise<number>;
  close(): Promise<void>;
}

export async function startMockSmsServer(secret = "mock-sms-secret"): Promise<MockSmsServer> {
  const byKey = new Map<string, MockSmsRecord>();
  const hanging = new Set<http.ServerResponse>();
  const state: MockSmsServer = {
    url: "", secret, mode: "ok", unitCost: null, received: [], requests: 0, unauthorised: 0,
    async sendReceipt(callbackUrl, receiptSecret, receipts) {
      const body = JSON.stringify({ receipts });
      const r = await fetch(callbackUrl, { method: "POST", headers: signedHeaders(receiptSecret, body), body });
      return r.status;
    },
    close: () => new Promise<void>((resolve) => { for (const r of hanging) r.destroy(); srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
  const srv = http.createServer((req, res) => {
    state.requests++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!verifySignature(secret, req.headers["x-civic-timestamp"] as string, req.headers["x-civic-signature"] as string, raw)) {
        state.unauthorised++; res.writeHead(401).end(JSON.stringify({ error: "bad_signature" })); return;
      }
      if (state.mode === "timeout") { hanging.add(res); return; } // never answers
      if (state.mode === "error500") { res.writeHead(500).end("{}"); return; }
      if (state.mode === "reject400") { res.writeHead(400).end(JSON.stringify({ error: "invalid_destination" })); return; }
      if (state.mode === "garbage") { res.writeHead(200).end("<html>not json</html>"); return; }
      let b: { idempotency_key: string; to: string; text: string; sender_id: string | null; template: { id: string; dlt_template_id: string | null } | null; variables: Record<string, string> };
      try { b = JSON.parse(raw); } catch { res.writeHead(400).end("{}"); return; }
      let rec = byKey.get(b.idempotency_key);
      if (!rec) {
        rec = { to: b.to, text: b.text, idempotencyKey: b.idempotency_key, senderId: b.sender_id, templateId: b.template?.id ?? null, dltTemplateId: b.template?.dlt_template_id ?? null, variables: b.variables, messageId: "m_" + crypto.randomBytes(6).toString("hex") };
        byKey.set(b.idempotency_key, rec); state.received.push(rec);
      }
      const out: Record<string, unknown> = state.mode === "no_id" ? { status: "queued" } : { message_id: rec.messageId, status: "queued" };
      if (state.unitCost !== null) { out.unit_cost = state.unitCost; out.currency = "INR"; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/submit`;
  return state;
}
