/**
 * S-90: village / hamlet points for AP and TG. SHRUG (CC BY-NC-SA) is deliberately not used.
 *
 *   1. Wikidata (CC0): items with P5578 (Indian census area code 2011) + P625 coordinates, one SPARQL query per state, joined to LGD by census code.
 *   2. OpenStreetMap (ODbL) place=village|hamlet nodes, one small Overpass query per LGD district bounding box (sequential, cached),
 *      used only for LGD villages that Wikidata does not cover; joined by name inside the mandal / district.
 *
 *   data/generated/geo/village-points-wikidata-{AP,TG}.json   CC0 layer
 *   data/generated/geo/village-points-osm-{AP,TG}.json        ODbL layer (gap fill only)
 *   data/generated/geo/village-points-coverage.json           honest coverage + gaps (like mandal-coverage.json)
 *
 * Politeness: descriptive UA, one request at a time, 8 s gap for Wikidata, 15 s gap for Overpass, retries with back-off,
 * raw responses cached in data/raw/geo-village (gitignored), so a rerun is offline. No bulk polygon queries.
 * Usage: npx tsx scripts/fetch-village-points.ts [--offline] [--no-osm]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateCode } from "../src/lib/states";
import { bbox, type Geom } from "../pipeline/geo/geometry";
import { matchOsm, matchWikidata, parseOverpassNodes, parseWikidataVillages, POINT_COLUMNS, POINT_THRESHOLD, toPointArrays, type OsmNode, type PointRow } from "../pipeline/geo/villagepoints";
import { GEO_OUT, readJsonFile, writeCompact } from "../pipeline/geo/util";
import { ROOT } from "../pipeline/io";

const UA = "TeluguPulseGeoPipeline/1.0 (open civic data research; low-volume; one-off village point build)";
const RAW = join(ROOT, "data", "raw", "geo-village");
const WD_STATE: Record<StateCode, string> = { AP: "Q1159", TG: "Q677037" };
const offline = process.argv.includes("--offline"), noOsm = process.argv.includes("--no-osm");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function polite(url: string, init: RequestInit, gapMs: number, timeoutMs: number): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(gapMs);
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      console.warn(`[villages] HTTP ${res.status}; backing off`);
    } catch (e) { console.warn(`[villages] ${(e as Error).message}; backing off`); }
    await sleep(20000 * (attempt + 1));
  }
  throw new Error("request failed after retries");
}

async function wikidata(state: StateCode) {
  const f = join(RAW, `wd-villages-${state}.json`);
  if (!existsSync(f)) {
    if (offline) throw new Error(`offline and ${f} missing`);
    const q = `SELECT ?item ?cen ?co WHERE { ?item wdt:P5578 ?cen; wdt:P625 ?co; wdt:P131+ wd:${WD_STATE[state]}. }`;
    const res = await polite(`https://query.wikidata.org/sparql?query=${encodeURIComponent(q)}`, { headers: { Accept: "application/sparql-results+json" } }, 8000, 170000);
    mkdirSync(RAW, { recursive: true }); writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  }
  return parseWikidataVillages(JSON.parse(readFileSync(f, "utf8")));
}

async function overpass(state: StateCode, districtLgd: string, geom: Geom): Promise<OsmNode[] | null> {
  const f = join(RAW, `osm-${state}-${districtLgd}.json`);
  if (!existsSync(f)) {
    if (offline) return null;
    const [w, s, e, n] = bbox(geom);
    const q = `[out:json][timeout:150];node["place"~"^(village|hamlet)$"](${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)});out body;`;
    try {
      const res = await polite("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) }, 15000, 200000);
      const text = await res.text();
      JSON.parse(text); // reject a non-JSON (error page) body before caching
      mkdirSync(RAW, { recursive: true }); writeFileSync(f, text);
    } catch (e) { console.warn(`[villages] Overpass district ${districtLgd} failed: ${(e as Error).message}`); return null; }
  }
  return parseOverpassNodes(JSON.parse(readFileSync(f, "utf8")));
}

const fileBody = (state: StateCode, layer: "wikidata" | "osm", asOf: string, rows: PointRow[]) => ({
  schema: 1, state, layer, asOf, columns: POINT_COLUMNS,
  attribution: layer === "wikidata"
    ? "Village locations: Wikidata (CC0), joined to LGD village codes by Census 2011 code by People Pulse."
    : "(c) OpenStreetMap contributors, ODbL 1.0. Place nodes joined to LGD village codes by name by People Pulse; only villages with no Wikidata point, confidence >= " + POINT_THRESHOLD + ".",
  license: layer === "wikidata" ? "CC0-1.0" : "ODbL-1.0", precision: "a place node or Wikidata coordinate, not a surveyed centroid or boundary",
  points: toPointArrays(rows),
});

async function main() {
  const asOf = new Date().toISOString().slice(0, 10);
  const report: Record<string, unknown> = {
    schema: 1, asOf,
    method: "Wikidata P5578 (Census 2011 code) + P625 -> LGD village by census code; OSM place nodes by name in mandal/district for the remainder",
    threshold: POINT_THRESHOLD,
    licence: "Wikidata CC0 layer; OpenStreetMap contributors ODbL 1.0 layer (share-alike for derived databases; attribution required). SHRUG not used.",
    polygons: "Village polygons are NOT shipped: no licence-compatible village polygon source exists for AP/TG (see docs/decisions/S-90-village-boundaries.md).",
  };
  for (const state of ["AP", "TG"] as StateCode[]) {
    const lgd = readJsonFile(join(GEO_OUT, `lgd-${state}.json`));
    const villages = (lgd.villages as (string | number)[][]).map(v => ({ code: String(v[0]), name: String(v[1]), mandalCode: String(v[3]), census: String(v[4]) }));
    const mandals = (lgd.mandals as string[][]).map(m => ({ code: m[0], districtCode: m[2] }));
    const districtFc = readJsonFile(join(GEO_OUT, `district-${state}.geojson`));
    const districtPolys = districtFc.features.map((f: any) => ({ code: String(f.properties.districtLgd), geometry: f.geometry }));
    const mandalFc = existsSync(join(GEO_OUT, `mandal-${state}.geojson`)) ? readJsonFile(join(GEO_OUT, `mandal-${state}.geojson`)) : { features: [] };
    const mandalPolys = mandalFc.features.map((f: any) => ({ code: String(f.properties.lgdCode), geometry: f.geometry }));

    const wd = matchWikidata(await wikidata(state), villages, mandals, districtPolys);
    writeCompact(join(GEO_OUT, `village-points-wikidata-${state}.json`), fileBody(state, "wikidata", asOf, wd.rows), 2);
    const have = new Map(wd.rows.map(r => [r.lgdCode, [r.lon, r.lat] as [number, number]]));

    let osmRows: PointRow[] = [], osmReport: unknown = { skipped: noOsm ? "--no-osm" : undefined };
    if (!noOsm) {
      const nodes = new Map<number, OsmNode>(), failed: string[] = [];
      for (const d of districtPolys) {
        const got = await overpass(state, d.code, d.geometry);
        if (!got) { failed.push(d.code); continue; }
        for (const n of got) nodes.set(n.id, n);
      }
      const m = matchOsm([...nodes.values()], villages, mandals, mandalPolys, districtPolys, have);
      osmRows = m.rows; osmReport = { ...m.counts, agreementWithWikidata: m.agreement, districtsFailedToDownload: failed, districtsQueried: districtPolys.length };
    }
    writeCompact(join(GEO_OUT, `village-points-osm-${state}.json`), fileBody(state, "osm", asOf, osmRows), 2);

    const withPoint = new Set([...wd.rows, ...osmRows].map(r => r.lgdCode));
    const missing = villages.filter(v => !withPoint.has(v.code));
    report[state] = {
      lgdVillages: villages.length, withPoint: withPoint.size, coveragePct: Math.round((withPoint.size / villages.length) * 1000) / 10,
      wikidata: { shipped: wd.rows.length, ...wd.counts }, osm: { shipped: osmRows.length, detail: osmReport },
      rejectedWikidataTotal: wd.rejected.length,
      rejectedWikidataSamples: Object.fromEntries([...new Set(wd.rejected.map(r => r.reason))].map(reason => [reason, wd.rejected.filter(r => r.reason === reason).slice(0, 25).map(r => `${r.census} ${r.qids.join("/")}`)])),
      lgdVillagesWithoutPointTotal: missing.length,
      lgdVillagesWithoutPointByMandal: Object.entries(missing.reduce<Record<string, number>>((a, v) => (a[v.mandalCode] = (a[v.mandalCode] ?? 0) + 1, a), {}))
        .sort((a, b) => b[1] - a[1]).slice(0, 40).map(([m, n]) => `${m} (${lgd.mandals.find((x: string[]) => x[0] === m)?.[1] ?? "?"}): ${n}`),
    };
    console.log(`[villages] ${state}: ${withPoint.size}/${villages.length} (${(report[state] as any).coveragePct}%): wikidata ${wd.rows.length}, osm ${osmRows.length}`);
  }
  writeCompact(join(GEO_OUT, "village-points-coverage.json"), report, 3);
}
main().catch(e => { console.error("[villages] " + e.message); process.exit(1); });
