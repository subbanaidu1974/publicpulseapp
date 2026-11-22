/** S-33 (@E2E-42) verified-quality score and sampling language. */
import { describe, expect, it } from "vitest";
import { QUALITY_WEIGHTS, qualityScore, samplingNote } from "../../../server/civic/surveys/quality";

const used = [{ dimension: "gender", of: ["gender"], area: "state:AP", shares: { M: 0.5, F: 0.5 }, source: "s", asOf: "2011", provenance: "census-2011" }];

describe("quality score", () => {
  it("@E2E-42 combines the four documented components into 0-100 with every component visible", () => {
    const n = 100;
    const q = qualityScore({ n, tiers: Array(n).fill("T2"), risks: Array(n).fill("low"), cats: [...Array(50).fill({ gender: "M" }), ...Array(50).fill({ gender: "F" })], used });
    expect(q.score).toBe(100);
    expect(q.components.map((c) => c.key)).toEqual(["t2_share", "low_risk", "coverage", "skew"]);
    expect(q.components.map((c) => c.weight)).toEqual(Object.values(QUALITY_WEIGHTS));
    expect(q.partial).toBe(false);
    expect(q.skew_index).toBe(0);
  });

  it("@E2E-42 lower tier, risk flags, a thin category and skew each lower the score", () => {
    const cats = [...Array(95).fill({ gender: "M" }), ...Array(5).fill({ gender: "F" })];
    const q = qualityScore({ n: 100, tiers: [...Array(60).fill("T2"), ...Array(40).fill("T1")], risks: [...Array(80).fill("low"), ...Array(20).fill("high")], cats, used, minCategoryN: 10 });
    const by = Object.fromEntries(q.components.map((c) => [c.key, c.value]));
    expect(by.t2_share).toBe(0.6);
    expect(by.low_risk).toBe(0.8);
    expect(by.coverage).toBe(0.5); // F has 5 < 10 respondents: half the reference mass is uncovered
    expect(by.skew).toBeCloseTo(0.55, 3); // sample 95% M vs 50%: total variation 0.45
    expect(q.score).toBe(Math.round(100 * (0.35 * 0.6 + 0.2 * 0.8 + 0.25 * 0.5 + 0.2 * 0.55)));
  });

  it("@E2E-42 components that cannot be computed are shown unavailable and the score is re-scaled, flagged partial", () => {
    const q = qualityScore({ n: 40, tiers: Array(40).fill("T2"), cats: Array(40).fill({}), used: [] });
    expect(q.partial).toBe(true);
    expect(q.components.filter((c) => !c.available).map((c) => c.key)).toEqual(["low_risk", "coverage", "skew"]);
    expect(q.score).toBe(100);
    expect(qualityScore({ n: 0, tiers: [], cats: [], used: [] }).score).toBeNull();
  });
});

describe("sampling language", () => {
  it("@E2E-42 says 'not a random sample', gives effective n and a coverage warning, and no margin of error", () => {
    const s = samplingNote(300, 212.34, 1.41, true);
    expect(s.margin_of_error).toBeNull();
    expect(s.note_en).toMatch(/Not a random sample/);
    expect(s.note_en).toMatch(/margin of error does not apply/);
    expect(s.effective_n).toBe(212.3);
    expect(s.coverage_warning_en).toMatch(/under-represented/);
    expect(samplingNote(100, 100, 1, false).note_en).toMatch(/same/);
  });
});
