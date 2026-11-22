/**
 * Count-day read load (S-75, DESIGN_2028 3.8 item 6). Localhost only.
 *
 *   npm run build && npm run load:count      full run (about 1.5 minutes)
 *   npm run load:count -- --smoke          few seconds
 *
 * Starts the production bundle (SERVE_BUILT=1 node dist/server.cjs) on a free port with CIVIC_DB in a temp dir and the edge
 * rate limiter raised (RATE_LIMIT_* only for this read test: a real count-day sits behind a CDN that fans out client IPs),
 * then drives the read-heavy mix a results page produces: election summaries and seat lists, boundary GeoJSON, constituency
 * pages and the app shell. Reports p50/p95/p99 and error rate, and checks cache headers, ETag and 304 behaviour.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fmt, isMain, ROOT, runLoad, startServer, type Stats } from "./harness";

export const MIX: { name: string; path: string }[] = [
  { name: "elections AP (seats+tally)", path: "/api/v1/elections?state=AP&type=assembly" },
  { name: "elections TG (seats+tally)", path: "/api/v1/elections?state=TG&type=assembly" },
  { name: "summary AP", path: "/api/v1/elections/AP/summary" },
  { name: "summary TG", path: "/api/v1/elections/TG/summary" },
  { name: "geojson AP assembly", path: "/api/v1/geo/AP/ac.geojson" },
  { name: "geojson TG assembly", path: "/api/v1/geo/TG/ac.geojson" },
  { name: "constituency page AP/1", path: "/api/v1/constituencies/AP/1" },
  { name: "constituency page TG/10", path: "/api/v1/constituencies/TG/10" },
  { name: "app shell /", path: "/" },
  { name: "lite shell /lite", path: "/lite" },
];

export interface CacheCheck { name: string; path: string; status: number; cacheControl: string; etag: boolean; gzip: boolean; bytes: number; revalidated: number | null }

/** Plain GET without the Cache-Control: max-age=0 that fetch() adds to conditional requests (that header makes static-file freshness checks answer 200). */
const plainGet = (url: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
  http.get(url, { headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }).on("error", reject);
});

/** One GET with gzip, then a conditional GET with the ETag it returned. */
export async function checkCaching(base: string, p: string): Promise<Omit<CacheCheck, "name">> {
  const r = await fetch(base + p, { headers: { "accept-encoding": "gzip" } });
  const body = await r.arrayBuffer();
  const etag = r.headers.get("etag");
  let revalidated: number | null = null;
  if (etag) revalidated = await plainGet(base + p, { "accept-encoding": "gzip", "if-none-match": etag });
  return { path: p, status: r.status, cacheControl: r.headers.get("cache-control") ?? "(none)", etag: !!etag, gzip: r.headers.get("content-encoding") === "gzip", bytes: body.byteLength, revalidated };
}

export interface CountDayResult { mode: string; caching: CacheCheck[]; mixed: { connections: number; stats: Stats }[]; perEndpoint: { name: string; stats: Stats }[]; compression: { path: string; gzip: Stats; identity: Stats }[]; ok: boolean; problems: string[] }

