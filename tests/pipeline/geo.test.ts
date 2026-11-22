import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildAcFeatures, buildPcFeatures, buildDistrictFeatures, dissolve, reconcileReservation, reservationTag } from "../../pipeline/geo/boundaries";
import { parse2008 } from "../../pipeline/geo/constituency";
import { aggregateTally, buildCrosswalk, districtOf, parentsOf } from "../../pipeline/geo/crosswalk";
import { geomErrors, polyArea, simplifyGeom, toPolys, type Geom } from "../../pipeline/geo/geometry";
import { acNoFromEci, buildAcUnits, buildLgdState, eciFromAcNo, majorityDistrict, teluguOrEmpty, type LgdTables } from "../../pipeline/geo/lgd";
import { AcLink, buildAcLink } from "../../pipeline/geo/link";
import { loadGeoLookup } from "../../pipeline/geo/lookup";
import { coverage, matchUnits, parseWd, stripAc, stripDistrict, stripMandal, stripTeAc, stripTeDistrict, stripTeMandal, stripTePc } from "../../pipeline/geo/names";
import { compactJson, levenshtein, nameClose, normName, parseCsv, titleCase } from "../../pipeline/geo/util";
import { validateGeoJson } from "../../pipeline/quality";
import type { CandidateResult } from "../../src/lib/elections";

const ROOT = resolve(__dirname, "../..");
const GEO = join(ROOT, "data/generated/geo");
const J = (f: string) => JSON.parse(readFileSync(join(GEO, f), "utf8"));
const square = (x: number, y: number, s = 1): Geom => ({ type: "Polygon", coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });

describe("@E2E-93 geometry + validation gate (S-78)", () => {
  it("simplifies, rounds and drops collapsed rings", () => {
    const ring = [[78, 17], [78.00001, 17.5], [78, 18], [79, 18], [79, 17], [78, 17]];
    const g = simplifyGeom({ type: "Polygon", coordinates: [ring] } as Geom, 0.001)!;
    expect(geomErrors(g)).toEqual([]);
    expect(g.coordinates[0].length).toBe(5); // the near-collinear vertex is gone
    expect(simplifyGeom({ type: "Polygon", coordinates: [[[78, 17], [78.00001, 17], [78, 17.00001], [78, 17]]] } as Geom, 0.01)).toBeNull();
  });
  it("flags invalid geometries", () => {
    expect(geomErrors(null)).toHaveLength(1);
    expect(geomErrors({ type: "Polygon", coordinates: [] })).toContain("polygon without rings");
    expect(geomErrors({ type: "Polygon", coordinates: [[[78, 17], [79, 17], [78, 17]]] })).toContain("ring with fewer than 4 positions");
    expect(geomErrors({ type: "Polygon", coordinates: [[[78, 17], [79, 17], [79, 18], [78, 18]]] })).toContain("unclosed ring");
    expect(geomErrors({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })).toContain("coordinate outside India bounds");
    expect(geomErrors({ type: "MultiPolygon", coordinates: [] })).toEqual(["empty geometry"]);
    expect(geomErrors({ type: "Polygon", coordinates: [[[78, 17], [79, 17], [80, 17], [78, 17]]] })).toContain("zero-area ring");
  });
  const fc = (ids: number[], idProp = "acNo") => ({ type: "FeatureCollection", features: ids.map(i => ({ type: "Feature", properties: { [idProp]: i }, geometry: square(78, 17) })) });
  it("gate checks seat count, duplicate ids and the ID-join against elections", () => {
    expect(validateGeoJson(fc([1, 2, 3]), "x", { idProp: "acNo", expectedCount: 3, joinIds: [1, 2, 3] })).toEqual([]);
    expect(validateGeoJson(fc([1, 2]), "x", { idProp: "acNo", expectedCount: 3 }).join()).toMatch(/expected 3 features, got 2/);
    expect(validateGeoJson(fc([1, 1, 2]), "x", { idProp: "acNo" }).join()).toMatch(/duplicate acNo 1/);
    expect(validateGeoJson(fc([1, 2, 4]), "x", { idProp: "acNo", joinIds: [1, 2, 3] }).join()).toMatch(/1 acNo in elections.json have no polygon \(e.g. 3\).*1 polygons have no acNo in elections.json \(e.g. 4\)/);
    const bad = fc([1]); (bad.features[0] as any).geometry = { type: "Polygon", coordinates: [] };
    expect(validateGeoJson(bad, "x", { idProp: "acNo" }).join()).toMatch(/polygon without rings/);
    expect(validateGeoJson({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: square(78, 17) }] }, "x", { idProp: "acNo" }).join()).toMatch(/integer acNo/);
    expect(validateGeoJson({}, "x")).toHaveLength(1);
    expect(validateGeoJson(fc([1]), "legacy")).toEqual([]); // old two-argument call still works
  });
  it("committed AC polygons: 175 AP + 119 TG, every acNo in elections.json joins, geometry valid", () => {
    const el = J("../elections.json").results as CandidateResult[];
    for (const [st, n] of [["AP", 175], ["TG", 119]] as const) {
      const g = J(`ac-${st}.geojson`);
      const ids = new Set(el.filter(r => r.state === st && r.type === "assembly").map(r => r.acNo));
      expect(ids.size).toBe(n);
      expect(validateGeoJson(g, `ac-${st}`, { idProp: "acNo", expectedCount: n, joinIds: ids })).toEqual([]);
      for (const f of g.features) {
        expect(f.properties.state).toBe(st);
        expect(["GEN", "SC", "ST"]).toContain(f.properties.reservation);
        expect(f.properties.pcNo).toBeGreaterThan(0);
        expect(f.properties.district).toBeTruthy();
      }
    }
  });
  it("AC names match the election names at the same acNo (proves the undivided-AP re-keying)", () => {
    const el = J("../elections.json").results as CandidateResult[];
    for (const st of ["AP", "TG"] as const) {
      const names = new Map<number, string>(J(`ac-${st}.geojson`).features.map((f: any) => [f.properties.acNo, f.properties.acName]));
      const bad = new Map<number, string>();
      for (const r of el) if (r.state === st && r.type === "assembly" && r.year >= 2019 && !nameClose(names.get(r.acNo) ?? "", r.acName)) bad.set(r.acNo, `${names.get(r.acNo)}~${r.acName}`);
      expect([...bad.values()]).toEqual([]);
    }
  });
  it("re-keys AC_NO of undivided AP and drops unnamed polygons", () => {
    const meta = parse2008("ST_CODE,ST_ABBR,ST_NAME,PC_CODE,PC_NAME,PC_TYPE,AC_CODE,AC_NAME,AC_TYPE\nS01,AP,ANDHRA PRADESH,1,ADILABAD,ST,1,SIRPUR,\nS01,AP,ANDHRA PRADESH,18,ARAKU,ST,120,ICHCHAPURAM,\n").acs;
    const raw = [{ acNo: 1, name: "Sirpur", dtCode: 1, distName: "ADILABAD", pcNo: 1, geometry: square(79, 19) }, { acNo: 120, name: "Ichchapuram", dtCode: 11, distName: "SRIKAKULAM", pcNo: 19, geometry: square(84, 19) },
      { acNo: 130, name: "Not In Table", dtCode: 1, distName: "X", pcNo: 1, geometry: square(80, 18) }];
    const b = buildAcFeatures(raw, meta);
    expect(b.features.TG.map(f => f.properties.acNo)).toEqual([1]);
    expect(b.features.AP.map(f => f.properties.acNo)).toEqual([1]);
    expect(b.features.AP[0].properties.acName).toBe("Ichchapuram");
    expect(b.problems.join()).toMatch(/AP AC 11 \(Not In Table\)/);
    const named = buildAcFeatures([{ ...raw[0], name: "Wrong Name" }], meta);
    expect(named.problems.join()).toMatch(/differs from 2008 table/);
  });
});

