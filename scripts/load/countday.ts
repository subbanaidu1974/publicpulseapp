/**
 * Static count-day snapshot serving path (S-41). Localhost only.
 *   npm run build && npm run load:countday           full (200 and 500 connections)
 *   npm run load:countday -- --smoke                 few seconds
 * Seeds a temp COUNTDAY_DIR with SYNTHETIC signed snapshots (AP, 60 seats, 6 snapshots), starts the production bundle with COUNTDAY_DIR pointing at it,
 * and drives /latest, a numbered snapshot, a per-seat file and /keys. Also checks ETag/304 and the immutable cache header on numbered snapshots.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestOnce } from "../../pipeline/countday/ingest";
import { FixtureSource } from "../../pipeline/countday/sources";
import { signerFromKeys } from "../../server/countday/signer";
import { fmt, isMain, runLoad, startServer, type Stats } from "./harness";

export const PATHS = ["/api/v1/countday/AP/latest", "/api/v1/countday/AP/snapshots/3", "/api/v1/countday/AP/ac/7", "/api/v1/countday/keys"];

export async function seed(dir: string, steps = 6, acs = 60): Promise<void> {
  const src = new FixtureSource({ state: "AP", acCount: acs, step: 1 }), signer = signerFromKeys();
  for (let i = 0; i < steps; i++) { await ingestOnce({ dir, state: "AP", source: src, signer, now: new Date(Date.UTC(2099, 4, 4, 8, i)) }); src.advance(); }
}

export async function runCountdayLoad(opts: { smoke?: boolean } = {}): Promise<{ ok: boolean; problems: string[]; mixed: { connections: number; stats: Stats }[]; mode: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "countday-load-"));
  await seed(dir);
  const srv = await startServer({ RATE_LIMIT_BURST: "1000000000", RATE_LIMIT_PER_SEC: "1000000000", COUNTDAY_DIR: dir, COUNTDAY_ALLOW_SYNTHETIC: "1" });
  const problems: string[] = [], mixed: { connections: number; stats: Stats }[] = [];
  try {
    for (const p of PATHS) {
      const r = await fetch(srv.base + p, { headers: { "accept-encoding": "gzip" } });
      await r.arrayBuffer();
      const et = r.headers.get("etag"), cc = r.headers.get("cache-control") ?? "";
      if (r.status !== 200) problems.push(`${p} answered ${r.status}`);
      if (p.includes("/snapshots/") && !/immutable/.test(cc)) problems.push(`${p} is not immutable-cached: ${cc}`);
      if (et) { const c = await fetch(srv.base + p, { headers: { "if-none-match": et } }); if (c.status !== 304) problems.push(`${p} conditional GET answered ${c.status}`); }
    }
    for (const connections of opts.smoke ? [30] : [200, 500]) {
      const stats = await runLoad({ url: srv.base, connections, duration: opts.smoke ? 3 : 15, requests: PATHS.map((p) => ({ method: "GET", path: p })), headers: { "accept-encoding": "gzip" }, timeout: 30 });
      mixed.push({ connections, stats });
      if (stats.fiveXX > 0 || stats.errors > 0 || stats.non2xx > 0) problems.push(`@${connections}: ${stats.fiveXX} 5xx, ${stats.errors} errors, ${stats.non2xx} non-2xx`);
    }
    return { ok: problems.length === 0, problems, mixed, mode: srv.mode };
  } finally { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const r = await runCountdayLoad({ smoke: process.argv.includes("--smoke") });
  console.log(`server: ${r.mode} bundle`);
  for (const m of r.mixed) console.log(`${m.connections} connections: ${fmt(m.stats)}`);
  console.log(r.ok ? "PASS" : "FAIL", ...r.problems);
  process.exit(r.ok ? 0 : 1);
}
