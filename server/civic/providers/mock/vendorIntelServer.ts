/**
 * Simulator of a hypothetical number-intelligence vendor with a NON-neutral shape (API key header, nested response, vendor enums, 401/429
 * answers). Used to test the generic HTTP adapter's mapping. It is invented for tests: it is NOT any real vendor's API.
 *
 *   POST /v2/lookup   x-api-key: <key>   { "phone_number": "+91..." }
 *   -> { "status": "ok", "data": { "carrier": { "type": "PREPAID|POSTPAID|VOIP|FIXED|UNKNOWN", "circle": "AP" },
 *        "flags": { "ported": bool, "recycled": bool }, "activation": { "days": n, "confidence": 0..1 } } }
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { GenericIntelMapping } from "../numberintelHttp";

export type VendorSimMode = "ok" | "error500" | "timeout" | "garbage" | "throttle" | "unauthorised";
export interface VendorIntelSim {
  url: string; apiKey: string; mode: VendorSimMode; calls: number; bodies: string[]; badKeys: number;
  answers: Map<string, Record<string, unknown>>;
  /** The mapping that describes this simulator's shape. */
  mapping: GenericIntelMapping;
  close(): Promise<void>;
}

export const VENDOR_SIM_MAPPING: GenericIntelMapping = {
  numberField: "phone_number", requestIdField: null, extraBody: {}, apiKeyHeader: "x-api-key",
  response: {
    lineType: "data.carrier.type", carrierCircle: "data.carrier.circle", portedRecently: "data.flags.ported", recycled: "data.flags.recycled",
    activationAgeDays: "data.activation.days", activationConfidence: "data.activation.confidence",
    lineTypeMap: { PREPAID: "mobile_prepaid", POSTPAID: "mobile_postpaid", VOIP: "voip", FIXED: "landline", UNKNOWN: "unknown" },
  },
};

export async function startVendorIntelSim(apiKey = "sim-vendor-api-key"): Promise<VendorIntelSim> {
  const hanging = new Set<http.ServerResponse>();
  const s: VendorIntelSim = {
    url: "", apiKey, mode: "ok", calls: 0, bodies: [], badKeys: 0, answers: new Map(), mapping: VENDOR_SIM_MAPPING,
    close: () => new Promise<void>((resolve) => { for (const r of hanging) r.destroy(); srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      s.calls++; s.bodies.push(raw);
      if (req.headers["x-api-key"] !== s.apiKey || s.mode === "unauthorised") { s.badKeys++; res.writeHead(401).end(JSON.stringify({ status: "error", error: "invalid_api_key" })); return; }
      if (s.mode === "timeout") { hanging.add(res); return; }
      if (s.mode === "error500") { res.writeHead(500).end("{}"); return; }
      if (s.mode === "throttle") { res.writeHead(429, { "retry-after": "1" }).end(JSON.stringify({ status: "error", error: "rate_limited" })); return; }
      if (s.mode === "garbage") { res.writeHead(200).end("<html>maintenance</html>"); return; }
      let n: string;
      try { const j = JSON.parse(raw) as { phone_number?: string; msisdn?: string }; n = String(j.phone_number ?? j.msisdn); } catch { res.writeHead(400).end("{}"); return; }
      const a = s.answers.get(n) ?? { type: "POSTPAID", circle: "AP", ported: false, recycled: false, days: 900, confidence: 0.9 };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        status: "ok", data: { carrier: { type: a.type, circle: a.circle }, flags: { ported: a.ported, recycled: a.recycled }, activation: { days: a.days, confidence: a.confidence } },
      }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v2/lookup`;
  return s;
}
