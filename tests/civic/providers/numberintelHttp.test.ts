import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../../../server/civic/core";
import { startVendorIntelSim, VENDOR_SIM_MAPPING, type VendorIntelSim } from "../../../server/civic/providers/mock/vendorIntelServer";
import type { ManagedIntelOpts } from "../../../server/civic/providers/numberintel";
import { GenericHttpNumberIntel } from "../../../server/civic/providers/numberintelHttp";
import { setProviderLogger } from "../../../server/civic/providers/util";
import { runNumberIntelContract, type IntelHarness } from "./contract/numberintel.contract";

const TYPE = { mobile_prepaid: "PREPAID", mobile_postpaid: "POSTPAID", voip: "VOIP", landline: "FIXED", unknown: "UNKNOWN" } as const;

/** Certifies GenericHttpNumberIntel (default request field names + a vendor-style response mapping) against the vendor simulator. */
runNumberIntelContract("GenericHttpNumberIntel + vendor-shaped simulator", async (o: ManagedIntelOpts): Promise<IntelHarness> => {
  const sim = await startVendorIntelSim();
  let t = Date.now();
  const intel = new GenericHttpNumberIntel({ ...o, url: sim.url, apiKey: sim.apiKey, mapping: { response: VENDOR_SIM_MAPPING.response }, now: () => t });
  return {
    intel,
    setFacts: (n, f) => {
      const cur = sim.answers.get(n) ?? { type: "POSTPAID", circle: "AP", ported: false, recycled: false, days: 900, confidence: 0.9 };
      sim.answers.set(n, {
        type: f.lineType ? TYPE[f.lineType] : cur.type, circle: f.carrierCircle === undefined ? cur.circle : f.carrierCircle,
        ported: f.portedRecently === undefined ? cur.ported : f.portedRecently, recycled: f.recycled === undefined ? cur.recycled : f.recycled,
        days: f.activationAgeDays === undefined ? cur.days : f.activationAgeDays, confidence: f.activationConfidence === undefined ? cur.confidence : f.activationConfidence,
      });
    },
    setMode: (m) => { sim.mode = m; },
    calls: () => sim.calls, bodies: () => sim.bodies, advance: (ms) => { t += ms; },
    close: () => sim.close(),
  };
});

describe("generic HTTP number intelligence (S-62)", () => {
  let sim: VendorIntelSim;
  beforeEach(async () => { resetDbForTests(); migrate(); sim = await startVendorIntelSim(); setProviderLogger(() => undefined); });
  afterEach(async () => { await sim.close(); setProviderLogger(null); resetDbForTests(); });
  const N = "+919876540001";
  const mk = (extra: Partial<ConstructorParameters<typeof GenericHttpNumberIntel>[0]> = {}) =>
    new GenericHttpNumberIntel({ url: sim.url, apiKey: sim.apiKey, mapping: VENDOR_SIM_MAPPING, timeoutMs: 300, ...extra });

  it("@E2E-77 full custom mapping: renamed request field, no request id, nested response, vendor enums", async () => {
    sim.answers.set(N, { type: "PREPAID", circle: "TS", ported: true, recycled: false, days: 10, confidence: 0.8 });
    const r = await mk().lookup(N);
    expect(r).toMatchObject({ lineType: "mobile_prepaid", carrierCircle: "TS", portedRecently: true, activationAgeDays: 10, risk: "medium", source: "vendor" });
    expect(JSON.parse(sim.bodies[0])).toEqual({ phone_number: N });
  });

  it("@E2E-77 a bad API key, rate limiting, 5xx and an HTML maintenance page all yield unknown/reduced and never throw", async () => {
    const modes = ["unauthorised", "throttle", "error500", "garbage"] as const;
    for (const mode of modes) {
      sim.mode = mode;
      expect(await mk().lookup("+9198765400" + (10 + modes.indexOf(mode)))).toMatchObject({ risk: "unknown", trust: "reduced", voip: false, recently_reissued: false, source: "unknown" });
    }
    sim.mode = "ok";
    expect(await mk({ apiKey: "wrong" }).lookup("+919876540099")).toMatchObject({ risk: "unknown", trust: "reduced" });
    expect(sim.badKeys).toBeGreaterThan(0);
  });

  it("@E2E-77 unmapped vendor enums become unknown; out-of-range confidence is dropped, not trusted", async () => {
    sim.answers.set(N, { type: "SATELLITE", circle: "AP", ported: false, recycled: false, days: 400, confidence: 7 });
    expect(await mk().lookup(N)).toMatchObject({ lineType: "unknown", activationAgeDays: 400, activationConfidence: 0 });
  });

  it("@E2E-77 authorization header with a prefix, and config guards", async () => {
    const seen: Record<string, string>[] = [];
    const r = await new GenericHttpNumberIntel({
      url: "https://intel.example.org/lookup", apiKey: "k", mapping: { apiKeyHeader: "Authorization", apiKeyPrefix: "Bearer " },
      fetchImpl: async (_u, i) => { seen.push(i.headers); return { status: 200, text: async () => JSON.stringify({ line_type: "voip" }) }; },
    }).lookup(N);
    expect(seen[0].authorization).toBe("Bearer k");
    expect(r).toMatchObject({ voip: true, risk: "high" });
    expect(() => new GenericHttpNumberIntel({ url: "https://x.example.org", apiKey: "" })).toThrow(/API_KEY/);
    const keep = process.env.NODE_ENV;
    try { process.env.NODE_ENV = "production"; expect(() => new GenericHttpNumberIntel({ url: "http://x.example.org", apiKey: "k" })).toThrow(/https/); } finally { process.env.NODE_ENV = keep; }
  });
});
