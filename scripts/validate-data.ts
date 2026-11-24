import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, ROOT } from "../pipeline/io";
import { verifyManifest, MANIFEST_NAME } from "../pipeline/manifest";
import { parseUnitRows, validateUnits } from "../pipeline/census";
import { STATES } from "../src/lib/states";
import { geomErrors } from "../pipeline/geo/geometry";
import { loadRegistry, validateRegistry } from "../pipeline/geo/versions";
import { validateCensus, validateElections, validateGeoJson, type CensusSnapshot, type ElectionSnapshot } from "../pipeline/quality";

const dir = process.argv[2] ? resolve(process.argv[2]) : GENERATED;
const errors: string[] = [];
const read = (f: string) => JSON.parse(readFileSync(resolve(dir, f), "utf8"));

if (!existsSync(dir)) errors.push(`missing directory ${dir}`);
else {
  if (existsSync(resolve(dir, "elections.json"))) {
    const s = read("elections.json") as ElectionSnapshot;
    errors.push(...validateElections(s.results, s.provenance !== "demo"));
    console.log(`elections.json: ${s.results.length} rows, provenance=${s.provenance}`);
  } else errors.push("elections.json missing (run pipeline:elections)");
  if (existsSync(resolve(dir, "census.json"))) {
    const s = read("census.json") as CensusSnapshot;
    errors.push(...validateCensus(s.districts));
    console.log(`census.json: ${s.districts.length} districts, provenance=${s.provenance}`);
  }
  for (const f of readdirSync(dir).filter(f => f.endsWith(".geojson"))) errors.push(...validateGeoJson(read(f), f));
  // S-78/S-79: polygons under geo/ must join to elections.json by acNo / LS acNo and match the seat counts.
  const geoDir = resolve(dir, "geo");
  if (existsSync(geoDir)) {
    const snap = existsSync(resolve(dir, "elections.json")) ? (read("elections.json") as ElectionSnapshot) : null;
    const real = !!snap && snap.provenance !== "demo";
    const idsOf = (state: string, type: string) => new Set((snap?.results ?? []).filter(r => r.state === state && r.type === type).map(r => r.acNo));
    for (const state of ["AP", "TG"] as const) {
      for (const [kind, idProp, type, expected] of [["ac", "acNo", "assembly", STATES[state].assemblySeats], ["pc", "pcNo", "ls", STATES[state].lsSeats]] as const) {
        const f = resolve(geoDir, `${kind}-${state}.geojson`);
        if (!existsSync(f)) continue;
        const g = JSON.parse(readFileSync(f, "utf8"));
        errors.push(...validateGeoJson(g, `geo/${kind}-${state}.geojson`, { idProp, expectedCount: expected, joinIds: real ? idsOf(state, type) : undefined }));
        console.log(`geo/${kind}-${state}.geojson: ${g.features?.length ?? 0} polygons${real ? ", joined to elections.json" : ""}`);
      }
    }
    // S-89: mandal polygons must be valid, unique per LGD mandal, known to LGD and matched at or above the documented threshold.
    for (const state of ["AP", "TG"] as const) {
      const f = resolve(geoDir, `mandal-${state}.geojson`), lf = resolve(geoDir, `lgd-${state}.json`);
      if (!existsSync(f)) continue;
      const g = JSON.parse(readFileSync(f, "utf8"));
      const known = existsSync(lf) ? new Set<string>((JSON.parse(readFileSync(lf, "utf8")).mandals as string[][]).map(m => m[0])) : null;
      const seen = new Set<string>();
      errors.push(...validateGeoJson(g, `geo/mandal-${state}.geojson`).filter(e => !/non-empty/.test(e) || !g.features?.length));
      for (const ft of g.features ?? []) {
        const p = ft.properties ?? {};
        const ge = geomErrors(ft.geometry);
        if (ge.length) errors.push(`geo/mandal-${state}.geojson: ${p.lgdCode}: ${[...new Set(ge)].join(", ")}`);
        if (seen.has(p.lgdCode)) errors.push(`geo/mandal-${state}.geojson: duplicate lgdCode ${p.lgdCode}`);
        seen.add(p.lgdCode);
        if (known && !known.has(String(p.lgdCode))) errors.push(`geo/mandal-${state}.geojson: lgdCode ${p.lgdCode} is not an LGD mandal of ${state}`);
        if (!(p.confidence >= 0.8)) errors.push(`geo/mandal-${state}.geojson: ${p.lgdCode} has match confidence ${p.confidence} below 0.8`);
      }
      console.log(`geo/mandal-${state}.geojson: ${g.features?.length ?? 0} mandal polygons`);
    }
    // S-90: village points must be known LGD villages, inside the region, unique across both layers and at or above the threshold.
    for (const state of ["AP", "TG"] as const) {
      const lf = resolve(geoDir, `lgd-${state}.json`);
      const known = existsSync(lf) ? new Set<string>((JSON.parse(readFileSync(lf, "utf8")).villages as (string | number)[][]).map(v => String(v[0]))) : null;
      const seen = new Set<string>();
      for (const layer of ["wikidata", "osm"] as const) {
        const f = resolve(geoDir, `village-points-${layer}-${state}.json`);
        if (!existsSync(f)) continue;
        const g = JSON.parse(readFileSync(f, "utf8"));
        for (const r of (g.points ?? []) as (string | number)[][]) {
          const [code, , lon, lat, conf] = r;
          const tag = `geo/village-points-${layer}-${state}.json: ${code}`;
          if (known && !known.has(String(code))) errors.push(`${tag} is not an LGD village of ${state}`);
          if (seen.has(String(code))) errors.push(`${tag} appears in more than one layer or twice`);
          seen.add(String(code));
          if (!(typeof lon === "number" && typeof lat === "number" && lon >= 76 && lon <= 85 && lat >= 12 && lat <= 20)) errors.push(`${tag} has coordinates outside the AP/TG region`);
          if (!(Number(conf) >= 0.8)) errors.push(`${tag} has match confidence ${conf} below 0.8`);
        }
        console.log(`geo/village-points-${layer}-${state}.json: ${g.points?.length ?? 0} village points`);
      }
    }
    // S-92: the boundary version registry must be consistent with the files it lists.
    const reg = loadRegistry(geoDir);
    if (reg) { errors.push(...validateRegistry(reg, geoDir).map(e => `geo/versions.json: ${e}`)); console.log(`geo/versions.json: ${reg.sets.length} boundary set(s)`); }
  }
}

// Census unit-level data (village/town rollups) must be internally consistent when present.
if (existsSync(dir) && existsSync(resolve(dir, "census-units.json"))) {
  const u = read("census-units.json") as { columns: string[]; units: (string | number)[][] };
  errors.push(...validateUnits(parseUnitRows(u.columns, u.units)));
  console.log(`census-units.json: ${u.units.length} villages/towns`);
}
// Dataset manifest: checksums, licence keys and completeness. Mandatory for the committed data/generated directory;
// other directories (tests, scratch runs) are checked only when they carry a manifest.
if (existsSync(dir) && (dir === resolve(ROOT, "data/generated") || existsSync(resolve(dir, MANIFEST_NAME)))) {
  const merrs = verifyManifest(dir);
  errors.push(...merrs);
  if (!merrs.length) console.log("manifest.json: checksums and licence keys verified");
}

if (errors.length) {
  console.error(`Data quality gate FAILED (${errors.length}):`);
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log("Data quality gate passed");
