/**
 * Ingest the Census of India 2011 District Census Handbook (DCHB) village and town directories for Andhra Pradesh (undivided,
 * state code 28) into district, sub-district (mandal) and village/town census snapshots keyed by Census 2011 codes.
 *
 * Source (no login needed, verified Nov 2026): Census Digital Library, https://censusindia.gov.in/nada/index.php/catalog/123
 *   - resource 144  DH_2011_DCHB_Village_Release_2800.xlsx (rural villages, ~54 MB)
 *   - resource 145  DH_2011_DCHB_Town_Release_2800.xlsx    (statutory + census towns, ~1.7 MB)
 * Usage:
 *   tsx scripts/ingest-dchb-census.ts --download            # fetch both files into data/raw/census/dchb/ (retries; slow server)
 *   tsx scripts/ingest-dchb-census.ts [village.xlsx town.xlsx]
 * Output: census.json (districts), census-subdistricts.json, census-units.json in GENERATED.
 * The directories carry households, population, males, females, SC and ST only; there is NO literacy column.
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, ROOT, writeJson } from "../pipeline/io";
import {
  UNIT_COLUMNS, dchbRecordToUnit, rollupDistricts, rollupSubDistricts, unitToRow, validateUnits,
  type CensusUnit,
} from "../pipeline/census";
import { xlsxRows } from "../pipeline/xlsx";

const RAW = resolve(ROOT, "data/raw/census/dchb");
const BASE = "https://censusindia.gov.in/nada/index.php/catalog/123/download";
const FILES = {
  village: { id: 144, name: "DH_2011_DCHB_Village_Release_2800.xlsx", sheet: "Village_Data_2800", size: 53742618 },
  town: { id: 145, name: "DH_2011_DCHB_Town_Release_2800.xlsx", sheet: "Town_2800", size: 1683230 },
};

async function download(f: { id: number; name: string; size: number }): Promise<string> {
  const dest = resolve(RAW, f.name);
  if (existsSync(dest) && statSync(dest).size === f.size) return dest;
  mkdirSync(RAW, { recursive: true });
  const res = await fetch(`${BASE}/${f.id}`, { headers: { "User-Agent": "PeoplePulse-pipeline/0.1 (open-data ingest)" } });
  if (!res.ok || !res.body) throw new Error(`download ${f.name}: HTTP ${res.status}`);
  const out = createWriteStream(dest);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) if (!out.write(chunk)) await new Promise<void>(r => out.once("drain", () => r()));
  await new Promise<void>(r => out.end(() => r()));
  if (statSync(dest).size !== f.size) throw new Error(`download ${f.name}: size ${statSync(dest).size} != expected ${f.size} (truncated; re-run)`);
  return dest;
}

async function readUnits(path: string, kind: "V" | "T", sheet: string): Promise<{ units: CensusUnit[]; skipped: number }> {
  const units: CensusUnit[] = [];
  let header: Record<string, string> | null = null;
  let skipped = 0;
  for await (const row of xlsxRows(path, sheet)) {
    if (!header) { header = row; continue; }
    const rec: Record<string, string> = {};
    for (const [col, v] of Object.entries(row)) if (header[col]) rec[header[col]] = v;
    // Village sheet repeats the label "Nearest ..." headers; only the identity/population columns are read.
    const u = dchbRecordToUnit(kind, rec);
    if (u) units.push(u); else if (rec["District Code"]) skipped++;
  }
  return { units, skipped };
}

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  if (process.argv.includes("--download")) {
    for (const f of Object.values(FILES)) console.log(`[dchb] downloaded ${await download(f)}`);
  }
  const vPath = resolve(args[0] ?? resolve(RAW, FILES.village.name));
  const tPath = resolve(args[1] ?? resolve(RAW, FILES.town.name));
  for (const p of [vPath, tPath]) if (!existsSync(p)) throw new Error(`missing ${p}; run with --download or pass the two xlsx paths`);

  const v = await readUnits(vPath, "V", FILES.village.sheet);
  const t = await readUnits(tPath, "T", FILES.town.sheet);
  const units = [...v.units, ...t.units].sort((a, b) =>
    a.districtCode.localeCompare(b.districtCode) || a.subDistrictCode.localeCompare(b.subDistrictCode) || a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code));
  const errs = validateUnits(units);
  if (errs.length) {
    console.warn(`[dchb] WARNING: ${errs.length} unit-level violations (first 5):\n  ${errs.slice(0, 5).join("\n  ")}`);
  }
  const source = "Census of India 2011, District Census Handbooks village and town directories, Andhra Pradesh (ORGI, censusindia.gov.in Census Digital Library, catalog/123 resources 144 and 145)";
  const districts = rollupDistricts(units, source);
  const subs = rollupSubDistricts(units);
  const generatedAt = new Date().toISOString().slice(0, 10);

  writeJson(resolve(GENERATED, "census.json"), { schema: 1, provenance: "census-dchb-2011", source, districts });
  writeJson(resolve(GENERATED, "census-subdistricts.json"), { schema: 1, provenance: "census-dchb-2011", source, subDistricts: subs });
  writeJson(resolve(GENERATED, "census-units.json"), {
    schema: 1, provenance: "census-dchb-2011", source, columns: UNIT_COLUMNS, units: units.map(unitToRow),
  });
  const pop = (s: "AP" | "TG") => districts.filter(d => d.state === s).reduce((a, d) => a + d.population, 0);
  console.log(`[dchb] villages=${v.units.length} (skipped ${v.skipped}) towns=${t.units.length} (skipped ${t.skipped}) subDistricts=${subs.length} districts=${districts.length}`);
  console.log(`[dchb] population AP=${pop("AP")} TG=${pop("TG")} (generated ${generatedAt}); violations=${errs.length}`);
}

main().catch(e => { console.error("[dchb] failed:", (e as Error).message); process.exit(1); });
