import { describe, expect, it } from "vitest";
import { distKm, matchOsm, matchWikidata, parseOverpassNodes, parseWikidataVillages, parseWktPoint } from "../../pipeline/geo/villagepoints";

const sq = (x: number, y: number, s = 1) => ({ type: "Polygon" as const, coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });
const dPolys = [{ code: "D1", geometry: sq(78, 15, 2) }, { code: "D2", geometry: sq(80, 15, 2) }];
const mPolys = [{ code: "M1", geometry: sq(78, 15, 1) }];
const mandals = [{ code: "M1", districtCode: "D1" }, { code: "M2", districtCode: "D1" }, { code: "M3", districtCode: "D2" }];
const lgd = [
  { code: "1", name: "Rampur", mandalCode: "M1", census: "111" },
  { code: "2", name: "Kothapalli", mandalCode: "M1", census: "112" },
  { code: "3", name: "Kothapalli", mandalCode: "M2", census: "113" },
  { code: "4", name: "Solo (ST)", mandalCode: "M3", census: "0" },
];
const wdRow = (q: string, cen: string, co: string) => ({ item: { value: "http://www.wikidata.org/entity/" + q }, cen: { value: cen }, co: { value: co } });

describe("@E2E-105 village points (S-90, licence-compatible sources only)", () => {
  it("parses WKT points and Wikidata rows, dropping malformed ones", () => {
    expect(parseWktPoint("Point(79.5 15.25)")).toEqual([79.5, 15.25]);
    expect(parseWktPoint("garbage")).toBeNull();
    const rows = parseWikidataVillages({ results: { bindings: [wdRow("Q1", "111", "Point(78.5 15.5)"), wdRow("Q2", "abc", "Point(78.5 15.5)"), wdRow("Q3", "5", "nope")] } });
    expect(rows).toEqual([{ qid: "Q1", census: "111", lon: 78.5, lat: 15.5 }]);
  });

  it("joins Wikidata by census code and rejects out-of-district, unknown and disagreeing codes", () => {
    const wd = [
      { qid: "Q1", census: "111", lon: 78.5, lat: 15.5 },
      { qid: "Q2", census: "112", lon: 81, lat: 15.5 }, // lies in D2, village is in D1
      { qid: "Q3", census: "999", lon: 78.5, lat: 15.5 }, // not an LGD village
      { qid: "Q4", census: "113", lon: 78.5, lat: 16.5 }, { qid: "Q5", census: "113", lon: 79.5, lat: 16.5 }, // > 2 km apart
    ];
    const r = matchWikidata(wd, lgd, mandals, dPolys);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ lgdCode: "1", confidence: 1, ref: "Q1" });
    expect(r.counts).toMatchObject({ matched: 1, outsideDistrict: 1, notInLgd: 1, ambiguous: 1 });
  });

  it("OSM fills only villages without a Wikidata point; ambiguous names are not shipped", () => {
    const nodes = parseOverpassNodes({ elements: [
      { type: "node", id: 1, lat: 15.5, lon: 78.5, tags: { name: "Rampur", place: "village" } },
      { type: "node", id: 2, lat: 15.6, lon: 78.6, tags: { name: "Kothapalli", place: "hamlet" } }, // M1 polygon: unique in M1
      { type: "node", id: 3, lat: 16.5, lon: 78.5, tags: { name: "Kothapalli", place: "village" } }, // D1, no mandal polygon: 2 candidates
      { type: "node", id: 4, lat: 15.5, lon: 78.55, tags: { "name:en": "Nowhere", place: "village" } },
      { type: "node", id: 5, lat: 15.5, lon: 78.5, tags: { name: "Bus stop", place: "locality" } },
    ] });
    expect(nodes).toHaveLength(4);
    const r = matchOsm(nodes, lgd, mandals, mPolys, dPolys, new Map([["1", [78.5, 15.5] as [number, number]]]));
    expect(r.rows.map(x => [x.lgdCode, x.confidence])).toEqual([["2", 0.9]]);
    expect(r.counts).toMatchObject({ matched: 1, skippedAlreadyHavePoint: 1, ambiguous: 1, unmatched: 1 });
    expect(r.agreement.pairs).toBe(1);
    expect(r.agreement.medianKm).toBe(0);
  });

  it("distance helper is sane", () => {
    expect(distKm([78, 15], [78, 16])).toBeGreaterThan(110);
    expect(distKm([78, 15], [78, 16])).toBeLessThan(112);
  });
});
