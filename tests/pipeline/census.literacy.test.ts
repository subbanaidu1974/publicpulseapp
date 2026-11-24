import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { literacyRate, parseUnitRows, pcaRecord, rollupDistricts, rollupSubDistricts, validatePca, type CensusUnit } from "../../pipeline/census";
import { applyPcaLiteracy } from "../../pipeline/pca";

const gen = (f: string) => JSON.parse(readFileSync(resolve(__dirname, "../../data/generated", f), "utf8"));
const pca = (o: Record<string, string>) => pcaRecord({ Level: "VILLAGE", TRU: "Rural", District: "542", Subdistt: "04001", "Town/Village": "100", Name: "V", TOT_P: "100", TOT_M: "50", TOT_F: "50", P_06: "10", P_LIT: "60", M_LIT: "35", F_LIT: "25", ...o })!;
const unit = (o: Partial<CensusUnit> = {}): CensusUnit => ({ kind: "V", state: "AP", districtCode: "542", district: "Srikakulam", subDistrictCode: "04001", subDistrict: "S", code: "100", name: "V", households: 20, population: 100, males: 50, females: 50, scPop: 0, stPop: 0, ...o });

describe("@E2E-99 census literacy (PCA merge)", () => {
  it("uses the official rate: literates over the population aged 7+", () => {
    expect(literacyRate(60, 100, 10)).toBe(66.67);
    expect(literacyRate(95, 100, 10)).toBeNull();
    expect(literacyRate(0, 10, 10)).toBeNull();
  });
  it("parses PCA rows, skips wards and bad rows, and flags inconsistent ones", () => {
    expect(pca({}).literate).toBe(60);
    expect(pcaRecord({ Level: "WARD", TRU: "Urban", District: "542" })).toBeNull();
    expect(pcaRecord({ Level: "VILLAGE", TRU: "Rural", District: "999", TOT_P: "1" })).toBeNull();
    expect(validatePca([pca({})])).toEqual([]);
    expect(validatePca([pca({ P_LIT: "95", M_LIT: "50", F_LIT: "45" })]).length).toBe(1);
  });
  it("merges only when the PCA population equals the DCHB population and never invents values", () => {
    const ok = unit(), mismatch = unit({ code: "101", population: 90 }), missing = unit({ code: "102" });
    const r = applyPcaLiteracy([ok, mismatch, missing], [pca({}), pca({ "Town/Village": "101" })]);
    expect(r).toMatchObject({ matched: 1 });
    expect(r.mismatched).toHaveLength(1);
    expect(r.missing).toHaveLength(1);
    expect(ok).toMatchObject({ literate: 60, pop0to6: 10 });
    expect(mismatch.literate).toBeUndefined();
  });
  it("rolls literacy up only where every unit carries it", () => {
    const a = unit({ literate: 60, pop0to6: 10 }), b = unit({ code: "2", literate: 30, pop0to6: 20 }), c = unit({ code: "3" });
    expect(rollupDistricts([a, b], "s")[0]).toMatchObject({ literate: 90, literacyPct: 52.94 });
    expect(rollupDistricts([a, b, c], "s")[0]).toMatchObject({ literate: null, literacyPct: null });
    expect(rollupSubDistricts([a, b])[0].literacyPct).toBeCloseTo(52.94, 2);
    expect(rollupSubDistricts([a, b, c])[0].literate).toBeUndefined();
  });
  it("committed snapshots carry real district literacy (spot checks against Census 2011) and unit columns round-trip", () => {
    const d = gen("census.json").districts as { district: string; literate: number; literacyPct: number; pop0to6: number; population: number }[];
    expect(d).toHaveLength(23);
    expect(d.every(x => x.literate > 0 && x.literacyPct > 40 && x.literacyPct < 95)).toBe(true);
    expect(d.find(x => x.district === "Srikakulam")).toMatchObject({ literate: 1495381, pop0to6: 281037, literacyPct: 61.74 });
    const u = gen("census-units.json");
    const units = parseUnitRows(u.columns, u.units);
    const withLit = units.filter(x => x.literate !== undefined);
    expect(withLit.length).toBeGreaterThan(28000);
    expect(withLit.every(x => x.literate! <= x.population - x.pop0to6!)).toBe(true);
    const s = gen("census-subdistricts.json").subDistricts as { literate?: number }[];
    expect(s.filter(x => x.literate !== undefined).length).toBeGreaterThan(1000);
  });
});
