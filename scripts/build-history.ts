import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import type { ElectionType } from "../src/lib/states";
import type { CandidateResult } from "../src/lib/elections";
import { GENERATED, ROOT, writeJson } from "../pipeline/io";
import { sortResults } from "../pipeline/normalize";
import { buildPreBifurcation, validatePreBifurcation } from "../pipeline/history/prebifurcation";
import { buildByElections, seatIndexFrom } from "../pipeline/history/byelections";

// Usage: tsx scripts/build-history.ts assembly=<undivided AE csv> ls=<undivided GE csv> byelection:assembly=<csv> byelection:ls=<csv> ...
// Inputs are the public TCPD Lok Dhaba and in-rolls/eci_results files (the same ones used for elections.json); AP and TG rows are kept.
const read = (f: string) => { const b = readFileSync(resolve(f)); return (f.endsWith(".gz") ? gunzipSync(b) : b).toString("utf8"); };
const base = (f: string) => f.split(/[\\/]/).pop()!;

function main() {
  const pre: { type: ElectionType; file: string }[] = [], by: { type: ElectionType; file: string }[] = [];
  for (const a of process.argv.slice(2)) {
    let m = /^(assembly|ls)=(.+)$/.exec(a); if (m) pre.push({ type: m[1] as ElectionType, file: m[2] });
    m = /^byelection:(assembly|ls)=(.+)$/.exec(a); if (m) by.push({ type: m[1] as ElectionType, file: m[2] });
  }
  if (pre.length) {
    const rows: CandidateResult[] = [];
    for (const { type, file } of pre) rows.push(...buildPreBifurcation(read(file), type));
    const results = sortResults(rows);
    const errs = validatePreBifurcation(results);
    if (errs.length) { console.error("pre-bifurcation validation FAILED:\n" + errs.join("\n")); process.exit(1); }
    writeJson(resolve(GENERATED, "history/prebifurcation.json"), {
      schema: 1, provenance: "TCPD", comparability: "pre-bifurcation", asOf: "2026-11-23",
      source: "TCPD Lok Dhaba archive, undivided Andhra Pradesh files (assembly 2009, Lok Sabha 2009 and 2014), split into today's AP and TG seats by the 2008 delimitation order: " + pre.map(p => base(p.file)).join(", "),
      note: "Rows are tagged comparability=pre-bifurcation. Assembly AC 1-119 = Telangana (same numbers), 120-294 = Andhra Pradesh (number minus 119). Lok Sabha PC 1-17 = Telangana, 18-42 = Andhra Pradesh (number minus 17). Pre-2014 party names and seat boundaries are not like-for-like with later elections.",
      results,
    });
    console.log(`[history] pre-bifurcation: ${results.length} rows`);
  }
  if (by.length) {
    const snap = JSON.parse(readFileSync(resolve(GENERATED, "elections.json"), "utf8")) as { results: CandidateResult[] };
    const idx = seatIndexFrom(snap.results);
    const { records, skipped } = buildByElections(by.map(b => ({ csv: read(b.file), type: b.type, source: base(b.file) })), idx);
    const prev = resolve(ROOT, "data/reference/history/byelections.json");
    const existing: { records?: { id: string; cause?: string | null; sources?: string[]; verified?: boolean; crossCheck?: string }[] } = existsSync(prev) ? JSON.parse(readFileSync(prev, "utf8")) : {};
    // Hand-curated fields (cause, extra sources, verified) survive a rebuild.
    const keep = new Map((existing.records ?? []).map(r => [r.id, r]));
    const merged = records.map(r => {
      const k = keep.get(r.id);
      return k ? { ...r, cause: k.cause ?? r.cause, sources: [...new Set([...r.sources, ...(k.sources ?? [])])], verified: k.verified ?? false, ...(k.crossCheck ? { crossCheck: k.crossCheck } : {}) } : r;
    });
    writeJson(prev, {
      schema: 1, asOf: "2026-11-23",
      note: "By-elections and re-polls for AP/TG from 2014 onward. Fields: state, type, seat, date (month precision where the source has it), cause (only where cited; null otherwise), winner, party, margin (votes), sources[], verified (true = cross-checked against a second independent source). A by-election never changes the current member here: that happens only through data/reference/people/members-overlay.json.",
      sourceFiles: [...new Set(by.map(b => base(b.file)))], records: merged,
    });
    console.log(`[history] by-elections: ${merged.length} records; skipped ${skipped.length}`);
    for (const s of skipped) console.log("  skipped:", s);
  }
}
main();
