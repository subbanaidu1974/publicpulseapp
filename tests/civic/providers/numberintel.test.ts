import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNumberIntelligence, isDevNumberIntelligence, setNumberIntelligence, DEV_NUMBER_FIXTURES } from "../../../server/civic/identity/service";
import { migrate as coreMigrate, resetDbForTests as coreReset } from "../../../server/civic/core";
import { startMockIntelServer } from "../../../server/civic/providers/mock/intelServer";
import { HttpNumberIntel, ManagedNumberIntel, UNKNOWN_REPORT, classifyNumber, type ManagedIntelOpts } from "../../../server/civic/providers/numberintel";
import { runNumberIntelContract, type IntelHarness } from "./contract/numberintel.contract";

/** Certifies the neutral HttpNumberIntel against the reference mock vendor. */
runNumberIntelContract("HttpNumberIntel + reference mock", async (o: ManagedIntelOpts): Promise<IntelHarness> => {
  const mock = await startMockIntelServer();
  let t = Date.now();
  const intel = new HttpNumberIntel({ ...o, url: mock.url, secret: mock.secret, now: () => t });
  return {
    intel,
    setFacts: (n, f) => {
      const cur = mock.answers.get(n) ?? { ...mock.defaults };
      const m: Record<string, unknown> = { line_type: f.lineType ?? cur.line_type, recycled: f.recycled === undefined ? cur.recycled : f.recycled, ported_recently: f.portedRecently === undefined ? cur.ported_recently : f.portedRecently,
        carrier_circle: f.carrierCircle === undefined ? cur.carrier_circle : f.carrierCircle, activation_age_days: f.activationAgeDays === undefined ? cur.activation_age_days : f.activationAgeDays,
        activation_confidence: f.activationConfidence === undefined ? cur.activation_confidence : f.activationConfidence };
      mock.answers.set(n, m);
    },
    setMode: (m) => { mock.mode = m; },
    calls: () => mock.calls, bodies: () => mock.bodies, advance: (ms) => { t += ms; },
    close: () => mock.close(),
  };
});

describe("number intelligence wiring (S-62)", () => {
  beforeEach(() => { coreReset(); coreMigrate(); });
  afterEach(() => { setNumberIntelligence(null); coreReset(); });

  it("@E2E-77 installs through identity's setter; dev fixtures remain the default and are flagged as dev", async () => {
    expect(isDevNumberIntelligence()).toBe(true);
    expect(await getNumberIntelligence().lookup([...DEV_NUMBER_FIXTURES.voip][0])).toMatchObject({ voip: true });
    const mock = await startMockIntelServer();
    try {
      const adapter = new HttpNumberIntel({ url: mock.url, secret: mock.secret });
      setNumberIntelligence(adapter);
      expect(isDevNumberIntelligence()).toBe(false);
      const r = await getNumberIntelligence().lookup("+919876500001");
      expect(r.voip).toBe(false); // the existing two-field contract still holds
      expect(r.recently_reissued).toBe(false);
      setNumberIntelligence(null);
      expect(isDevNumberIntelligence()).toBe(true);
    } finally { await mock.close(); }
  });

  it("@E2E-77 classification is a pure function with documented precedence", () => {
    const f = { lineType: "mobile_postpaid" as const, recycled: false, portedRecently: false, carrierCircle: null, activationAgeDays: 400, activationConfidence: 0.5 };
    expect(classifyNumber(f).risk).toBe("low");
    expect(classifyNumber({ ...f, lineType: "landline" }).risk).toBe("medium");
    expect(classifyNumber({ ...f, lineType: "voip", portedRecently: true }).risk).toBe("high"); // high beats medium
    expect(classifyNumber({ ...f, activationConfidence: 7 }).activationConfidence).toBe(1);
    expect(UNKNOWN_REPORT.trust).toBe("reduced");
  });

  it("@E2E-77 the HTTP adapter refuses plain http in production and a missing secret", () => {
    const keep = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => new HttpNumberIntel({ url: "http://intel.example.org", secret: "s" })).toThrow(/https/);
      expect(() => new HttpNumberIntel({ url: "https://intel.example.org", secret: "" })).toThrow(/CIVIC_NUMINTEL_SECRET/);
    } finally { process.env.NODE_ENV = keep; }
  });

  it("@E2E-77 a transport that throws a non-ProviderError still yields unknown, and the cache is bounded", async () => {
    let n = 0;
    const m = new ManagedNumberIntel({ name: "x", lookup: async () => { n++; throw new Error("boom +919876500000"); } }, { cacheMax: 3 });
    for (let i = 0; i < 6; i++) expect((await m.lookup("+91987650000" + i)).risk).toBe("unknown");
    expect(m.cacheSize()).toBeLessThanOrEqual(3);
    expect(n).toBe(5); // the breaker opened after five failures; the sixth was not even attempted
    m.clearCache();
    expect(m.cacheSize()).toBe(0);
  });
});
