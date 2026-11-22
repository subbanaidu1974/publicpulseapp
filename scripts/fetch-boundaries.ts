/**
 * S-78/S-79/S-82/S-88: constituency and district polygons for AP and TG.
 *  - AC polygons: DataMeet India_AC shapefile (undivided AP, ST_CODE 28), split into TG/AP, re-keyed to ECI acNo, simplified.
 *  - PC polygons: DataMeet india_pc_2019_simplified.geojson (keeps wikidata_qid).
 *  - Reservation + PC link: DataMeet 2008-constituencies.csv.
 *  - District polygons: AC dissolve using the LGD AC->district assignment (run scripts/fetch-lgd.ts first). Approximate.
 * Outputs data/generated/geo/{ac,pc,district}-{AP,TG}.geojson and boundaries-report.json. Raw downloads are cached, never committed.
 * Network failure is tolerated (exit 0, committed files stay). Legacy overrides BOUNDARIES_AP_URL / BOUNDARIES_TG_URL
 * fetch one ready-made per-state AC GeoJSON instead.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATES, type StateCode } from "../src/lib/states";
import { buildAcFeatures, buildDistrictFeatures, buildPcFeatures, reconcileReservation, readAcShapefile } from "../pipeline/geo/boundaries";
import { buildCrosswalk } from "../pipeline/geo/crosswalk";
import { parse2008 } from "../pipeline/geo/constituency";
import { countVertices } from "../pipeline/geo/geometry";
import { cached, GEO_OUT, readJsonFile, SRC, writeCompact } from "../pipeline/geo/util";
import { validateGeoJson } from "../pipeline/quality";

const fc = (features: any[], name: string, extra: Record<string, unknown> = {}) => ({ type: "FeatureCollection", name, ...extra, features });

async function legacy(): Promise<boolean> {
  const targets: Record<string, string | undefined> = { AP: process.env.BOUNDARIES_AP_URL, TG: process.env.BOUNDARIES_TG_URL };
  if (!targets.AP && !targets.TG) return false;
  for (const [code, url] of Object.entries(targets)) {
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo = await res.json();
      const errs = validateGeoJson(geo, code);
      if (errs.length) throw new Error(errs.join("; "));
      writeCompact(join(GEO_OUT, `ac-${code}.geojson`), geo, 2);
      console.log(`[fetch-boundaries] ${code}: ${geo.features.length} features (override URL)`);
    } catch (e) {
      console.warn(`[fetch-boundaries] WARNING: ${code} boundaries unavailable (${(e as Error).message}); map will use table fallback`);
    }
  }
  return true;
}

async function main() {
  if (await legacy()) return;
  const shp = await cached("India_AC.shp", SRC.acShp("shp")), dbf = await cached("India_AC.dbf", SRC.acShp("dbf"));
  await cached("India_AC.shx", SRC.acShp("shx")); await cached("India_AC.prj", SRC.acShp("prj"));
  const pcFc = JSON.parse(readFileSync(await cached("india_pc_2019_simplified.geojson", SRC.pc), "utf8"));
  const meta0 = parse2008(readFileSync(await cached("2008-constituencies.csv", SRC.c2008), "utf8"));
  const { rows: raw, merged, dropped } = await readAcShapefile(shp, dbf);
  console.log(`[fetch-boundaries] shapefile: ${raw.length} AP+TG ACs (parts merged for ${merged.length} duplicate AC_NO; dropped ${dropped.length} unnamed AC_NO=0 areas)`);
  const rec = reconcileReservation(meta0.acs, raw);
  const meta = { ...meta0, acs: rec.acs };

  // LGD-derived district assignment (optional: needs the committed fetch-lgd outputs).
  const unitsFile = join(GEO_OUT, "ac-units.json");
  const haveLgd = existsSync(unitsFile) && existsSync(join(GEO_OUT, "lgd-AP.json"));
  const dName: Record<string, string> = {}, dList: Record<StateCode, { lgd: string; name: string }[]> = { AP: [], TG: [] };
  const units: Record<StateCode, Record<string, any>> = { AP: {}, TG: {} };
  if (haveLgd) {
    const u = readJsonFile(unitsFile).units;
    for (const s of ["AP", "TG"] as StateCode[]) {
      units[s] = u[s];
      for (const d of readJsonFile(join(GEO_OUT, `lgd-${s}.json`)).districts) { dName[d[0]] = d[1]; dList[s].push({ lgd: d[0], name: d[1] }); }
    }
  } else console.warn("[fetch-boundaries] WARNING: LGD outputs missing (run scripts/fetch-lgd.ts); AC district fields and district polygons skipped");

  const build = buildAcFeatures(raw, meta.acs, {
    district: (s, n) => { const x = units[s][String(n)]; return x?.district ? { lgd: x.district, name: dName[x.district], share: x.districtShare } : undefined; },
    lgdAc: (s, n) => units[s][String(n)]?.lgd,
  });
  const pcs = buildPcFeatures(pcFc);
  const report: Record<string, any> = { schema: 1, sources: { ac: "DataMeet maps/assembly-constituencies/India_AC.shp (CC BY 2.5 India)", pc: "DataMeet maps/parliamentary-constituencies/india_pc_2019_simplified.geojson (CC0)", reservation: "DataMeet india-election-data/constituencies/2008-constituencies.csv" }, droppedUnnamedPolygons: dropped, reservationConflicts: rec.conflicts, problems: [...meta.errors, ...build.problems, ...pcs.problems], counts: {}, vertices: {} };
  let failed = false;
  for (const s of ["AP", "TG"] as StateCode[]) {
    const acFc = fc(build.features[s], `ac-${s}`, { generator: "scripts/fetch-boundaries.ts", note: "ECI acNo (state-specific), 2008 delimitation, simplified" });
    const pcFcOut = fc(pcs.features[s], `pc-${s}`, { generator: "scripts/fetch-boundaries.ts" });
    for (const [label, g, n] of [[`ac-${s}`, acFc, STATES[s].assemblySeats], [`pc-${s}`, pcFcOut, STATES[s].lsSeats]] as const) {
      const errs = validateGeoJson(g, label, { idProp: label.startsWith("ac") ? "acNo" : "pcNo", expectedCount: n });
      if (errs.length) { failed = true; console.error(`[fetch-boundaries] ${label} FAILED:`, errs.join("; ")); }
    }
    report.counts[s] = { ac: acFc.features.length, pc: pcFcOut.features.length };
    report.vertices[s] = { ac: acFc.features.reduce((a: number, f: any) => a + countVertices(f.geometry), 0), pc: pcFcOut.features.reduce((a: number, f: any) => a + countVertices(f.geometry), 0) };
    if (failed) continue;
    writeCompact(join(GEO_OUT, `ac-${s}.geojson`), acFc, 2);
    writeCompact(join(GEO_OUT, `pc-${s}.geojson`), pcFcOut, 2);
    console.log(`[fetch-boundaries] ${s}: ${acFc.features.length} AC + ${pcFcOut.features.length} PC polygons`);
    if (haveLgd) {
      const assign = new Map<number, { lgd: string; share: number }>();
      for (const [no, x] of Object.entries(units[s])) if (x.district) assign.set(Number(no), { lgd: x.district, share: x.districtShare });
      const d = buildDistrictFeatures(s, raw, assign, dList[s]);
      report.problems.push(...d.problems);
      report.districtNotes = { ...(report.districtNotes ?? {}), [s]: d.notes };
      report.counts[s].district = d.features.length; report.counts[s].districtExpected = dList[s].length;
      if (!d.problems.length) writeCompact(join(GEO_OUT, `district-${s}.geojson`), fc(d.features, `district-${s}`, {
        generator: "scripts/fetch-boundaries.ts",
        approximation: "APPROXIMATE: AC polygons dissolved per district; each AC is assigned to the LGD district holding most of its villages and wards. Mandal-split ACs cannot be divided (no mandal polygons available). Not an official boundary.",
      }), 2);
      console.log(`[fetch-boundaries] ${s}: ${d.features.length}/${dList[s].length} district polygons (dissolved: ${d.features.filter(f => f.properties.dissolved).length})`);
    }
  }
  if (haveLgd) {
    const rows = (["AP", "TG"] as StateCode[]).flatMap(s => build.features[s].filter(f => f.properties.districtLgd).map(f => ({
      state: s, acNo: f.properties.acNo, oldName: f.properties.districtPre2014, currentLgd: f.properties.districtLgd, currentName: f.properties.district, share: f.properties.districtShare })));
    const xw = buildCrosswalk(rows);
    writeCompact(join(GEO_OUT, "district-crosswalk.json"), xw, 3);
    report.crosswalk = { vintages: xw.vintages, acsMapped: rows.length };
    console.log(`[fetch-boundaries] crosswalk: AP ${xw.vintages.pre2014.AP}->${xw.vintages.current.AP}, TG ${xw.vintages.pre2014.TG}->${xw.vintages.current.TG} districts (${rows.length} ACs)`);
  }
  report.problems = report.problems.sort();
  writeCompact(join(GEO_OUT, "boundaries-report.json"), report, 4);
  if (report.problems.length) console.warn(`[fetch-boundaries] ${report.problems.length} problems recorded in boundaries-report.json`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.warn("[fetch-boundaries] WARNING:", (e as Error).message, "- boundaries unavailable; committed files (if any) are left untouched"); });