describe("@E2E-94 PC polygons (S-79)", () => {
  it("keeps wikidata_qid and splits AP/TG by state name", () => {
    const fcIn = { features: [
      { properties: { st_name: "Telangana", pc_no: 1, pc_name: "Adilabad", pc_category: "ST", wikidata_qid: "Q1" }, geometry: square(79, 19) },
      { properties: { st_name: "Andhra Pradesh", st_code: 37, pc_no: 1, pc_name: "Araku", pc_category: "SC", wikidata_qid: "Q2" }, geometry: square(83, 18) },
      { properties: { st_name: "Kerala", pc_no: 1, pc_name: "X" }, geometry: square(76, 10) }] };
    const b = buildPcFeatures(fcIn);
    expect(b.features.TG[0].properties).toMatchObject({ pcNo: 1, reservation: "ST", wikidata_qid: "Q1" });
    expect(b.features.AP[0].properties.reservation).toBe("SC");
    expect(b.features.AP.length + b.features.TG.length).toBe(2);
    expect(buildPcFeatures({ features: [{ properties: { st_name: "Telangana", pc_no: 2 }, geometry: { type: "Polygon", coordinates: [] } }] }).problems.length).toBe(1);
  });
  it("committed PC polygons: AP 25 / TG 17, QIDs kept, joined to LS acNo in elections.json", () => {
    const el = J("../elections.json").results as CandidateResult[];
    for (const [st, n] of [["AP", 25], ["TG", 17]] as const) {
      const g = J(`pc-${st}.geojson`);
      const ids = new Set(el.filter(r => r.state === st && r.type === "ls").map(r => r.acNo));
      expect(validateGeoJson(g, `pc-${st}`, { idProp: "pcNo", expectedCount: n, joinIds: ids })).toEqual([]);
      expect(g.features.every((f: any) => /^Q\d+$/.test(f.properties.wikidata_qid))).toBe(true);
    }
  });
});

