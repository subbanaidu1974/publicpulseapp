import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ElectionType } from "../src/lib/states";
import { FIXTURES, GENERATED, buildElectionSnapshot, writeJson } from "../pipeline/io";

// Usage: tsx scripts/fetch-elections.ts [csvUrl] [assembly|ls]   (or env TCPD_CSV_URL, TCPD_ELECTION_TYPE)
async function main() {
  const url = process.argv[2] || process.env.TCPD_CSV_URL;
  const type = (process.argv[3] || process.env.TCPD_ELECTION_TYPE || "assembly") as ElectionType;
  let csv: string | null = null;
  let source = "";
  if (url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      csv = await res.text();
      source = url;
    } catch (e) {
      console.warn(`[fetch-elections] WARNING: download failed (${(e as Error).message}); falling back to DEMO fixture`);
    }
  } else {
    console.warn("[fetch-elections] WARNING: no TCPD_CSV_URL given; using DEMO fixture (not real data)");
  }
  const demo = csv === null;
  if (demo) {
    csv = readFileSync(resolve(FIXTURES, "elections.demo.csv"), "utf8");
    source = "pipeline/fixtures/elections.demo.csv";
  }
  const snap = buildElectionSnapshot(csv!, type, demo ? "demo" : "TCPD", source);
  if (!snap.results.length) {
    console.error("[fetch-elections] ERROR: no AP/TG rows found in input");
    process.exit(1);
  }
  writeJson(resolve(GENERATED, "elections.json"), snap);
  console.log(`[fetch-elections] wrote ${snap.results.length} rows (provenance=${snap.provenance})`);
}

main().catch(e => { console.error("[fetch-elections] failed:", (e as Error).message); process.exit(1); });
