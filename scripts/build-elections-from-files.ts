import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import type { ElectionType } from "../src/lib/states";
import type { CandidateResult } from "../src/lib/elections";
import { GENERATED, writeJson } from "../pipeline/io";
import { normalizeTcpd, sortResults } from "../pipeline/normalize";
import { validateElections } from "../pipeline/quality";

// Usage: tsx scripts/build-elections-from-files.ts [--min-year 2014] assembly=file.csv[.gz] ls=file.csv[.gz] ...
// Files are TCPD Lok Dhaba layout (TCPD archive, or in-rolls/eci_results for 2023+ ECI data).
// Rows from several files are merged; AP/TG only; by-elections (Poll_No>0) dropped; rows before --min-year
// dropped (pre-2014 Andhra Pradesh is the undivided state and would pollute AP seat history).
function main() {
  const args = process.argv.slice(2);
  let minYear = 2014;
  const specs: { type: ElectionType; file: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-year") { minYear = Number(args[++i]); continue; }
    const m = /^(assembly|ls)=(.+)$/.exec(args[i]);
    if (m) specs.push({ type: m[1] as ElectionType, file: m[2] });
  }
  if (!specs.length) { console.error("no inputs: pass assembly=<csv> / ls=<csv>"); process.exit(1); }

  const all: CandidateResult[] = [];
  const sources: string[] = [];
  for (const { type, file } of specs) {
    const buf = readFileSync(resolve(file));
    const text = (file.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
    // AP LS 2014 was fought as undivided AP (42 seats incl. Telangana): not comparable, dropped.
    const rows = normalizeTcpd(text, type, "TCPD").filter(r => r.year >= minYear && !(r.state === "AP" && r.type === "ls" && r.year === 2014));
    console.log(`[build] ${file}: ${rows.length} rows`);
    all.push(...rows);
    sources.push(file.split(/[\\/]/).pop()!);
  }
  // Same election appearing in two files (e.g. TCPD + in-rolls overlap): keep one copy per candidate/seat.
  const seen = new Set<string>();
  const results = sortResults(all).filter(r => {
    const k = [r.state, r.year, r.type, r.acNo, r.position, r.candidate].join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const snap = {
    schema: 1 as const, provenance: "TCPD" as const,
    source: `TCPD Lok Dhaba archive (to 2019/2023) + ECI results via in-rolls/eci_results (2023-2026): ${sources.join(", ")}`,
    results,
  };
  try { console.log("[build] validation:", JSON.stringify(validateElections(snap.results, true)).slice(0, 600)); } catch (e) { console.log("[build] validation skipped:", (e as Error).message); }
  writeJson(resolve(GENERATED, "elections.json"), snap);
  const tally = new Map<string, Set<number>>();
  for (const r of results) { const k = `${r.state} ${r.type} ${r.year}`; (tally.get(k) ?? tally.set(k, new Set()).get(k)!).add(r.acNo); }
  for (const [k, v] of [...tally].sort()) console.log(`  ${k}: ${v.size} seats`);
  console.log(`[build] wrote ${results.length} rows`);
}
main();