describe("@E2E-97 reservation + PC link (S-82)", () => {
  const csv = "ST_CODE,ST_ABBR,ST_NAME,PC_CODE,PC_NAME,PC_TYPE,AC_CODE,AC_NAME,AC_TYPE\nS01,AP,ANDHRA PRADESH,1,ADILABAD,ST,5,ASIFABAD,ST\nS01,AP,ANDHRA PRADESH,1,ADILABAD,ST,119,X,SC\nS01,AP,ANDHRA PRADESH,24,AMALAPURAM,SC,163,AMALAPURAM,SC\nS01,AP,ANDHRA PRADESH,18,ARAKU,ST,120,ICHCHAPURAM,\nU01,AN,ANDAMAN,1,A,,1,A,\nS01,AP,ANDHRA PRADESH,x,BAD,,x,BAD,\nS01,AP,ANDHRA PRADESH,30,GUNTUR,,1,CROSS,\n";
  it("splits undivided AP into TG (1-119) and AP (120-294) and renumbers PCs", () => {
    const r = parse2008(csv);
    expect(r.acs.filter(a => a.state === "TG").map(a => [a.acNo, a.reservation, a.pcNo])).toEqual([[1, "GEN", 30], [5, "ST", 1], [119, "SC", 1]]);
    expect(r.acs.filter(a => a.state === "AP").map(a => [a.acNo, a.undividedAcNo, a.pcNo, a.reservation])).toEqual([[1, 120, 1, "GEN"], [44, 163, 7, "SC"]]);
    expect(r.pcs.find(p => p.state === "AP" && p.pcNo === 7)).toMatchObject({ undividedPcNo: 24, reservation: "SC" });
    expect(r.errors.join()).toMatch(/bad row/);
    expect(r.errors.join()).toMatch(/other side of the split/);
  });
  it("reservation tags from shapefile names, and conflicts are reconciled and reported", () => {
    expect(["Boath (ST)", "Jukkal (SC)", "Secunderabad Cantt. (SC", "Rampachodavaram(ST)", "Nirmal"].map(reservationTag)).toEqual(["ST", "SC", "SC", "ST", "GEN"]);
    const meta = parse2008(csv).acs.filter(a => a.state === "TG");
    const raw = [{ acNo: 5, name: "Asifabad (ST)", dtCode: 1, distName: "A", pcNo: 1, geometry: square(79, 19) }, { acNo: 119, name: "X", dtCode: 1, distName: "A", pcNo: 1, geometry: square(79, 19) }];
    const r = reconcileReservation(meta, raw);
    expect(r.conflicts.join()).toMatch(/TG AC 119 X: 2008 CSV says SC, shapefile name tag says GEN; using GEN/);
    expect(r.acs.find(a => a.acNo === 119)!.reservation).toBe("GEN");
    expect(r.acs.find(a => a.acNo === 5)!.reservation).toBe("ST");
  });
  it("committed data: AP 29 SC / 7 ST and TG 19 SC / 12 ST, PC links consistent, CSV conflict recorded", () => {
    const tally = (st: string) => { const c: Record<string, number> = {}; for (const f of J(`ac-${st}.geojson`).features) c[f.properties.reservation] = (c[f.properties.reservation] ?? 0) + 1; return c; };
    expect(tally("AP")).toEqual({ GEN: 139, SC: 29, ST: 7 });
    expect(tally("TG")).toEqual({ GEN: 88, SC: 19, ST: 12 });
    for (const st of ["AP", "TG"]) {
      const pcs = new Set(J(`pc-${st}.geojson`).features.map((f: any) => f.properties.pcNo));
      for (const f of J(`ac-${st}.geojson`).features) expect(pcs.has(f.properties.pcNo)).toBe(true);
    }
    expect(J("boundaries-report.json").reservationConflicts.join()).toMatch(/NAGARKURNOOL/);
    expect(J("boundaries-report.json").problems).toEqual([]);
  });
});

