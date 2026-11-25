import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { panchayatResponse, validatePanchayatFile } from "../../src/lib/panchayat";

const good = () => ({
  state: "TG",
  source: { publisher: "Test commission", url: "https://example.org/r", licence: "test-licence", terms: "reuse with credit", retrieved: "2026-11-25" },
  elections: [{ id: "tg-gp-2025", level: "gp", year: 2025, phases: ["2025-12-11"], units: [{ name: "Unit A", district: "D1", posts: 8, unopposed: true }, { name: "Unit B", district: "D1", posts: 10, turnoutPct: 80.5 }] }],
});

describe("@E2E-212 panchayat data format", () => {
  it("no results file is committed yet, so the response says not loaded", () => {
    expect(existsSync("data/reference/panchayat/results-TG.json")).toBe(false);
    expect(existsSync("data/reference/panchayat/results-AP.json")).toBe(false);
    const r = panchayatResponse("TG", null);
    expect(r.loaded).toBe(false);
    expect(r.elections).toEqual([]);
    expect(r.levels).toEqual(["gp", "mptc", "zptc"]);
  });
  it("a well-formed file is accepted and summarised", () => {
    expect(validatePanchayatFile(good(), "TG")).toEqual([]);
    const r = panchayatResponse("TG", good());
    expect(r.loaded).toBe(true);
    expect(r.elections[0]).toMatchObject({ units: 2, posts: 18, unopposed: 1 });
  });
  it("refuses a file for the wrong state, without a source licence, or with bad values", () => {
    expect(validatePanchayatFile(good(), "AP").join()).toMatch(/expected AP/);
    const noLic = good(); noLic.source.licence = "";
    expect(validatePanchayatFile(noLic, "TG").join()).toMatch(/source needs/);
    const bad = good(); bad.elections[0].units[0].posts = 0; bad.elections[0].units[1].turnoutPct = 140; bad.elections[0].phases = ["11 Dec"];
    const p = validatePanchayatFile(bad, "TG").join();
    expect(p).toMatch(/posts/); expect(p).toMatch(/turnoutPct/); expect(p).toMatch(/phases/);
    expect(panchayatResponse("TG", bad).loaded).toBe(false);
  });
  it("refuses any voter-level or personal field", () => {
    for (const key of ["voterId", "epic_no", "electors", "rollNo", "mobile", "address"]) {
      const f = good() as any; f.elections[0].units[0][key] = "x";
      expect(validatePanchayatFile(f, "TG").join(), key).toMatch(/not accepted/);
    }
  });
});
