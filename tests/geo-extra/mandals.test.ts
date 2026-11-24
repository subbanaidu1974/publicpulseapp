import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiRouter, loadDatasets } from "../../server/api";
import { geomErrors } from "../../pipeline/geo/geometry";
import { interiorPoint, matchMandals, MATCH_THRESHOLD, parseOsmMandals, pointInGeom, stripMandalWord } from "../../pipeline/geo/mandals";

const GEO = path.join(process.cwd(), "data", "generated", "geo");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(GEO, f), "utf8"));
const sq = (x: number, y: number, s = 1) => ({ type: "Polygon" as const, coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });

const districts = [{ code: "D1", name: "Alpha" }, { code: "D2", name: "Beta" }];
const dPolys = [{ code: "D1", geometry: sq(78, 15, 2) }, { code: "D2", geometry: sq(80, 15, 2) }];
const lgd = [
  { code: "1", name: "Rampur", districtCode: "D1" },
  { code: "2", name: "Kothapalli", districtCode: "D1" },
  { code: "3", name: "Kothapalli", districtCode: "D2" },
  { code: "4", name: "Vajrapukotturu", districtCode: "D1" },
  { code: "5", name: "Solo", districtCode: "D2" },
];
const o = (rel: number, en: string, district: string, g: ReturnType<typeof sq>) => ({ qid: "Q" + rel, en, district, osmRel: rel, geometry: g });

describe("@E2E-104 mandal join to LGD", () => {
  it("parses Wikidata rows and strips the mandal suffix", () => {
    const rows = parseOsmMandals({ results: { bindings: [
      { item: { value: "http://www.wikidata.org/entity/Q1" }, en: { value: "Gooty mandal" }, o: { value: "123" }, parentLabel: { value: "Anantapuramu district" } },
      { item: { value: "http://www.wikidata.org/entity/Q2" }, en: { value: "No OSM" } },
    ] } });
    expect(rows).toEqual([{ qid: "Q1", en: "Gooty", district: "Anantapuramu", osmRel: 123 }]);
    expect(stripMandalWord("Kalyandurg revenue mandal")).toBe("Kalyandurg");
  });

  it("exact unique name with the district confirmed gets confidence 1 and ships", () => {
    const r = matchMandals([o(10, "Rampur", "Alpha", sq(78.5, 15.5, 0.5))], lgd, districts, dPolys);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ lgdCode: "1", confidence: 1 });
  });

  it("a name shared by two mandals is resolved only by district evidence (0.9), otherwise rejected", () => {
    const ok = matchMandals([o(11, "Kothapalli", "Beta", sq(80.5, 15.5, 0.5))], lgd, districts, dPolys);
    expect(ok.matches[0]).toMatchObject({ lgdCode: "3", confidence: 0.9 });
    const none = matchMandals([o(12, "Kothapalli", "", sq(90, 20, 0.5))], lgd, districts, dPolys);
    expect(none.matches).toHaveLength(0);
    expect(none.rejected[0].reason).toMatch(/shared by 2/);
  });

  it("a name match contradicted by the polygon location is not shipped", () => {
    // 'Rampur' belongs to D1 but the polygon sits in D2 and the parent label says Beta
    const r = matchMandals([o(13, "Rampur", "Beta", sq(80.5, 15.5, 0.5))], lgd, districts, dPolys);
    expect(r.matches).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/contradicts/);
  });

  it("transliteration-level fuzzy matches stay below the threshold and are reported, not shipped", () => {
    const r = matchMandals([o(14, "Vajrapukothuru", "Alpha", sq(78.5, 16, 0.5))], lgd, districts, dPolys);
    expect(MATCH_THRESHOLD).toBe(0.8);
    expect(r.matches).toHaveLength(0);
    expect(r.rejected[0]).toMatchObject({ confidence: 0.7, lgdCandidates: ["4 Vajrapukotturu"] });
  });

  it("two OSM relations claiming one LGD mandal ship nothing for it", () => {
    const r = matchMandals([o(15, "Solo", "Beta", sq(80.2, 15.2, 0.3)), o(16, "Solo", "Beta", sq(80.6, 15.6, 0.3))], lgd, districts, dPolys);
    expect(r.matches).toHaveLength(0);
    expect(r.rejected.map(x => x.reason).join()).toMatch(/claimed by 2/);
    expect(r.lgdUnmatched.map(u => u.code)).toContain("5");
  });

  it("interior point lies inside a concave polygon", () => {
    const L = { type: "Polygon" as const, coordinates: [[[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10], [0, 0]]] };
    expect(pointInGeom(interiorPoint(L), L)).toBe(true);
  });
});

describe("@E2E-104 shipped mandal polygons", () => {
  for (const [st, total] of [["AP", 688], ["TG", 621]] as const) {
    it(`${st}: every polygon is valid, unique, known to LGD and matched at or above the threshold`, () => {
      const fc = read(`mandal-${st}.geojson`);
      const lgd = read(`lgd-${st}.json`);
      const known = new Set((lgd.mandals as string[][]).map(m => m[0]));
      expect(lgd.mandals).toHaveLength(total);
      expect(fc.license).toBe("ODbL-1.0");
      expect(fc.attribution).toMatch(/OpenStreetMap contributors, ODbL/);
      const seen = new Set<string>();
      for (const f of fc.features) {
        expect(geomErrors(f.geometry), f.properties.name).toEqual([]);
        expect(f.properties.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
        expect(known.has(f.properties.lgdCode)).toBe(true);
        expect(seen.has(f.properties.lgdCode)).toBe(false);
        seen.add(f.properties.lgdCode);
      }
      expect(fc.features.length).toBeGreaterThan(total * 0.6);
    });
    it(`${st}: the coverage report agrees with the file and lists what was left out`, () => {
      const rep = read("mandal-coverage.json")[st];
      const fc = read(`mandal-${st}.geojson`);
      expect(rep.shipped).toBe(fc.features.length);
      expect(rep.lgdMandals).toBe(total);
      expect(rep.coveragePct).toBeCloseTo((fc.features.length / total) * 100, 0);
      expect(rep.lgdUnmatched.length).toBe(total - fc.features.length);
      expect(Array.isArray(rep.rejected)).toBe(true);
    });
  }
});

describe("@E2E-104 GET /geo/:state/mandal.geojson", () => {
  let server: Server, base: string;
  beforeAll(() => {
    const app = express();
    app.use("/api/v1", createApiRouter(loadDatasets()));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => { server.close(); });

  it("serves the polygons with ETag, geo+json and the boundary version header", async () => {
    const r = await fetch(`${base}/geo/AP/mandal.geojson`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/geo\+json/);
    expect(r.headers.get("x-boundary-version")).toBe("delimitation-2008");
    const body = await r.json();
    expect(body.features.length).toBe(read("mandal-AP.geojson").features.length);
    expect(body.attribution).toMatch(/OpenStreetMap/);
    const again = await fetch(`${base}/geo/AP/mandal.geojson`, { headers: { "If-None-Match": r.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });
  it("404s for an unknown state", async () => {
    const r = await fetch(`${base}/geo/XX/mandal.geojson`);
    expect(r.status).toBe(404);
  });
});