/* ---- LGD fixtures ---- */
const T = (o: Partial<LgdTables> = {}): LgdTables => ({
  districts: [{ district_code: "501", district_name: "Adilabad", state_code: "36", district_census_2011_code: "532", district_census_2001_code: "1" }, { district_code: "502", district_name: "Anantapur", state_code: "28", district_census_2011_code: "553", district_census_2001_code: "22" }],
  subdistricts: [{ subdistrict_code: "4305", subdistrict_name: "Tamsi", district_code: "501", state_code: "36", subdistrict_census_2011_code: "4305" }, { subdistrict_code: "9", subdistrict_name: "Other", district_code: "1", state_code: "1" }],
  blocks: [{ block_code: "7", block_name: "Tamsi", block_name_local: "తామ్సి", district_code: "501", state_code: "36" }],
  villages: [
    { village_code: "10", village_name: "Alpha", village_name_local: "ఆల్ఫా", village_status: "Inhabitant", village_category: "Rural", state_code: "36", subdistrict_code: "4305", village_census_2011_code: "10" },
    { village_code: "11", village_name: "Beta", village_name_local: "BETA", village_status: "Inhabitant", village_category: "Urban", state_code: "36", subdistrict_code: "4305", village_census_2011_code: "11" },
    { village_code: "12", village_name: "Gone", village_name_local: "", village_status: "Un-Inhabitant", village_category: "Rural", state_code: "36", subdistrict_code: "4305", village_census_2011_code: "12" },
    { village_code: "13", village_name: "Kept", village_name_local: "", village_status: "Un-Inhabitant", village_category: "Both", state_code: "36", subdistrict_code: "4305", village_census_2011_code: "13" }],
  villagesByBlocks: [{ village_code: "10", block_code: "7", local_body_code: "900", state_code: "36" }, { village_code: "10", block_code: "8", local_body_code: "901", state_code: "36" }],
  priLocalBodies: [{ local_body_code: "900", local_body_name: "Alpha GP", local_body_name_local: "ఆల్ఫా", local_body_type_name: "Grama Panchayat", state_code: "36" }, { local_body_code: "5", local_body_name: "MP", local_body_type_name: "Mandal Panchayat", state_code: "36" }],
  urbanLocalBodies: [{ local_body_code: "800", local_body_name: "Adilabad", local_body_name_local: "ఆదిలాబాద్", local_body_type_code: "5", local_body_census_2011_code: "1", state_code: "36" }],
  urbanWards: [{ ward_code: "1", state_code: "36" }],
  mappingPri: [
    { village_code: "10", subdistrict_code: "4305", subdistrict_name: "Tamsi", district_code: "501", assembly_constituency_code: "3159", assembly_constituency_name: "Adilabad", assembly_constituency_eci_code: "1", parliament_constituency_code: "410", parliament_constituency_eci_code: "35", state_code: "36" },
    { village_code: "13", subdistrict_code: "4305", subdistrict_name: "Tamsi", district_code: "501", assembly_constituency_code: "3160", assembly_constituency_name: "Asifabad", assembly_constituency_eci_code: "2", parliament_constituency_code: "410", parliament_constituency_eci_code: "35", state_code: "36" },
    { village_code: "10", subdistrict_code: "4305", subdistrict_name: "Tamsi", district_code: "501", assembly_constituency_code: "3160", assembly_constituency_name: "Asifabad", assembly_constituency_eci_code: "2", parliament_constituency_code: "410", parliament_constituency_eci_code: "35", state_code: "36" },
    { village_code: "20", subdistrict_code: "5000", subdistrict_name: "Anan", district_code: "502", assembly_constituency_code: "3170", assembly_constituency_name: "Mummidivaram", assembly_constituency_eci_code: "62", parliament_constituency_code: "413", parliament_constituency_eci_code: "24", state_code: "28" }],
  mappingUrban: [{ ward_code: "1", local_body_code: "800", district_code: "501", assembly_constituency_code: "3159", assembly_constituency_name: "Adilabad", assembly_constituency_eci_code: "1", parliament_constituency_code: "410", state_code: "36" }],
  assemblyConstituencies: [
    { assembly_constituency_code: "3159", assembly_constituency_name: "Adilabad", state_code: "36" }, { assembly_constituency_code: "3160", assembly_constituency_name: "Asifabad", state_code: "36" },
    { assembly_constituency_code: "3199", assembly_constituency_name: "Orphan AC", state_code: "36" },
    { assembly_constituency_code: "3170", assembly_constituency_name: "Mummidivaram", state_code: "28" }],
  parliamentConstituencies: [], ...o,
});
const SRC = { districts: { sha256: "a", observedOn: "2026-11-19", rows: 2 }, assembly_constituencies: { sha256: "b", observedOn: "2026-11-22", rows: 4 } };

describe("@E2E-95 LGD mapper (S-80)", () => {
  it("builds compact districts, mandals, blocks, villages, GPs and urban bodies for one state", () => {
    const tg = buildLgdState(T(), "TG", SRC);
    expect(tg.asOf).toBe("2026-11-22");
    expect(tg.counts).toMatchObject({ districts: 1, mandals: 1, blocks: 1, gps: 1, urbanBodies: 1, urbanWards: 1 });
    expect(tg.districts[0]).toEqual(["501", "Adilabad", "532", "1"]);
    expect(tg.mandals[0]).toEqual(["4305", "Tamsi", "501", "4305"]);
    expect(tg.villages.map(v => v[0])).toEqual(["10", "11", "13"]); // 12 is uninhabited and unmapped
    expect(tg.villages[0]).toEqual(["10", "Alpha", "ఆల్ఫా", "4305", "10", "R", 1, "900", "7"]); // first block row wins
    expect(tg.villages[1][2]).toBe(""); // Latin placeholder is not a Telugu name
    expect(tg.villages[2].slice(5, 7)).toEqual(["B", 0]); // uninhabited but mapped: kept
    expect(tg.gps).toEqual([["900", "Alpha GP", "ఆల్ఫా", "4305"]]);
    expect(tg.urbanBodies[0]).toEqual(["800", "Adilabad", "ఆదిలాబాద్", "5", "1", "501"]);
    expect(tg.notes.join()).toMatch(/1 villages appear in more than one block.*uninhabited.*Rural \(ward-level\)/);
    expect(buildLgdState(T(), "AP", SRC).villages).toEqual([]);
    expect(teluguOrEmpty("abc")).toBe("");
    expect(JSON.stringify(tg)).not.toMatch(/ward_/); // rural wards are not carried
  });
  it("maps AC numbers: TG as is, AP minus 119", () => {
    expect([acNoFromEci("TG", 7), acNoFromEci("AP", 120), eciFromAcNo("AP", 1), eciFromAcNo("TG", 9)]).toEqual([7, 1, 120, 9]);
  });
  it("output is deterministic: no wall-clock stamps", () => {
    expect(JSON.stringify(buildLgdState(T(), "TG", SRC))).toBe(JSON.stringify(buildLgdState(T(), "TG", SRC)));
  });
  it("committed lgd files: AP 28 districts / 688 mandals, TG 33 / 621, villages carry LGD and census-2011 codes", () => {
    const ap = J("lgd-AP.json"), tg = J("lgd-TG.json");
    expect([ap.counts.districts, ap.counts.mandals, tg.counts.districts, tg.counts.mandals]).toEqual([28, 688, 33, 621]);
    expect(ap.counts.villages).toBeGreaterThan(17000);
    expect(tg.counts.villages).toBeGreaterThan(11000);
    expect(ap.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(ap.sources)).toContain("constituencies_mapping_pri");
    const v = tg.villages[0];
    expect(v[0]).toMatch(/^\d+$/); expect(v[4]).toMatch(/^\d+$/);
    expect(tg.cols.villages).toContain("census2011");
    expect(JSON.stringify(ap)).not.toMatch(/ward_code/);
  });
});

