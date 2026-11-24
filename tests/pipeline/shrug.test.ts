import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPack, joinFeature, mergeRow, newReport, shrugKey, simplifyVillage, SHRUG_ATTRIBUTION_EN, type JoinContext, type LgdVillageRef, type PolyRow } from "../../pipeline/geo/shrug";
import { geomErrors, type Geom } from "../../pipeline/geo/geometry";
import { commercialViolations, isCommercial, ncSaInUse } from "../../pipeline/compliance";

const sq = (x: number, y: number, s: number): Geom => ({ type: "Polygon", coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });
const props = (tv: string, d = "532", s = "28", name = "V") => ({ pc11_s_id: s, pc11_d_id: d, pc11_sd_id: "04305", pc11_tv_id: tv, tv_name: name });
const v = (code: string, census: string, mandalCode: string, state: "AP" | "TG" = "TG"): LgdVillageRef => ({ code, name: `n${code}`, mandalCode, state, census });
const ctx = (): JoinContext => ({
  byCensus: new Map([["568945", v("1", "568945", "4305")], ["568946", v("2", "568946", "4305")], ["579013", v("3", "579013", "9", "AP")]]),
  censusLoc: new Map([["568945", { district: "532", subDistrict: "04305" }], ["568946", { district: "532", subDistrict: "04305" }], ["579013", { district: "545", subDistrict: "04500" }]]),
  townCodes: new Set(["802900"]),
});

