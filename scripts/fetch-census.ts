import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES, GENERATED, buildCensusSnapshot, writeJson } from "../pipeline/io";

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
