/**
 * S-91: drop-in importer for an OPERATOR-SUPPLIED polling-station reference CSV (data/raw/pollingstations/<STATE>-*.csv, gitignored).
 * Accepts station number, name, AC number, part number, location text, optional lat/lon, source, asOf; rejects the whole file when it
 * carries voter-level columns (electoral-roll extract) and fails when any row is invalid. Electoral-roll PDFs are never read.
 * Output: data/generated/geo/polling-stations-<STATE>.json with per-file provenance (name, sha256, rows).
 * Usage: npx tsx scripts/import-pollingstations.ts [--source "CEO AP polling station list"] [--as-of YYYY-MM-DD]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATES, isStateCode, type StateCode } from "../src/lib/states";
import { LegalGuardError, parseStationCsv, validateStations, type PollingStation } from "../pipeline/geo/pollingstations";
import { GEO_OUT, writeCompact } from "../pipeline/geo/util";
import { ROOT } from "../pipeline/io";

export function importPollingStations(rawDir: string, outDir: string, ctx: { source: string; asOf: string }): { state: StateCode; stations: number; files: number }[] {
  const out: { state: StateCode; stations: number; files: number }[] = [];
  if (!existsSync(rawDir)) return out;
  const byState = new Map<StateCode, { stations: PollingStation[]; files: { name: string; sha256: string; rows: number }[] }>();
  for (const name of readdirSync(rawDir).filter(f => /\.csv$/i.test(f)).sort()) {
    const st = name.slice(0, 2).toUpperCase();
    if (!isStateCode(st)) throw new Error(`${name}: file name must start with AP or TG (e.g. AP-polling-stations.csv)`);
    if (!statSync(join(rawDir, name)).isFile()) continue;
    const r = parseStationCsv(readFileSync(join(rawDir, name), "utf8"), ctx);
    if (r.rejected.length) throw new Error(`${name}: ${r.rejected.length} invalid row(s); first: row ${r.rejected[0].row}: ${r.rejected[0].errors.join("; ")}`);
    const bad = r.records.filter(s => s.acNo > STATES[st].assemblySeats);
    if (bad.length) throw new Error(`${name}: AC number ${bad[0].acNo} is above ${STATES[st].assemblySeats} (${st})`);
    const e = byState.get(st) ?? byState.set(st, { stations: [], files: [] }).get(st)!;
    e.stations.push(...r.records); e.files.push({ name, sha256: r.sha256, rows: r.rows });
  }
  for (const [state, e] of byState) {
    const dup = validateStations(e.stations);
    if (dup.length) throw new Error(`${state}: ${dup[0]}`);
    e.stations.sort((a, b) => a.acNo - b.acNo || a.stationNo.localeCompare(b.stationNo, "en", { numeric: true }));
    writeCompact(join(outDir, `polling-stations-${state}.json`), {
      schema: 1, state, asOf: e.stations.map(s => s.asOf).sort().pop(), provenance: "operator-supplied",
      note: "Polling-station reference list only (no voter-level data). Supplied by the operator from a public CEO/ECI list; see data/reference/pollingstations/README.md.",
      files: e.files, records: e.stations,
    }, 2);
    out.push({ state, stations: e.stations.length, files: e.files.length });
  }
  return out;
}

if (process.argv[1] && /import-pollingstations\.ts$/.test(process.argv[1].split("\\").join("/"))) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const res = importPollingStations(join(ROOT, "data", "raw", "pollingstations"), GEO_OUT, { source: arg("--source") ?? "operator-supplied polling station list", asOf: arg("--as-of") ?? new Date().toISOString().slice(0, 10) });
    if (!res.length) console.log("[pollingstations] nothing to import: put <STATE>-*.csv files in data/raw/pollingstations/ (see data/reference/pollingstations/README.md)");
    for (const r of res) console.log(`[pollingstations] ${r.state}: ${r.stations} stations from ${r.files} file(s). Now run npm run pipeline:manifest.`);
  } catch (e) {
    console.error(`[pollingstations] ${e instanceof LegalGuardError ? "LEGAL GUARD " : ""}${(e as Error).message}`);
    process.exit(1);
  }
}
