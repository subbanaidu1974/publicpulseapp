/**
 * Local simulator of a "generic transactional mail API" for tests of providers/mailgeneric.ts. Tests and local development only.
 * Deliberately NOT the neutral shape: custom field names (rcpt, sender, subj, body, dedupe), header-key auth (x-mail-key). It is invented
 * for testing; it does not describe any real vendor.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type MailMode = "ok" | "error500" | "timeout" | "reject400";
export interface MailRecord { rcpt: string; sender: string | null; subj: string; body: string; dedupe: string | null; idempotencyHeader: string | null; contentType: string }
export interface GenericMailServer {
  url: string; authValue: string; mode: MailMode;
  received: MailRecord[]; requests: number; unauthorised: number;
  close(): Promise<void>;
}

export async function startGenericMailServer(authValue = "mail-test-key"): Promise<GenericMailServer> {
  const hanging = new Set<http.ServerResponse>();
  const s: GenericMailServer = {
    url: "", authValue, mode: "ok", received: [], requests: 0, unauthorised: 0,
    close: () => new Promise<void>((r) => { for (const x of hanging) x.destroy(); srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
  const srv = http.createServer((req, res) => {
    s.requests++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.headers["x-mail-key"] !== authValue) { s.unauthorised++; res.writeHead(401).end("{}"); return; }
      if (s.mode === "timeout") { hanging.add(res); return; }
      if (s.mode === "error500") { res.writeHead(500).end("{}"); return; }
      if (s.mode === "reject400") { res.writeHead(400).end(JSON.stringify({ error: "bad address" })); return; }
      const raw = Buffer.concat(chunks).toString("utf8");
      const ct = String(req.headers["content-type"] ?? "");
      let b: Record<string, string>;
      try { b = ct.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); } catch { res.writeHead(400).end("{}"); return; }
      s.received.push({ rcpt: b.rcpt, sender: b.sender ?? null, subj: b.subj, body: b.body, dedupe: b.dedupe ?? null, idempotencyHeader: (req.headers["idempotency-key"] as string) ?? null, contentType: ct });
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ queued: true }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/mail`;
  return s;
}
