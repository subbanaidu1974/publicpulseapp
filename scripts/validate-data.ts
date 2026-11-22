import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, ROOT } from "../pipeline/io";
import { verifyManifest, MANIFEST_NAME } from "../pipeline/manifest";
import { parseUnitRows, validateUnits } from "../pipeline/census";
import { STATES } from "../src/lib/states";
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
