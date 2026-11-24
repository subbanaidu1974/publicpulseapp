/**
 * S-89: mandal polygons for AP and TG from OpenStreetMap (ODbL), located through Wikidata property P402 (OSM relation id) and
 * downloaded through the public Nominatim lookup endpoint (relations assembled server side, polygon_threshold simplified).
 * Joined to LGD mandals by English name with an explicit confidence; only units at or above MATCH_THRESHOLD are written.
 *
 *   data/generated/geo/mandal-AP.geojson, mandal-TG.geojson   matched polygons only (ODbL, attribution in the file)
 *   data/generated/geo/mandal-coverage.json                   coverage per state, rejected and unmatched units
 *
 * Politeness: generic User-Agent, 1 request per 1.5 s to Nominatim (policy: max 1/s), at most 8 requests then a 20 s pause,
 * retries with back-off, raw responses cached in data/raw/geo-mandal (gitignored) so a rerun is mostly offline.
 * Usage: npx tsx scripts/fetch-mandals.ts [--offline]   (offline: only use the cache)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateCode } from "../src/lib/states";
import { countVertices, geomErrors, simplifyGeom, type Geom } from "../pipeline/geo/geometry";
import { matchMandals, MATCH_THRESHOLD, parseOsmMandals, type OsmMandal } from "../pipeline/geo/mandals";
import { GEO_OUT, readJsonFile, writeCompact } from "../pipeline/geo/util";
import { ROOT } from "../pipeline/io";

const UA = "TeluguPulseGeoPipeline/1.0 (open civic data research; low-volume; one-off boundary build)";
const RAW = join(ROOT, "data", "raw", "geo-mandal");
const WD_CLASS: Record<StateCode, string> = { AP: "Q122987710", TG: "Q122987738" };
const offline = process.argv.includes("--offline");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let burst = 0;

async function politeFetch(url: string, accept: string, gapMs: number): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (burst >= 8) { console.log("[mandals] pausing 20 s after 8 requests"); await sleep(20000); burst = 0; }
    await sleep(gapMs); burst++;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(120000) });
      if (res.ok) return res;
      console.warn(`[mandals] HTTP ${res.status}; backing off`);
    } catch (e) { console.warn(`[mandals] ${(e as Error).message}; backing off`); }
    await sleep(15000 * (attempt + 1));
  }
  throw new Error("request failed after retries");
}

async function wikidata(state: StateCode): Promise<OsmMandal[]> {
  const f = join(RAW, `wd-${state}.json`);
  if (!existsSync(f)) {
    if (offline) throw new Error(`offline and ${f} missing`);
    const q = `SELECT ?item ?en ?o ?parentLabel WHERE { ?item wdt:P31 wd:${WD_CLASS[state]}. OPTIONAL{?item rdfs:label ?en FILTER(lang(?en)="en")} OPTIONAL{?item wdt:P402 ?o} OPTIONAL{?item wdt:P131 ?p. ?p rdfs:label ?parentLabel FILTER(lang(?parentLabel)="en")} }`;
    const res = await politeFetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(q)}`, "application/sparql-results+json", 6000);
    mkdirSync(RAW, { recursive: true }); writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  }
  return parseOsmMandals(JSON.parse(readFileSync(f, "utf8")));
}

async function nominatim(rels: number[]): Promise<Map<number, Geom>> {
  const out = new Map<number, Geom>();
  const BATCH = 30;
  for (let i = 0; i < rels.length; i += BATCH) {
    const ids = rels.slice(i, i + BATCH);
    const f = join(RAW, `nom-${ids[0]}-${ids.length}.json`);
    if (!existsSync(f)) {
      if (offline) continue;
      const url = `https://nominatim.openstreetmap.org/lookup?osm_ids=${ids.map(r => "R" + r).join(",")}&format=geojson&polygon_geojson=1&polygon_threshold=0.0004`;
      try {
        const res = await politeFetch(url, "application/geo+json", 1500);
        mkdirSync(RAW, { recursive: true }); writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      } catch (e) { console.warn(`[mandals] batch at ${ids[0]} failed: ${(e as Error).message}`); continue; }
    }
    for (const ft of JSON.parse(readFileSync(f, "utf8")).features ?? []) {
      const id = Number(ft.properties?.osm_id);
      if (ft.properties?.osm_type === "relation" && ft.geometry && (ft.geometry.type === "Polygon" || ft.geometry.type === "MultiPolygon")) out.set(id, ft.geometry);
    }
  }
  return out;
}

async function main() {
  const lgdFiles = { AP: readJsonFile(join(GEO_OUT, "lgd-AP.json")), TG: readJsonFile(join(GEO_OUT, "lgd-TG.json")) };
  const report: Record<string, unknown> = {
    schema: 1, asOf: new Date().toISOString().slice(0, 10),
    method: "Wikidata P402 (OSM relation id) -> OSM relation geometry via Nominatim lookup -> join to LGD mandals by English name",
    threshold: MATCH_THRESHOLD,
    licence: "OpenStreetMap contributors, ODbL 1.0 (share-alike for derived databases; attribution required)",
  };
  for (const state of ["AP", "TG"] as StateCode[]) {
    const items = await wikidata(state);
    const geoms = await nominatim(items.map(i => i.osmRel));
    const withGeom = items.filter(i => geoms.has(i.osmRel)).map(i => ({ ...i, geometry: geoms.get(i.osmRel)! }));
    const lgd = lgdFiles[state];
    const districtFc = readJsonFile(join(GEO_OUT, `district-${state}.geojson`));
    const rep = matchMandals(
      withGeom,
      lgd.mandals.map((m: string[]) => ({ code: m[0], name: m[1], districtCode: m[2] })),
      lgd.districts.map((d: string[]) => ({ code: d[0], name: d[1] })),
      districtFc.features.map((f: any) => ({ code: String(f.properties.districtLgd), geometry: f.geometry })),
    );
    const dname = new Map<string, string>(lgd.districts.map((d: string[]) => [d[0], d[1]]));
    const feats: any[] = [];
    const geomRejected: string[] = [];
    for (const m of rep.matches) {
      const raw = geoms.get(m.osmRel)!;
      const g = simplifyGeom(raw, 0.0008, 4, 1e-6);
      const errs = g ? geomErrors(g) : ["collapsed"];
      if (!g || errs.length) { geomRejected.push(`${m.lgdCode} ${m.lgdName}: ${errs.join(", ")}`); continue; }
      feats.push({
        type: "Feature",
        properties: { state, lgdCode: m.lgdCode, name: m.lgdName, districtLgd: m.districtCode, district: dname.get(m.districtCode), osmRelation: m.osmRel, wikidata: m.qid, confidence: m.confidence },
        geometry: g,
      });
    }
    feats.sort((a, b) => Number(a.properties.lgdCode) - Number(b.properties.lgdCode));
    writeCompact(join(GEO_OUT, `mandal-${state}.geojson`), {
      type: "FeatureCollection", name: `mandal-${state}`, asOf: report.asOf,
      attribution: "(c) OpenStreetMap contributors, ODbL 1.0. Mandal polygons simplified and joined to LGD codes by People Pulse; only units matched with confidence >= " + MATCH_THRESHOLD + " are included.",
      license: "ODbL-1.0", approximate: true, features: feats,
    }, 2);
    const total = lgd.mandals.length;
    report[state] = {
      lgdMandals: total, osmRelationsWithWikidata: items.length, geometryDownloaded: withGeom.length, shipped: feats.length,
      coveragePct: Math.round((feats.length / total) * 1000) / 10, vertices: feats.reduce((s, f) => s + countVertices(f.geometry), 0),
      confidenceBands: { "1.0": feats.filter(f => f.properties.confidence === 1).length, "0.9": feats.filter(f => f.properties.confidence === 0.9).length, "0.85": feats.filter(f => f.properties.confidence === 0.85).length },
      geometryRejected: geomRejected, rejected: rep.rejected, lgdUnmatched: rep.lgdUnmatched.map(u => `${u.code} ${u.name}`),
      downloadMissing: items.filter(i => !geoms.has(i.osmRel)).map(i => `${i.osmRel} ${i.en}`),
    };
    console.log(`[mandals] ${state}: ${feats.length}/${total} shipped (${(report[state] as any).coveragePct}%), ${rep.rejected.length} rejected, ${items.length - withGeom.length} not downloaded`);
  }
  writeCompact(join(GEO_OUT, "mandal-coverage.json"), report, 3);
}
main().catch(e => { console.error("[mandals] " + e.message); process.exit(1); });