describe("S-90 SHRUG village polygon join (synthetic fixture)", () => {
  it("reads Census ids from shapefile and GeoPackage style properties, zero padded", () => {
    expect(shrugKey({ pc11_s_id: "28", pc11_d_id: "532", pc11_sd_id: "4305", pc11_tv_id: "568945" })).toEqual({ state: "28", district: "532", subDistrict: "04305", tv: "568945" });
    expect(shrugKey({ pc11_state_id: 28, pc11_district_id: 532, pc11_subdistrict_id: "04305", pc11_village_id: "000042" })?.tv).toBe("000042");
    expect(shrugKey({})).toBeNull();
  });
  it("keeps state 28 villages matched by census code, counts towns, unmatched and district mismatches, skips other states", () => {
    const rep = newReport(), c = ctx();
    const rows: (PolyRow | null)[] = [
      joinFeature({ properties: props("568945"), geometry: sq(78.3, 19.7, 0.01) }, c, rep),
      joinFeature({ properties: props("568946", "999"), geometry: sq(78.4, 19.7, 0.01) }, c, rep),
      joinFeature({ properties: props("123456"), geometry: sq(78.5, 19.7, 0.01) }, c, rep),
      joinFeature({ properties: props("802900"), geometry: sq(78.6, 19.7, 0.01) }, c, rep),
      joinFeature({ properties: props("000001", "001", "01"), geometry: sq(74, 34, 0.01) }, c, rep),
      joinFeature({ properties: props("579013", "545"), geometry: sq(80, 15, 0.02) }, c, rep),
    ];
    expect(rows.filter(Boolean)).toHaveLength(2);
    expect(rows[0]).toMatchObject({ lgdCode: "1", mandalCode: "4305" });
    expect(rep).toMatchObject({ featuresRead: 6, featuresInAndhra: 5, matched: 2, districtMismatch: 1, unmatchedPolygons: 1, unmatchedTowns: 1 });
    expect(rep.unmatchedSample[0].tv).toBe("123456");
  });
  it("simplifies tiny and large polygons to valid geometry and merges split villages into a MultiPolygon", () => {
    const ring = Array.from({ length: 400 }, (_, i) => [78 + 0.05 * Math.cos((i / 400) * 2 * Math.PI), 18 + 0.05 * Math.sin((i / 400) * 2 * Math.PI)]);
    ring.push([...ring[0]]);
    const s = simplifyVillage({ type: "Polygon", coordinates: [ring] } as Geom)!;
    expect(geomErrors(s)).toEqual([]);
    expect((s.coordinates[0] as unknown[]).length).toBeLessThan(200);
    expect(simplifyVillage(sq(78, 18, 0.0004))).not.toBeNull();
    const rep = newReport(), map = new Map<string, PolyRow>();
    const c = ctx();
    for (const g of [sq(78.3, 19.7, 0.01), sq(78.31, 19.71, 0.01)]) mergeRow(map, joinFeature({ properties: props("568945"), geometry: g }, c, rep)!, rep);
    expect(map.size).toBe(1);
    expect(map.get("1")!.geometry.type).toBe("MultiPolygon");
    expect(rep.duplicatePolygons).toBe(1);
  });
  it("builds a licence-flagged pack sorted by mandal with the required attribution", () => {
    const rows: PolyRow[] = [
      { lgdCode: "2", censusCode: "2", mandalCode: "10", name: "b", shrugName: "b", geometry: sq(78, 18, 0.01) },
      { lgdCode: "1", censusCode: "1", mandalCode: "9", name: "a", shrugName: "a", geometry: sq(78, 18, 0.01) },
    ];
    const p = buildPack("TG", rows, { asOf: "2011-03-01", file: "x.shp", sha256: null });
    expect(p.villages.map(r => r[0])).toEqual(["1", "2"]);
    expect(p).toMatchObject({ licence: "shrug-cc-by-nc-sa", nonCommercial: true, attribution: SHRUG_ATTRIBUTION_EN });
    expect(p.vintage).toMatch(/2011/);
  });
  it("the ingest script exits with instructions when the files are absent", () => {
    const d = mkdtempSync(join(tmpdir(), "shrug-empty-"));
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/ingest-shrug.ts", "--dir", d], { cwd: join(__dirname, "../.."), encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/SHRUG_DOWNLOAD\.md/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60000);
});

describe("S-90 non-commercial compliance guard", () => {
  const fixture = (lic: Record<string, unknown>, datasets: { id: string; licences: string[] }[]) => {
    const root = mkdtempSync(join(tmpdir(), "nc-"));
    mkdirSync(join(root, "data/reference"), { recursive: true });
    mkdirSync(join(root, "gen"), { recursive: true });
    writeFileSync(join(root, "data/reference/licences.json"), JSON.stringify({ licences: lic }));
    writeFileSync(join(root, "gen/manifest.json"), JSON.stringify({ schema: 1, datasets }));
    return root;
  };
  it("flags NC/SA datasets in use only when COMMERCIAL_USE is set", () => {
    const root = fixture({ "x-nc": { nonCommercial: true, constraints: [] }, "y-open": { constraints: ["attribution"] }, "z-sa": { constraints: ["share-alike"] } }, [{ id: "d1", licences: ["x-nc", "y-open"] }, { id: "d2", licences: ["y-open"] }]);
    try {
      expect(ncSaInUse(root, join(root, "gen")).map(x => x.key)).toEqual(["x-nc"]);
      expect(commercialViolations({}, root, join(root, "gen"))).toEqual([]);
      expect(commercialViolations({ COMMERCIAL_USE: "0" }, root, join(root, "gen"))).toEqual([]);
      expect(commercialViolations({ COMMERCIAL_USE: "1" }, root, join(root, "gen"))[0]).toMatch(/x-nc.*d1/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("the real register carries the SHRUG layer as NC and SA, so COMMERCIAL_USE=1 must fail", () => {
    const used = ncSaInUse().find(x => x.key === "shrug-cc-by-nc-sa");
    expect(used?.datasets).toEqual(expect.arrayContaining(["geo-villages-shrug-AP", "geo-villages-shrug-TG"]));
    expect(commercialViolations({ COMMERCIAL_USE: "1" }).join("\n")).toMatch(/shrug-cc-by-nc-sa/);
  });
  it("fails when this environment itself sets COMMERCIAL_USE while NC/SA datasets are shipped", () => {
    expect(isCommercial()).toBe(false);
    expect(commercialViolations(process.env)).toEqual([]);
  });
});