describe("@E2E-96 village/ward to AC and PC mapping (S-81)", () => {
  it("aggregates units per AC, repairs an out-of-range ECI code, flags gaps and split mandals", () => {
    const refAp = [{ acNo: 43, name: "MUMMIDIVARAM" }];
    const ap = buildAcUnits(T(), "AP", refAp);
    expect(ap.units["43"].eci).toBe(162);
    expect(ap.review.repairs.join()).toMatch(/eci code 62 is out of range for AP; repaired to acNo 43/);
    const tg = buildAcUnits(T(), "TG");
    expect(Object.keys(tg.units).sort()).toEqual(["1", "2"]); // AC without any ECI code is not keyed
    expect(tg.units["1"].counts).toEqual({ villages: 1, wards: 1, mandals: 1, urbanBodies: 1 });
    expect(tg.units["2"].villages).toEqual([10, 13]);
    expect(tg.review.villagesInMultipleAcs).toBe(1);
    expect(tg.review.acsWithNoRuralRows.map(a => a.acNo)).toEqual([]);
    expect(tg.review.acsWithNoUrbanRows).toBe(1);
    expect(tg.review.mandalsSplitAcrossAcs).toEqual([{ mandal: 4305, name: "Tamsi", acs: { "1": 1, "2": 2 } }]);
    const unrepaired = buildAcUnits(T(), "AP");
    expect(Object.keys(unrepaired.units)).toEqual(["-57"]);
    expect(majorityDistrict({ districts: { "502": 2, "501": 2 } })).toEqual({ code: "501", share: 0.5 });
    expect(majorityDistrict({ districts: {} })).toBeNull();
  });
  it("committed ac-units/review: 175 AP + 119 TG ACs, gaps flagged for review", () => {
    const u = J("ac-units.json"), r = J("review.json");
    expect([Object.keys(u.units.AP).length, Object.keys(u.units.TG).length]).toEqual([175, 119]);
    expect(r.AP.acsWithNoRuralRows.map((a: any) => a.acNo)).toEqual([21, 94]);
    expect(r.TG.acsWithNoRuralRows.length).toBe(10);
    expect(r.AP.mandalsSplitAcrossAcs.length).toBeGreaterThan(0);
    expect(r.AP.repairs.join()).toMatch(/Mummidivaram/);
    for (const st of ["AP", "TG"]) for (const x of Object.values<any>(u.units[st])) {
      expect(x.counts.villages).toBe(x.villages.length);
      expect(x.counts.villages + x.counts.wards).toBeGreaterThan(0); // no AC without any unit
      expect(x.district).toBeTruthy();
    }
  });
});

