/** Reference mock number-intelligence vendor for the NEUTRAL shape (server/civic/providers/numberintel.ts). Tests / local development only. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { verifySignature } from "../util";

export type MockIntelMode = "ok" | "error500" | "timeout" | "garbage";
export interface MockIntelServer {
  url: string; secret: string; mode: MockIntelMode;
  /** msisdn -> answer; anything else gets `defaults`. */
  answers: Map<string, Record<string, unknown>>; defaults: Record<string, unknown>;
  /** Every request body the vendor received (so tests can assert exactly what was sent). */
  bodies: string[]; unauthorised: number; calls: number;
  close(): Promise<void>;
}

export async function startMockIntelServer(secret = "mock-intel-secret"): Promise<MockIntelServer> {
  const hanging = new Set<http.ServerResponse>();
  const s: MockIntelServer = {
    url: "", secret, mode: "ok", answers: new Map(), bodies: [], unauthorised: 0, calls: 0,
    defaults: { line_type: "mobile_postpaid", recycled: false, ported_recently: false, carrier_circle: "AP", activation_age_days: 900, activation_confidence: 0.9 },
    close: () => new Promise<void>((resolve) => { for (const r of hanging) r.destroy(); srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      s.calls++; s.bodies.push(raw);
      if (!verifySignature(secret, req.headers["x-civic-timestamp"] as string, req.headers["x-civic-signature"] as string, raw)) { s.unauthorised++; res.writeHead(401).end("{}"); return; }
      if (s.mode === "timeout") { hanging.add(res); return; }
      if (s.mode === "error500") { res.writeHead(500).end("{}"); return; }
      if (s.mode === "garbage") { res.writeHead(200).end("nope"); return; }
      let msisdn = "";
      try { msisdn = (JSON.parse(raw) as { msisdn: string }).msisdn; } catch { res.writeHead(400).end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(s.answers.get(msisdn) ?? s.defaults));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/lookup`;
  return s;
}
