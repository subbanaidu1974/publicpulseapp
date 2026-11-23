/**
 * Count-day ingest (S-41). Runs as its own process, separate from the web server. Writes signed static snapshots into COUNTDAY_DIR.
 *   tsx scripts/countday-ingest.ts --state AP --source fixture --steps 4        SYNTHETIC demo (refused in production unless COUNTDAY_ALLOW_SYNTHETIC=1)
 *   tsx scripts/countday-ingest.ts --state AP --source file-drop --path <dir|file> [--loop 30]
 *   tsx scripts/countday-ingest.ts --state AP --source http                      needs COUNTDAY_HTTP_URL (no default)
 * Fallback: --fallback tcpd --year 2024 [--not-before <ISO>] uses data/generated/elections.json (delayed, post-count only).
 * Nothing here scrapes any site.
 */
import fs from "node:fs";
import path from "node:path";
import { ingestOnce } from "../pipeline/countday/ingest";
import { FileDropSource, FixtureSource, HttpSource, TcpdDelayedSource } from "../pipeline/countday/sources";
import type { ResultsSource } from "../pipeline/countday/types";
import { loadDatasets } from "../server/api";
import { signerFromKeys } from "../server/countday/signer";
import { loadLinks } from "../server/countday/links";
import { countDir } from "../server/countday/router";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };

async function main() {
  const state = (arg("state") ?? "AP").toUpperCase(), kind = arg("source") ?? process.env.COUNTDAY_SOURCE ?? "";
  const dir = arg("dir") ?? countDir();
  let source: ResultsSource;
  let fixture: FixtureSource | null = null;
  if (kind === "fixture") {
    if (process.env.NODE_ENV === "production" && process.env.COUNTDAY_ALLOW_SYNTHETIC !== "1") throw new Error("the SYNTHETIC fixture is refused in production (COUNTDAY_ALLOW_SYNTHETIC=1 to override)");
    fixture = new FixtureSource({ state, step: 1, acCount: Number(arg("acs", "12")), correctionAtStep: arg("correction-at") ? Number(arg("correction-at")) : undefined });
    source = fixture;
  } else if (kind === "file-drop") source = new FileDropSource(arg("path") ?? process.env.COUNTDAY_FILE_DROP_DIR ?? "");
  else if (kind === "http") source = new HttpSource({ url: process.env.COUNTDAY_HTTP_URL, headers: process.env.COUNTDAY_HTTP_TOKEN ? { authorization: `Bearer ${process.env.COUNTDAY_HTTP_TOKEN}` } : {} });
  else throw new Error("no source configured: use --source fixture|file-drop|http (or COUNTDAY_SOURCE)");
  let fallback: ResultsSource | null = null;
  if ((arg("fallback") ?? process.env.COUNTDAY_FALLBACK) === "tcpd") {
    const d = loadDatasets();
    const nb = arg("not-before") ?? process.env.COUNTDAY_FALLBACK_NOT_BEFORE;
    fallback = new TcpdDelayedSource({ elections: d.elections, state, year: Number(arg("year", "2024")), electionType: "assembly", asOf: d.status.find((s) => s.name === "elections")?.generatedAt ?? new Date(0).toISOString(), notBefore: nb ? new Date(nb) : undefined });
  }
  fs.mkdirSync(dir, { recursive: true });
  const signer = signerFromKeys();
  const steps = Number(arg("steps", "1")), loop = Number(arg("loop", "0"));
  const run = async () => { const r = await ingestOnce({ dir, state, source, fallback, signer, config: { links: loadLinks(state) } }); console.log(JSON.stringify({ state, ...r })); };
  for (let i = 0; i < steps; i++) { await run(); fixture?.advance(); }
  if (loop > 0) for (;;) { await new Promise((r) => setTimeout(r, loop * 1000)); await run(); fixture?.advance(); }
  console.log(`written to ${path.resolve(dir)} with key ${signer.keyId}`);
}
main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
