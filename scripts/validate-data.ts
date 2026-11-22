import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED } from "../pipeline/io";
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
}

if (errors.length) {
  console.error(`Data quality gate FAILED (${errors.length}):`);
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log("Data quality gate passed");
