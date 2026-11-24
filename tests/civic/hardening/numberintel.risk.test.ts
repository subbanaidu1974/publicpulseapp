/** S-162 (@E2E-186): number-intelligence risk in identity: flags, stricter caps, reduced-trust survey key class, and never a refusal because the vendor is down. */
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, migrate, resetDbForTests, getStore } from "../../../server/civic/core";
import { isSurveyEligible, numberFlags, numberRisk, setNumberIntelligence } from "../../../server/civic/identity/service";
import { startMockIntelServer, type MockIntelServer } from "../../../server/civic/providers/mock/intelServer";
import { HttpNumberIntel } from "../../../server/civic/providers/numberintel";
import { setProviderLogger } from "../../../server/civic/providers/util";
import { call as svcCall, freshWorld, mkPerson, mkSurvey, serve as serveSurveys, useSurveys } from "../surveys/helpers";
import { caller, serveIdentity, signupVia } from "./helpers";

let server: Server, call: ReturnType<typeof caller>, mock: MockIntelServer;
beforeAll(async () => { const s = await serveIdentity(); server = s.server; call = caller(s.base); mock = await startMockIntelServer(); });
afterAll(async () => { server.close(); await mock.close(); });
beforeEach(() => {
  process.env.CIVIC_EXPOSE_DEV_OTP = "1";
  resetDbForTests(); migrate(); setProviderLogger(() => undefined);
  mock.mode = "ok"; mock.answers.clear(); mock.calls = 0;
  setNumberIntelligence(new HttpNumberIntel({ url: mock.url, secret: mock.secret, timeoutMs: 400 }));
});
afterEach(() => { setNumberIntelligence(null); setProviderLogger(null); resetDbForTests(); delete process.env.CIVIC_EXPOSE_DEV_OTP; delete process.env.CIVIC_RISK_CAP_FACTOR; });

const PHONE = "+919876500031";
const flagsOf = (id: string) => JSON.parse((getDb().prepare("SELECT flags FROM persons WHERE id = ?").get(id) as { flags: string }).flags) as string[];
const facts = (o: Record<string, unknown>) => mock.answers.set(PHONE, { ...mock.defaults, ...o });

describe("number-intelligence risk in identity (S-162)", () => {
  it("@E2E-186 a clean number gets no risk flag", async () => {
    const p = await signupVia(call, PHONE);
    expect(flagsOf(p.id)).toEqual([]);
  });

  it("@E2E-186 a recently ported number is flagged medium risk and ported, and answers survey eligibility questions in the LOW key class", async () => {
    facts({ ported_recently: true });
    const p = await signupVia(call, PHONE);
    expect(flagsOf(p.id).sort()).toEqual(["number_ported", "number_risk_medium"]);
    expect(isSurveyEligible(p.id, new Date(Date.now() + 40 * 86400000))).toBe(true); // reduced trust, not excluded
  });

  it("@E2E-186 a recycled number is flagged recently_reissued: T0-restricted, never survey-eligible until a volunteer confirms it", async () => {
    facts({ recycled: true });
    const p = await signupVia(call, PHONE);
    expect(flagsOf(p.id)).toEqual(expect.arrayContaining(["recently_reissued", "number_risk_high"]));
    expect(isSurveyEligible(p.id, new Date(Date.now() + 40 * 86400000))).toBe(false);
    expect(p.person.flags).toContain("recently_reissued");
  });

  it("@E2E-186 a VoIP verdict still blocks sign-up (existing rule), and its request is refused before any code is sent", async () => {
    facts({ line_type: "voip" });
    const rq = await call("POST", "/signup/request", { phone: PHONE });
    expect(rq.status).toBe(403);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM otps").get()).toEqual({ c: 0 });
  });

  it("@E2E-186 a vendor failure never blocks sign-up: the account is created, flagged number_unverified, with no penalty", async () => {
    for (const mode of ["error500", "garbage", "timeout"] as const) {
      resetDbForTests(); migrate(); setProviderLogger(() => undefined);
      setNumberIntelligence(new HttpNumberIntel({ url: mock.url, secret: mock.secret, timeoutMs: 150 }));
      mock.mode = mode;
      const p = await signupVia(call, PHONE);
      expect(flagsOf(p.id), mode).toEqual(["number_unverified"]);
    }
  });

  it("@E2E-186 an adapter that THROWS is treated the same way (the lookup is wrapped)", async () => {
    setNumberIntelligence({ lookup: async () => { throw new Error("vendor exploded"); } });
    const p = await signupVia(call, PHONE);
    expect(flagsOf(p.id)).toEqual(["number_unverified"]);
  });

  it("@E2E-186 elevated-risk numbers get a stricter per-phone OTP cap (CIVIC_RISK_CAP_FACTOR); a normal number keeps 3 per 10 minutes", async () => {
    facts({ ported_recently: true });
    const send = async (ph: string) => { getDb().prepare("DELETE FROM otps").run(); return call("POST", "/signup/request", { phone: ph }); }; // a still-valid code would answer already_sent first
    expect((await send(PHONE)).status).toBe(200);
    expect((await send(PHONE)).status).toBe(200);
    expect((await send(PHONE)).status).toBe(429); // 3 * 0.67 = 2
    process.env.CIVIC_RISK_CAP_FACTOR = "1";
    mock.answers.clear();
    const clean = "+919876500032";
    for (let i = 0; i < 3; i++) expect((await send(clean)).status).toBe(200);
    expect((await send(clean)).status).toBe(429); // the plain per-phone cap of 3
  });

  it("@E2E-186 classification helpers: derived risk for the two-field dev contract, flag set for a v2 report", () => {
    expect(numberRisk({ recently_reissued: false, voip: false })).toBe("low");
    expect(numberRisk({ recently_reissued: true, voip: false })).toBe("high");
    expect(numberFlags({ recently_reissued: false, voip: false, risk: "unknown", trust: "reduced", source: "unknown" })).toEqual(["number_unverified"]);
    expect(numberFlags({ recently_reissued: false, voip: false, risk: "unknown", trust: "reduced", source: "cache" })).toEqual(["number_unverified"]); // the short failure cache still means "unverified"
    expect(numberFlags({ recently_reissued: false, voip: false, risk: "low", trust: "normal", source: "vendor" })).toEqual([]);
  });
});

describe("risk flag and the survey key class (S-162)", () => {
  let srv: Server, base: string;
  beforeEach(async () => { freshWorld(); const s = await serveSurveys(); srv = s.s; base = s.base; });
  afterEach(() => { srv.close(); });
  it("@E2E-186 number_risk_medium / high flags put the person in the *_LOW key class; number_unverified and number_ported alone do not", async () => {
    const s = mkSurvey(); useSurveys(s);
    const elig = (flags: string[], tier: "T1" | "T2" = "T1") => svcCall(base, "GET", `/${s.id}/credential/eligibility`, { token: mkPerson({ flags, tier }).token });
    expect((await elig(["number_risk_medium"])).body).toMatchObject({ eligible: true, key_class: "T1_LOW", quality: "low" });
    expect((await elig(["number_risk_medium"], "T2")).body.key_class).toBe("T2_LOW");
    expect((await elig(["number_risk_high"])).body.key_class).toBe("T1_LOW");
    expect((await elig(["number_unverified", "number_ported"])).body.key_class).toBe("T1");
    expect(getStore("audit")).toBeTruthy();
  });
});
