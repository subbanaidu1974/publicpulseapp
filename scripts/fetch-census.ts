import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES, GENERATED, ROOT, buildCensusSnapshot, writeJson } from "../pipeline/io";
import { parseUnitCsv, rollupDistricts, rollupSubDistricts, unitToRow, UNIT_COLUMNS, validateUnits } from "../pipeline/census";
import { parseCsv } from "../pipeline/normalize";

const COLS = ["State", "District", "TOT_P", "TOT_M", "TOT_F", "P_SC", "P_ST", "P_LIT"];

/** Fetch via data.gov.in resource API. The key is only sent as a query param and is never logged. */
async function fromApi(key: string, resource: string): Promise<string> {
  const u = new URL(`https://api.data.gov.in/resource/${encodeURIComponent(resource)}`);
  u.searchParams.set("api-key", key);
  u.searchParams.set("format", "json");
  u.searchParams.set("limit", "1000");
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { records?: Record<string, string>[] };
  if (!body.records?.length) throw new Error("no records in response");
  const q = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [COLS.join(","), ...body.records.map(r => COLS.map(c => q(r[c])).join(","))].join("\n");
}

async function main() {
  const key = process.env.DATA_GOV_IN_API_KEY;
  const resource = process.env.DATA_GOV_IN_RESOURCE_ID;
  let csv: string | null = null;
  let source = "";
  if (key && resource) {
    try {
      csv = await fromApi(key, resource);
      source = `data.gov.in resource ${resource}`;
    } catch (e) {
      console.warn(`[fetch-census] WARNING: data.gov.in API failed (${(e as Error).message}); falling back to DEMO fixture`);
    }
  } else if (key && !resource) {
    console.warn("[fetch-census] WARNING: DATA_GOV_IN_RESOURCE_ID not set; falling back to DEMO fixture");
  } else {
    console.warn("[fetch-census] WARNING: DATA_GOV_IN_API_KEY not set; falling back to DEMO fixture CSV");
  }
  // Manual drop-in: data/raw/census/*.csv (see docs/CENSUS_DATA.md). District PCA CSVs (State,District,TOT_P,...) or
  // village/town unit CSVs (kind,district_code,...). Real data supplied by the user beats the demo fixture.
  if (csv === null) {
    const dropDir = process.env.CENSUS_RAW_DIR ? resolve(process.env.CENSUS_RAW_DIR) : resolve(ROOT, "data/raw/census");
    const files = existsSync(dropDir) ? readdirSync(dropDir).filter(f => f.toLowerCase().endsWith(".csv")).sort() : [];
    const pca = files.filter(f => "State" in (parseCsv(readFileSync(resolve(dropDir, f), "utf8"))[0] ?? {}));
    const unitFiles = files.filter(f => !pca.includes(f));
    if (unitFiles.length) {
      const units = unitFiles.flatMap(f => parseUnitCsv(readFileSync(resolve(dropDir, f), "utf8")));
      const errs = validateUnits(units);
      if (units.length && !errs.length) {
        const src = `manual drop-in: ${unitFiles.map(f => "data/raw/census/" + f).join(", ")}`;
        writeJson(resolve(GENERATED, "census.json"), { schema: 1, provenance: "manual-csv", source: src, districts: rollupDistricts(units, src) });
        writeJson(resolve(GENERATED, "census-subdistricts.json"), { schema: 1, provenance: "manual-csv", source: src, subDistricts: rollupSubDistricts(units) });
        writeJson(resolve(GENERATED, "census-units.json"), { schema: 1, provenance: "manual-csv", source: src, columns: UNIT_COLUMNS, units: units.map(unitToRow) });
        console.log(`[fetch-census] wrote ${units.length} village/town units from drop-in CSV (provenance=manual-csv)`);
        return;
      }
      console.warn(`[fetch-census] WARNING: drop-in unit CSVs unusable (${errs[0] ?? "no valid rows"}); ignoring them`);
    }
    if (pca.length) {
      const NL = String.fromCharCode(10);
      csv = pca.map((f, i) => { const t = readFileSync(resolve(dropDir, f), "utf8"); return i ? t.split(NL).slice(1).join(NL) : t; }).join(NL);
      source = `manual drop-in: ${pca.map(f => "data/raw/census/" + f).join(", ")}`;
      const snap = buildCensusSnapshot(csv, "manual-csv", source);
      if (snap.districts.length) {
        writeJson(resolve(GENERATED, "census.json"), snap);
        console.log(`[fetch-census] wrote ${snap.districts.length} districts from drop-in CSV (provenance=manual-csv)`);
        return;
      }
      csv = null;
    }
  }
  // Never replace real census data (e.g. from scripts/ingest-dchb-census.ts) with the demo fixture.
  if (csv === null) {
    const existing = resolve(GENERATED, "census.json");
    if (existsSync(existing) && JSON.parse(readFileSync(existing, "utf8")).provenance !== "demo") {
      console.warn("[fetch-census] WARNING: no new source available; keeping existing non-demo census.json");
      return;
    }
  }
  const demo = csv === null;
  if (demo) {
    csv = readFileSync(resolve(FIXTURES, "census.demo.csv"), "utf8");
    source = "pipeline/fixtures/census.demo.csv";
  }
  const snap = buildCensusSnapshot(csv!, demo ? "demo" : "data.gov.in", source);
  writeJson(resolve(GENERATED, "census.json"), snap);
  console.log(`[fetch-census] wrote ${snap.districts.length} districts (provenance=${snap.provenance})`);
}

main().catch(e => { console.error("[fetch-census] failed:", (e as Error).message); process.exit(1); });
