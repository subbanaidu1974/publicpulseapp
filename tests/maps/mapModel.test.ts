import { describe, expect, it } from "vitest";
import { acsInDistrict, binColor, buildHash, buildRows, districtTally, leader, makeBins, nameKey, parseHash, partyInfo, populationByDistrict, sortRows, MIN_CELL, type MetricCtx } from "../../src/components/maps/mapModel";

describe("hash routing (@E2E-112)", () => {
  it("round-trips state, district and constituency", () => {
    for (const h of ["#/map/TG", "#/map/TG/ac", "#/map/AP/pc/3", "#/map/TG/district/501", "#/map/TG/district/501/ac/12", "#/map/TG/ac/7"]) {
      const r = parseHash(h)!;
      expect(r).not.toBeNull();
      expect(buildHash(r)).toBe(h);
    }
  });
  it("rejects other hashes and bad input", () => {
    expect(parseHash("#/other")).toBeNull();
    expect(parseHash("#/map/XX")).toBeNull();
    expect(parseHash("#/map/TG/district")).toBeNull();
    expect(parseHash("#/map/TG/bogus/1")).toBeNull();
  });
  it("state view is the district level; a district implies constituencies", () => {
    expect(parseHash("#/map/TG")!.level).toBe("district");
    expect(parseHash("#/map/TG/district/501")).toMatchObject({ level: "ac", district: "501" });
  });
});

describe("colours (@E2E-111)", () => {
  it("uses the registry colour and a neutral bucket for unknown parties", () => {
    expect(partyInfo("TDP").color).toBe("#9a7400");
    expect(partyInfo("TELUGU DESAM PARTY").code).toBe("TDP");
    const u = partyInfo("XYZ");
    expect(u.known).toBe(false);
    expect(u.color).toBe("#6b6b6b");
  });
  it("bins cover the range and missing values are neutral", () => {
    const b = makeBins(0, 50);
    expect(b).toHaveLength(5);
    expect(binColor(b, 0)).toBe(b[0].color);
    expect(binColor(b, 50)).toBe(b[4].color);
    expect(binColor(b, null)).not.toBe(b[0].color);
    expect(makeBins(5, 5)).toHaveLength(1);
  });
});

const feats = [
  { properties: { acNo: 1, acName: "A", reservation: "SC", district: "D1", districtLgd: "501" } },
  { properties: { acNo: 2, acName: "B", reservation: "GEN", district: "D1", districtLgd: "501" } },
  { properties: { acNo: 3, acName: "C", reservation: "GEN", district: "D2", districtLgd: "502" } },
];
const seats = new Map([[1, { acNo: 1, winnerParty: "TDP", marginPct: 10, turnout: 80 }], [2, { acNo: 2, winnerParty: "INC", marginPct: 2 }], [3, { acNo: 3, winnerParty: "TDP", marginPct: 30, turnout: 70 }]]);
const ctx = (metric: MetricCtx["metric"], extra: Partial<MetricCtx> = {}): MetricCtx => ({ metric, seats, tally: districtTally(feats, seats), population: null, issues: null, tied: "Tied", noData: "No data", ...extra });

describe("rows", () => {
  it("district winner: tie is never given a colour", () => {
    expect(leader({ A: 1, B: 1 })).toBe("tied");
    expect(leader({})).toBeNull();
    const d = buildRows("district", [{ properties: { district: "D1", districtLgd: "501" } }, { properties: { district: "D2", districtLgd: "502" } }], ctx("winner"));
    expect(d.rows[0].text).toBe("Tied");
    expect(d.rows[0].category).toBeUndefined();
    expect(d.rows[1].category).toBe("TDP");
  });
  it("margin and turnout: missing values are 'No data' and last when sorted", () => {
    const t = buildRows("ac", feats, ctx("turnout"));
    expect(t.rows[1].text).toBe("No data");
    expect(t.coverage).toBeCloseTo(2 / 3);
    const sorted = sortRows(t.rows, "value", -1);
    expect(sorted.map((r) => r.name)).toEqual(["A", "C", "B"]);
    expect(sortRows(t.rows, "value", 1).map((r) => r.name)).toEqual(["C", "A", "B"]);
    expect(sortRows(t.rows, "name", -1).map((r) => r.name)).toEqual(["C", "B", "A"]);
  });
  it("reservation is categorical with text always present", () => {
    const r = buildRows("ac", feats, ctx("reservation"));
    expect(r.rows.map((x) => x.text)).toEqual(["SC", "GEN", "GEN"]);
  });
  it("population joins by normalised district name and leaves unmatched districts empty", () => {
    expect(nameKey("Y.S.R. Kadapa")).toBe("kadapa");
    const pop = populationByDistrict([{ district: "Alpha District", population: 1000 }, { district: "Z", population: null }]);
    const r = buildRows("district", [{ properties: { district: "Alpha", districtLgd: "501" } }, { properties: { district: "Beta", districtLgd: "502" } }], ctx("population", { population: pop }));
    expect(r.rows[0].value).toBe(1000);
    expect(r.rows[1].value).toBeNull();
    expect(r.coverage).toBe(0.5);
  });
  it("issue cells under the minimum are suppressed", () => {
    const r = buildRows("district", [{ properties: { district: "D1", districtLgd: "501" } }, { properties: { district: "D2", districtLgd: "502" } }], ctx("issues", { issues: { "501": MIN_CELL - 1, "502": MIN_CELL } }));
    expect(r.rows[0].value).toBeNull();
    expect(r.rows[1].value).toBe(MIN_CELL);
  });
  it("drill-down filters constituencies by district", () => {
    expect(acsInDistrict(feats, "501").map((f) => f.properties.acNo)).toEqual([1, 2]);
  });
});