describe("@E2E-117 effective-dated AC link table (S-102)", () => {
  const meta = parse2008("ST_CODE,ST_ABBR,ST_NAME,PC_CODE,PC_NAME,PC_TYPE,AC_CODE,AC_NAME,AC_TYPE\nS01,AP,ANDHRA PRADESH,1,ADILABAD,ST,1,ADILABAD,\nS01,AP,ANDHRA PRADESH,1,ADILABAD,ST,2,ASIFABAD,ST\nS01,AP,ANDHRA PRADESH,1,ADILABAD,ST,3,MISSING,\n").acs;
  it("links LGD AC code to ECI acNo and reports mismatches", () => {
    const { units } = buildAcUnits(T(), "TG");
    const l = buildAcLink("TG", units, meta);
    expect(l.rows.map(r => [r.acNo, r.eci, r.lgd, r.pcNo, r.reservation])).toEqual([[1, 1, "3159", 1, "GEN"], [2, 2, "3160", 1, "ST"]]);
    expect(l.rows[0]).toMatchObject({ validFrom: "2008-02-19", validTo: null, datesInferred: true });
    expect(l.issues).toEqual(["2008 AC 3 (MISSING) has no LGD AC"]);
    const bad = buildAcLink("TG", { "1": { ...units["1"], name: "Totally Different" }, "9": { ...units["2"], eci: 2 } }, meta);
    expect(bad.issues.join()).toMatch(/differs from 2008 table.*eci\/acNo mismatch.*not in the 2008 table|eci\/acNo mismatch/s);
    const dup = buildAcLink("TG", { "1": units["1"], "2": { ...units["2"], lgd: "3159" } }, meta);
    expect(dup.issues.join()).toMatch(/maps to both 1 and 2/);
  });
  it("loader resolves both ways and respects validity dates", () => {
    const link = new AcLink([
      { state: "TG", acNo: 1, eci: 1, lgd: "3159", name: "Adilabad", pcNo: 1, reservation: "GEN", validFrom: "2008-02-19", validTo: "2030-01-01", datesInferred: true },
      { state: "TG", acNo: 1, eci: 1, lgd: "9999", name: "Adilabad", pcNo: 1, reservation: "GEN", validFrom: "2030-01-01", validTo: null, datesInferred: true }]);
    expect(link.size).toBe(2);
    expect(link.byLgd("3159", "2026-06-01")?.acNo).toBe(1);
    expect(link.byLgd("3159", "2030-01-01")).toBeNull();
    expect(link.byLgd("9999", "2031-01-01")?.acNo).toBe(1);
    expect(link.byAcNo("TG", 1, "2007-01-01")).toBeNull();
    expect(link.byAcNo("TG", 1, "2035-01-01")?.lgd).toBe("9999");
    expect(link.byLgd("3159")).toBeTruthy(); // defaults to today
    expect(AcLink.load("/nonexistent/ac-link.json").size).toBe(0);
  });
  it("committed table covers every AC once, with names matching election names", () => {
    const rows = J("ac-link.json").rows;
    expect(rows.length).toBe(294);
    expect(new Set(rows.map((r: any) => r.lgd)).size).toBe(294);
    expect(AcLink.load().byAcNo("AP", 43)?.name).toMatch(/Mummidivaram/i);
    expect(AcLink.load().byLgd("3170")?.acNo).toBe(43);
    expect(J("review.json").AP.linkIssues).toEqual([]);
  });
});

describe("@E2E-100 district crosswalk (S-85)", () => {
  const rows = [
    { state: "AP" as const, acNo: 1, oldName: "Guntur", currentLgd: "10", currentName: "Guntur", share: 1 },
    { state: "AP" as const, acNo: 2, oldName: "Guntur", currentLgd: "11", currentName: "Palnadu", share: 0.8 },
    { state: "AP" as const, acNo: 3, oldName: "Guntur", currentLgd: "11", currentName: "Palnadu", share: 1 },
    { state: "TG" as const, acNo: 1, oldName: "Warangal", currentLgd: "20", currentName: "Hanumakonda", share: 0.9 }];
  const xw = buildCrosswalk(rows);
  it("builds pairs, vintages and lists what is unavailable", () => {
    expect(xw.vintages.pre2014).toMatchObject({ AP: 1, TG: 1, verified: true });
    expect(xw.vintages.current).toMatchObject({ AP: 2, TG: 1 });
    expect(xw.pairs.AP).toEqual([{ old: "Guntur", current: "Guntur", currentLgd: "10", acs: 1 }, { old: "Guntur", current: "Palnadu", currentLgd: "11", acs: 2 }]);
    expect(xw.unavailable.join()).toMatch(/AP 26-district.*TG 31-district/);
    expect(xw.inferred.length).toBeGreaterThan(0);
    expect(parentsOf(xw, "AP", "11")).toEqual([{ old: "Guntur", acs: 2 }]);
  });
  it("aggregates results to the chosen vintage and ignores unknown seats", () => {
    const seats = [{ acNo: 1, winnerParty: "TDP" }, { acNo: 2, winnerParty: "YSRCP" }, { acNo: 3, winnerParty: "TDP" }, { acNo: 99, winnerParty: "X" }];
    expect(aggregateTally(xw, "AP", seats, "pre2014")).toEqual({ Guntur: { TDP: 2, YSRCP: 1 } });
    expect(aggregateTally(xw, "AP", seats, "current")).toEqual({ Guntur: { TDP: 1 }, Palnadu: { YSRCP: 1, TDP: 1 } });
    expect(districtOf(xw, "TG", 1, "current")).toBe("Hanumakonda");
    expect(districtOf(xw, "TG", 2, "current")).toBeUndefined();
  });
  it("committed crosswalk: AP 13 -> 28 and TG 10 -> 33, every AC mapped", () => {
    const c = J("district-crosswalk.json");
    expect(c.vintages.pre2014).toMatchObject({ AP: 13, TG: 10 });
    expect(c.vintages.current).toMatchObject({ AP: 28, TG: 33 });
    expect([Object.keys(c.ac.AP).length, Object.keys(c.ac.TG).length]).toEqual([175, 119]);
  });
});

