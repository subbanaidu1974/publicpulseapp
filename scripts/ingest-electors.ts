/**
 * Electors by assembly constituency (AP 175, TG 119) from the ECI GE-2024 statistical report, table 15.
 * Source (robots.txt allows all, no login, verified 2026-11-24):
 *   https://www.eci.gov.in/eci-backend/public/all_files/GE-2024-statistical-report/15-Assembly-SegmentWise-Information-Electors.pdf
 * Usage: tsx scripts/ingest-electors.ts [--download] [path/to/pdf]   (needs `pdftotext` from poppler on PATH)
 * Writes data/generated/electors-ac.json. AC numbers come from the committed elections.json (matched by name, then every
 * row is cross-checked); anything unmatched is reported and the run fails rather than guessing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, ROOT, writeJson } from "../pipeline/io";
import { normAcName, parseElectorsText, validateElectors, type ElectorsRow } from "../pipeline/electors";

const URL_ = "https://www.eci.gov.in/eci-backend/public/all_files/GE-2024-statistical-report/15-Assembly-SegmentWise-Information-Electors.pdf";
const RAW = resolve(ROOT, "data/raw/electors");

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const pdf = resolve(args[0] ?? resolve(RAW, "ge2024-15-ac-electors.pdf"));
  if (process.argv.includes("--download") || !existsSync(pdf)) {
    mkdirSync(RAW, { recursive: true });
    const res = await fetch(URL_, { headers: { "User-Agent": "PeoplePulse-pipeline/0.1 (open-data ingest)" } });
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
    writeFileSync(pdf, Buffer.from(await res.arrayBuffer()));
  }
  const t = spawnSync("pdftotext", ["-raw", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (t.status !== 0) throw new Error(`pdftotext failed: ${t.error?.message ?? t.stderr}`);
  const raw = parseElectorsText(t.stdout);
  const errs = validateElectors(raw);
  if (errs.length) throw new Error(`${errs.length} inconsistent rows, first: ${errs[0]}`);

  const elections = JSON.parse(readFileSync(resolve(GENERATED, "elections.json"), "utf8")) as { results: { state: string; year: number; type: string; acNo: number; acName: string; electors?: number }[] };
  const names = new Map<string, Map<string, Set<number>>>();
  // Latest assembly election per state (AP 2024, TG 2023) so seat names and reservation tags match the current delimitation.
  const latest = new Map<string, number>();
  for (const r of elections.results) if (r.type === "assembly") latest.set(r.state, Math.max(latest.get(r.state) ?? 0, r.year));
  for (const r of elections.results) {
    if (r.type !== "assembly" || r.year !== latest.get(r.state)) continue;
    const m = names.get(r.state) ?? new Map<string, Set<number>>();
    const k = normAcName(r.acName);
    (m.get(k) ?? m.set(k, new Set()).get(k)!).add(r.acNo);
    names.set(r.state, m);
  }
  const rows: ElectorsRow[] = [];
  const bad: string[] = [];
  for (const r of raw) {
    // Fallback: the results file sometimes omits the (SC)/(ST) tag that the ECI table prints.
    const nos = names.get(r.state)?.get(normAcName(r.acName)) ?? names.get(r.state)?.get(normAcName(r.acName.replace(/\s*\((SC|ST)\)\s*$/i, "")));
    if (!nos || nos.size !== 1) { bad.push(`${r.state} ${r.acName} -> ${nos ? [...nos].join("/") : "no match"}`); continue; }
    rows.push({ ...r, acNo: [...nos][0] });
  }
  const count = (s: string) => rows.filter(r => r.state === s).length;
  const dup = rows.map(r => `${r.state}${r.acNo}`).filter((k, i, a) => a.indexOf(k) !== i);
  if (bad.length || dup.length || count("AP") !== 175 || count("TG") !== 119) {
    throw new Error(`AC mapping incomplete: AP=${count("AP")}/175 TG=${count("TG")}/119 dup=${dup.join(",")} unmatched=${bad.join("; ")}`);
  }
  rows.sort((a, b) => a.state.localeCompare(b.state) || a.acNo - b.acNo);
  writeJson(resolve(GENERATED, "electors-ac.json"), {
    schema: 1,
    provenance: "eci-ge2024-statistical-report",
    asOf: "2024",
    source: "Election Commission of India, General Election 2024 (18th Lok Sabha) statistical report, table 15 Assembly segment wise information of electors; " + URL_,
    note: "Electors on the rolls used for the 2024 general election (not SSR 2025). Counts only; votesPolledEvm is valid votes plus NOTA on EVM and excludes postal ballots.",
    rows,
  });
  console.log(`[electors] AP=${count("AP")} TG=${count("TG")} rows written`);
}

main().catch(e => { console.error("[electors] failed:", (e as Error).message); process.exit(1); });
