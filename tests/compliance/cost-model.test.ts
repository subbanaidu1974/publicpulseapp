import { describe, expect, it } from "vitest";
import { compute, effectivePrice, loadAssumptions, otpCaps, renderMarkdown, type Assumptions } from "../../scripts/cost-model";

describe("UT-cost-model (S-152)", () => {
  it("@E2E-167 the committed assumptions contain no invented price: every unit price is null", () => {
    const a = loadAssumptions();
    for (const [k, p] of Object.entries(a.unitPrices)) {
      expect(p.value, k).toBeNull();
      expect(p.sourceUrl, k).toBeNull();
    }
  });

  it("@E2E-167 with all prices unknown, every line is UNKNOWN, the known total is 0 and the output says so", () => {
    const a = loadAssumptions();
    for (const name of Object.keys(a.scenarios)) {
      const r = compute(a, name, {});
      expect(r.knownTotal).toBe(0);
      expect(r.unknownCount).toBe(r.lines.length);
      const md = renderMarkdown(r);
      expect(md).toContain("UNKNOWN");
      expect(md).toContain("NOT a budget");
    }
  });

  it("@E2E-167 a price counts only with a source URL and a verification date", () => {
    expect(effectivePrice({ value: 1, unit: "x", sourceUrl: null, verifiedOn: null })).toBeNull();
    expect(effectivePrice({ value: 1, unit: "x", sourceUrl: "https://example.org/p", verifiedOn: null })).toBeNull();
    expect(effectivePrice({ value: 1, unit: "x", sourceUrl: "https://example.org/p", verifiedOn: "2026-11-22" })).toBe(1);
  });

  it("@E2E-167 computes costs only for verified prices (synthetic test prices)", () => {
    const a = structuredClone(loadAssumptions()) as Assumptions;
    a.unitPrices.smsOtpPerMessage = { value: 0.5, unit: "INR per SMS", sourceUrl: "https://example.org/test-rate", verifiedOn: "2026-01-01" };
    const r = compute(a, "pilot", {});
    const line = r.lines.find((l) => l.priceKey === "smsOtpPerMessage")!;
    expect(line.cost).toBeCloseTo(line.quantity * 0.5, 1);
    expect(r.knownTotal).toBeCloseTo(line.cost!, 5);
    expect(r.unknownCount).toBe(r.lines.length - 1);
  });

  it("@E2E-167 OTP caps follow the env vars the code reads, with the code defaults", () => {
    const a = loadAssumptions();
    const s = a.scenarios.statewide;
    const users = Math.round(s.adultsReachable * s.signupRate);
    const def = otpCaps(s, users, {});
    expect(def.hourlyBudget).toBe(2000);
    expect(def.networkLimitPer10Min).toBe(60);
    expect(def.hourVerdict).toMatch(/EXCEEDS/);
    const big = otpCaps(s, users, { CIVIC_SMS_HOURLY_BUDGET: "100000000", CIVIC_OTP_NET_LIMIT: "100000" });
    expect(big.hourVerdict).toBe("within budget");
    expect(big.networkVerdict).toBe("within cap");
  });

  it("@E2E-167 an unknown scenario throws", () => {
    expect(() => compute(loadAssumptions(), "nope", {})).toThrow(/unknown scenario/);
  });
});