export async function runCountDay(opts: { smoke?: boolean } = {}): Promise<CountDayResult> {
  const smoke = !!opts.smoke;
  const srv = await startServer({ RATE_LIMIT_BURST: "1000000000", RATE_LIMIT_PER_SEC: "1000000000" });
  const problems: string[] = [];
  try {
    const caching: CacheCheck[] = [];
    for (const m of MIX) caching.push({ name: m.name, ...(await checkCaching(srv.base, m.path)) });
    for (const c of caching) {
      if (c.status !== 200) problems.push(`${c.path} answered ${c.status}`);
      else if (c.etag && c.revalidated !== 304) problems.push(`${c.path} has an ETag but a conditional GET returned ${c.revalidated}, not 304`);
    }
    const headers = { "accept-encoding": "gzip" };
    const requests = MIX.map((m) => ({ method: "GET", path: m.path }));
    const mixed: CountDayResult["mixed"] = [];
    for (const connections of smoke ? [30] : [200, 500]) {
      const stats = await runLoad({ url: srv.base, connections, duration: smoke ? 3 : 15, requests, headers, timeout: 30 });
      mixed.push({ connections, stats });
      const errRate = (stats.non2xx + stats.errors + stats.timeouts) / Math.max(1, stats.requests);
      // 5xx are never acceptable. Up to 200 connections the run must be clean and p99 under 3 s. 500 connections is a stress level on ONE node process
      // (the design serves count-day from CDN snapshots): it is reported, and only 5xx fail it.
      if (stats.fiveXX > 0) problems.push(`mixed @${connections}: ${stats.fiveXX} 5xx`);
      else if (connections <= 200 && (stats.errors > 0 || stats.timeouts > 0 || errRate > 0.001 || stats.p99 > 3000)) problems.push(`mixed @${connections}: ${stats.errors} errors, ${stats.timeouts} timeouts, error rate ${(errRate * 100).toFixed(2)}%, p99 ${stats.p99} ms`);
    }
    const perEndpoint: CountDayResult["perEndpoint"] = [];
    if (!smoke) for (const m of MIX) perEndpoint.push({ name: m.name, stats: await runLoad({ url: srv.base, connections: 100, duration: 5, requests: [{ method: "GET", path: m.path }], headers, timeout: 30 }) });
    // Hotspot probe: the same URL with and without Accept-Encoding: gzip (server/security.ts compresses every response on the fly).
    const compression: CountDayResult["compression"] = [];
    if (!smoke) for (const p of ["/api/v1/geo/AP/ac.geojson", "/api/v1/elections?state=AP&type=assembly"]) {
      const one = (h: Record<string, string>) => runLoad({ url: srv.base, connections: 100, duration: 4, requests: [{ method: "GET", path: p }], headers: h, timeout: 30 });
      compression.push({ path: p, gzip: await one(headers), identity: await one({}) });
    }
    return { mode: srv.mode, caching, mixed, perEndpoint, compression, ok: problems.length === 0, problems };
  } finally { await srv.stop(); }
}

export function report(r: CountDayResult): string {
  const L: string[] = [`server: ${r.mode} bundle`, "", "cache headers (gzip GET, then conditional GET):"];
  for (const c of r.caching) L.push(`  ${c.name.padEnd(28)} ${c.status} ${String(c.bytes).padStart(8)} B gzip=${c.gzip ? "y" : "n"} etag=${c.etag ? "y" : "n"} 304=${c.revalidated === null ? "-" : c.revalidated} cache-control: ${c.cacheControl}`);
  L.push("", "mixed read load:");
  for (const m of r.mixed) L.push(`  ${m.connections} connections: ${fmt(m.stats)}`);
  if (r.perEndpoint.length) { L.push("", "per endpoint, 100 connections:"); for (const e of r.perEndpoint) L.push(`  ${e.name.padEnd(28)} ${fmt(e.stats)}`); }
  if (r.compression.length) { L.push("", "compression cost, 100 connections (gzip on the fly vs identity):"); for (const c of r.compression) L.push(`  ${c.path}`, `    gzip     ${fmt(c.gzip)}`, `    identity ${fmt(c.identity)}`); }
  L.push("", r.ok ? "PASS" : "FAIL", ...r.problems.map((p) => "  " + p));
  return L.join("\n");
}

if (isMain(import.meta.url)) {
  if (!fs.existsSync(path.join(ROOT, "dist", "server.cjs"))) console.warn("dist/server.cjs not found: run `npm run build` first for production-bundle numbers; falling back to tsx.");
  const r = await runCountDay({ smoke: process.argv.includes("--smoke") });
  console.log(report(r));
  process.exit(r.ok ? 0 : 1);
}