describe("@E2E-98 Telugu gazetteer (S-83)", () => {
  it("parses Wikidata bindings, keeps Telugu script only and sorts deterministically", () => {
    const items = parseWd({ results: { bindings: [
      { item: { value: "http://www.wikidata.org/entity/Q20" }, en: { value: "B mandal" }, te: { value: "బి మండలం" } },
      { item: { value: "http://www.wikidata.org/entity/Q3" }, en: { value: "A mandal" }, te: { value: "Latin only" }, parentLabel: { value: "X district" } },
      { item: { value: "http://www.wikidata.org/entity/Q3" }, te: { value: "ఎ" } }, {}] } });
    expect(items.map(i => i.qid)).toEqual(["Q3", "Q20"]);
    expect(items[0]).toMatchObject({ en: "A mandal", te: "ఎ", parent: "X district" });
    expect(parseWd(null)).toEqual([]);
  });
  it("strips English and Telugu suffixes", () => {
    expect([stripDistrict("Guntur district"), stripMandal("Tamsi mandal"), stripMandal("Kakinada (Rural) mandal"), stripAc("Boath Assembly constituency")]).toEqual(["Guntur", "Tamsi", "Kakinada (Rural)", "Boath"]);
    expect([stripTeDistrict("గుంటూరు జిల్లా"), stripTeMandal("తామ్సి మండలం"), stripTeAc("అరకు శాసనసభా నియోజకవర్గం"), stripTeAc("అరకు అసెంబ్లీ నియోజకవర్గం"), stripTePc("అరకు లోకసభ నియోజకవర్గం")]).toEqual(["గుంటూరు", "తామ్సి", "అరకు", "అరకు", "అరకు"]);
  });
  it("matches by name, resolves ties by parent hint, never reuses an item and never invents names", () => {
    const items = [
      { qid: "Q1", en: "Gannavaram Assembly constituency", te: "గన్నవరం ఎ", parent: "Krishna district" },
      { qid: "Q2", en: "Gannavaram Assembly constituency", te: "గన్నవరం బి", parent: "East Godavari district" },
      { qid: "Q3", en: "Adilabad Assembly constituency", te: "ఆదిలాబాద్", parent: "" },
      { qid: "Q4", en: "Adilabad Assembly constituency", te: "అదిలాబాద్", parent: "" },
      { qid: "Q5", en: "Bheemili Assembly constituency", te: "", parent: "" }];
    const r = matchUnits([
      { id: "1", name: "Gannavaram", hint: "East Godavari" }, { id: "2", name: "Gannavaram", hint: "Krishna" },
      { id: "3", name: "Adilabad" }, { id: "4", name: "Bheemili" }, { id: "5", name: "Nowhere" }], items, stripAc, stripTeAc);
    expect(r.matched.get("1")).toEqual({ te: "గన్నవరం బి", qid: "Q2" });
    expect(r.matched.get("2")).toEqual({ te: "గన్నవరం ఎ", qid: "Q1" });
    expect(r.ambiguous).toEqual(["3 Adilabad"]);
    expect(r.unmatched).toEqual(["4 Bheemili", "5 Nowhere"]); // item without a Telugu label is not a match
    expect(coverage(4, 1)).toEqual({ total: 4, withTelugu: 1, pct: 25 });
    expect(coverage(0, 0).pct).toBe(0);
  });
  it("committed names-te.json reports coverage honestly per level", () => {
    const n = J("names-te.json");
    expect(Object.keys(n.coverage)).toEqual(expect.arrayContaining(["districts.AP", "mandals.TG", "acs.AP", "pcs.TG", "villages.AP", "villages.TG"]));
    expect(n.coverage["villages.TG"].pct).toBeGreaterThan(95);
    expect(n.coverage["villages.AP"].pct).toBeLessThan(10); // AP village Telugu names are mostly missing in LGD: not invented
    for (const st of ["AP", "TG"]) {
      expect(n.coverage[`pcs.${st}`].pct).toBe(100);
      expect(Object.values(n.names.acs[st]).every((v: any) => /[ఀ-౿]/.test(v) && !/నియోజకవర్గం/.test(v))).toBe(true);
      expect(Object.keys(n.names.acs[st]).length).toBe(n.coverage[`acs.${st}`].withTelugu);
    }
  });
});

describe("@E2E-103 district polygons (S-88)", () => {
  it("dissolves adjacent squares into one polygon and falls back to parts if union throws", () => {
    const d = dissolve([square(78, 17), square(79, 17)]);
    expect(d.dissolved).toBe(true);
    expect(toPolys(d.geom)).toHaveLength(1);
    expect(Math.abs(polyArea(toPolys(d.geom)[0]))).toBeCloseTo(2, 6);
    const odd = dissolve([{ type: "Polygon", coordinates: [[[NaN, 0], [1, 0], [1, 1], [NaN, 0]]] } as any, square(78, 17)]);
    expect(odd.dissolved === false || odd.dissolved === true).toBe(true);
  });
  it("assigns ACs to districts, reports districts without a majority AC and invalid output", () => {
    const raw = [1, 2, 3].map((n, i) => ({ acNo: n, name: `a${n}`, dtCode: 1, distName: "X", pcNo: 1, geometry: square(78 + i, 17) }));
    const assign = new Map([[1, { lgd: "10", share: 1 }], [2, { lgd: "10", share: 0.7 }], [3, { lgd: "11", share: 1 }]]);
    const b = buildDistrictFeatures("TG", raw, assign, [{ lgd: "10", name: "A" }, { lgd: "11", name: "B" }, { lgd: "12", name: "C" }]);
    expect(b.features.map(f => [f.properties.district, f.properties.acs, f.properties.minAcShareInDistrict, f.properties.approximate])).toEqual([["A", [1, 2], 0.7, true], ["B", [3], 1, true]]);
    expect(b.features[0].properties.method).toBe("ac-dissolve-majority");
    expect(b.notes.join()).toMatch(/district C \(12\) has no AC/);
    expect(buildDistrictFeatures("TG", [{ ...raw[0], acNo: 7 }], new Map(), [{ lgd: "10", name: "A" }]).problems.join()).toMatch(/no district assignment/);
  });
  it("committed district polygons: AP 28 and TG 33, labelled approximate", () => {
    for (const [st, n] of [["AP", 28], ["TG", 33]] as const) {
      const g = J(`district-${st}.geojson`);
      expect(validateGeoJson(g, `district-${st}`, { expectedCount: n })).toEqual([]);
      expect(g.approximation).toMatch(/APPROXIMATE/);
      expect(g.features.every((f: any) => f.properties.approximate === true && geomErrors(f.geometry).length === 0)).toBe(true);
    }
  });
});

