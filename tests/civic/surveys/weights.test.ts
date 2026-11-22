/** S-33 (@E2E-42) weights: raking to existing marginals only, trimming, design effect, fallbacks. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { categoryOf, designEffect, effectiveN, loadMarginals, rake, selectTargets, type MarginalsFile } from "../../../server/civic/surveys/weights";

const units = (m: number, f: number) => [...Array(m).fill("M"), ...Array(f).fill("F")].map((g) => ({ cats: { gender: g as string | null } }));
const share = (u: { cats: Record<string, string | null> }[], w: number[], c: string) => u.reduce((s, x, i) => s + (x.cats.gender === c ? w[i] : 0), 0) / w.reduce((a, b) => a + b, 0);

describe("raking", () => {
  it("@E2E-42 weights a skewed sample to the target shares with mean weight 1", () => {
    const u = units(80, 20);
    const r = rake(u, { gender: { M: 0.5, F: 0.5 } });
    expect(r.converged).toBe(true);
    expect(share(u, r.weights, "F")).toBeCloseTo(0.5, 5);
    expect(r.weights.reduce((a, b) => a + b, 0) / u.length).toBeCloseTo(1, 9);
    expect(designEffect(r.weights)).toBeGreaterThan(1);
    expect(effectiveN(r.weights)).toBeLessThan(u.length);
    expect(effectiveN(r.weights) * designEffect(r.weights)).toBeCloseTo(u.length, 6);
  });

  it("@E2E-42 rakes two dimensions jointly (IPF) to both marginals", () => {
    const u: { cats: Record<string, string | null> }[] = [];
    const add = (g: string, a: string, n: number) => { for (let i = 0; i < n; i++) u.push({ cats: { gender: g, age: a } }); };
    add("M", "y", 40); add("M", "o", 20); add("F", "y", 25); add("F", "o", 15);
    const r = rake(u, { gender: { M: 0.5, F: 0.5 }, age: { y: 0.4, o: 0.6 } });
    const tot = (key: string, c: string) => u.reduce((s, x, i) => s + (x.cats[key] === c ? r.weights[i] : 0), 0) / u.length;
    expect(tot("gender", "F")).toBeCloseTo(0.5, 4);
    expect(tot("age", "o")).toBeCloseTo(0.6, 4);
  });

  it("@E2E-42 trims at 5x the mean weight and reports that the target is then not fully reached", () => {
    const u = units(199, 1);
    const r = rake(u, { gender: { M: 0.5, F: 0.5 } });
    expect(Math.max(...r.weights)).toBeLessThanOrEqual(5 + 1e-6);
    expect(r.trimmed).toBeGreaterThan(0);
    expect(r.fits[0].max_gap_pp).toBeGreaterThan(0);
  });

  it("@E2E-42 respondents with an unknown category are left unadjusted; categories with nobody are dropped and listed", () => {
    const u = [...units(30, 30), { cats: { gender: null } }];
    const r = rake(u, { gender: { M: 0.4, F: 0.4, X: 0.2 } });
    expect(r.fits[0].empty_categories).toEqual(["X"]);
    expect(r.weights[60]).toBeGreaterThan(0);
    expect(share(u.slice(0, 60), r.weights.slice(0, 60), "M")).toBeCloseTo(0.5, 5);
  });

  it("@E2E-42 with no targets the weights are all 1 and nothing is weighted", () => {
    const r = rake(units(10, 5), {});
    expect(r.weights.every((x) => x === 1)).toBe(true);
    expect(r.dimensions).toEqual([]);
    expect(designEffect(r.weights)).toBe(1);
  });

  it("@E2E-42 joint categories are built from several strata fields", () => {
    expect(categoryOf({ age_band: "18-24", gender: "F" }, ["age_band", "gender"])).toBe("18-24|F");
    expect(categoryOf({ age_band: "18-24", gender: null }, ["age_band", "gender"])).toBeNull();
  });
});

describe("marginals file and selection (never invent numbers)", () => {
  const file = loadMarginals();
  it("@E2E-42 the shipped file has Census 2011 sex shares per state and district, and NO age figures", () => {
    expect(file).not.toBeNull();
    const g = file!.dimensions.gender;
    expect(g.areas["state:AP"].shares).toBeTruthy();
    expect(g.areas["state:AP"].asOf).toBe("2011-03-01");
    expect(g.areas["state:AP"].shares!.F + g.areas["state:AP"].shares!.M).toBeCloseTo(1, 5);
    expect(Object.keys(g.areas).filter((k) => k.startsWith("district:")).length).toBe(23);
    expect(file!.dimensions.age_band_x_gender.provenance).toBe("placeholder");
    expect(Object.keys(file!.dimensions.age_band_x_gender.areas)).toEqual([]);
    expect(fs.readFileSync("data/reference/survey-marginals.json", "utf8")).not.toMatch(/18-24\|/);
  });

  it("@E2E-42 the sex share is used; age x gender is skipped as a placeholder and the method says so", () => {
    const sel = selectTargets(file, ["state:AP"]);
    expect(sel.used.map((d) => d.dimension)).toEqual(["gender"]);
    expect(sel.skipped.map((s) => `${s.dimension}:${s.reason}`)).toEqual(expect.arrayContaining(["age_band_x_gender:placeholder", "phone_ownership:placeholder"]));
  });

  it("@E2E-42 unverified provenance, invalid shares, a missing area or a missing file are never used", () => {
    const mk = (a: object): MarginalsFile => ({ schema: 1, dimensions: { gender: { of: ["gender"], areas: { "state:AP": a as never } } } });
    expect(selectTargets(mk({ shares: { M: 0.5, F: 0.5 }, provenance: "guess" }), ["state:AP"]).used).toEqual([]);
    expect(selectTargets(mk({ shares: { M: 0.7, F: 0.7 }, provenance: "census-2011" }), ["state:AP"]).skipped[0].reason).toBe("invalid_shares");
    expect(selectTargets(mk({ shares: { M: 0.5, F: 0.5 }, provenance: "placeholder" }), ["state:AP"]).used).toEqual([]);
    expect(selectTargets(mk({ shares: { M: 0.5, F: 0.5 }, provenance: "census-2011" }), ["state:TG"]).skipped[0].reason).toBe("no_figures_for_area");
    expect(selectTargets(null, ["state:AP"]).skipped[0].reason).toBe("file_missing");
    expect(selectTargets(mk({ shares: { M: 0.5, F: 0.5 }, provenance: "verified-other" }), ["district:1", "state:AP"]).used[0].area).toBe("state:AP");
  });
});