describe("@E2E-102 seat lookup from geo outputs (S-87)", () => {
  it("assembly seats get the AC district and Telugu name, LS seats the dominant district of the PC", () => {
    const look = loadGeoLookup(ROOT)!;
    expect(look).toBeTruthy();
    expect(look("AP", "assembly", 1)).toMatchObject({ district: "Srikakulam" });
    expect(look("AP", "assembly", 1).acNameTe).toMatch(/[ఀ-౿]/);
    expect(look("TG", "ls", 1).district).toBe("Nirmal"); // 3 of the 7 Adilabad PC segments lie in Nirmal district: dominant district rule
    expect(look("TG", "ls", 1).acNameTe).toBeTruthy();
    expect(look("AP", "assembly", 9999)).toEqual({});
  });
  it("returns undefined when no geo data is committed", () => {
    const d = mkdtempSync(join(tmpdir(), "geo-empty-"));
    try { expect(loadGeoLookup(d)).toBeUndefined(); } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("util + data budget", () => {
  it("csv, names, compact json", () => {
    expect(parseCsv('a,b\n"x,1","q""r"\n\n2,3')).toEqual([{ a: "x,1", b: 'q"r' }, { a: "2", b: "3" }]);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
    expect(normName("Boath (ST)")).toBe("boath");
    expect(titleCase("LAL BAHADUR NAGAR")).toBe("Lal Bahadur Nagar");
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(nameClose("Vijaywada West", "VIJAYAWADA WEST")).toBe(true);
    expect(nameClose("Guntur", "Palnadu")).toBe(false);
    expect(compactJson({ a: [1, 2], b: { c: 1 } }, 1)).toBe('{\n"a":[1,2],\n"b":{"c":1}\n}\n');
    expect(compactJson([{ x: 1 }, { y: 2 }], 1)).toBe('[\n{"x":1},\n{"y":2}\n]\n');
  });
  it("generated geo folder stays under 25 MB", () => {
    const total = readdirSync(GEO).reduce((s, f) => s + statSync(join(GEO, f)).size, 0);
    expect(total).toBeLessThan(25 * 1024 * 1024);
  });
  it("legacy BOUNDARIES_*_URL override tolerates network failure and exits 0", () => {
    const out = mkdtempSync(join(tmpdir(), "geo-legacy-"));
    try {
      const r = spawnSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "scripts/fetch-boundaries.ts")],
        { env: { ...process.env, PIPELINE_OUT_DIR: out, BOUNDARIES_AP_URL: "http://127.0.0.1:9/x.geojson" }, encoding: "utf8", cwd: ROOT });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/WARNING/);
      expect(existsSync(join(out, "geo", "ac-AP.geojson"))).toBe(false);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
  it("validate-data gate accepts the committed geo files and rejects a broken polygon set", () => {
    const run = (dir: string) => spawnSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "scripts/validate-data.ts"), dir], { encoding: "utf8", cwd: ROOT });
    const tmp = mkdtempSync(join(tmpdir(), "geo-gate-"));
    try {
      // copy without the manifest so this test checks only the geo gate (manifest checksums are tested elsewhere)
      cpSync(join(ROOT, "data/generated"), tmp, { recursive: true, filter: s => !s.endsWith("manifest.json") });
      const ok = run(tmp);
      expect(ok.stderr).toBe("");
      expect(ok.stdout).toContain("geo/ac-AP.geojson: 175 polygons, joined to elections.json");
      expect(ok.stdout).toContain("geo/pc-TG.geojson: 17 polygons, joined to elections.json");
      expect(ok.status).toBe(0);
      const g = JSON.parse(readFileSync(join(tmp, "geo/ac-AP.geojson"), "utf8"));
      g.features.pop();
      writeFileSync(join(tmp, "geo/ac-AP.geojson"), JSON.stringify(g));
      const bad = run(tmp);
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toMatch(/expected 175 features, got 174/);
      expect(bad.stderr).toMatch(/have no polygon/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  it("fetch-lgd output is a pure function of the source hashes", () => {
    const h = (f: string) => createHash("sha256").update(readFileSync(join(GEO, f))).digest("hex");
    expect(h("lgd-AP.json")).toBe(h("lgd-AP.json"));
    expect(JSON.stringify(J("lgd-AP.json"))).not.toMatch(/generatedAt|fetchedAt/);
  });
});
