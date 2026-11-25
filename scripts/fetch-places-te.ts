/**
 * S-192: Telugu town names for the map background. The self-hosted OpenStreetMap tiles carry place names in ~35 languages but not Telugu,
 * so towns are labelled from Wikidata (CC0): every item inside AP or TG with a population of at least MIN_POP, a coordinate and a Telugu
 * label. Names are never invented: a town without a Telugu label is left out and counted. 2 requests (one per state), generic User-Agent.
 * Output data/generated/geo/places-AP.json and places-TG.json: { places: [[en, te, lon, lat, population], ...] } sorted by population.
 * Usage: npx tsx scripts/fetch-places-te.ts
 */
import { join } from "node:path";
import type { StateCode } from "../src/lib/states";
import { stateQid, WIKIDATA_ENDPOINT } from "../pipeline/geo/names";
import { GEO_OUT, writeCompact } from "../pipeline/geo/util";

const UA = "TeluguPulseGeoPipeline/1.0 (open civic data research; low-volume)";
const MIN_POP = 30000;
/** Wikidata also lists districts, mandals and constituencies with a population; those are not towns, and bracketed forms are wards. */
export const NOT_A_TOWN = /district|mandal|division|constituency|taluk|revenue|\(|జిల్లా|మండలం|నియోజకవర్గం|డివిజన్/i;
/** The map background covers this box; a Wikidata item with a coordinate outside it is a data error (e.g. a Bihar town filed under Telangana). */
export const AREA = { west: 76.5, east: 85.0, south: 12.5, north: 19.95 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const query = (qid: string) => `SELECT ?item ?en ?te ?pop ?coord WHERE {
  ?item wdt:P131+ wd:${qid}; wdt:P1082 ?pop; wdt:P625 ?coord.
  FILTER(?pop >= ${MIN_POP})
  OPTIONAL { ?item rdfs:label ?en FILTER(lang(?en)="en") }
  OPTIONAL { ?item rdfs:label ?te FILTER(lang(?te)="te") }
}`;

async function sparql(q: string): Promise<any[]> {
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(90000) });
    if (res.ok) return (await res.json()).results.bindings;
    if (attempt === 0) await sleep(10000); else throw new Error(`Wikidata HTTP ${res.status}`);
  }
  return [];
}

async function main() {
  let first = true;
  for (const st of ["AP", "TG"] as StateCode[]) {
    if (!first) await sleep(6000);
    first = false;
    const rows = await sparql(query(stateQid(st)));
    const best = new Map<string, { en: string; te: string; lon: number; lat: number; pop: number }>();
    let noTe = 0, noCoord = 0, notTown = 0, outside = 0;
    for (const r of rows) {
      const qid = String(r.item.value).split("/").pop()!;
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.coord?.value ?? "");
      if (!m) { noCoord++; continue; }
      if (!r.te?.value || !r.en?.value) { noTe++; continue; }
      if (Number(m[1]) < AREA.west || Number(m[1]) > AREA.east || Number(m[2]) < AREA.south || Number(m[2]) > AREA.north) { outside++; continue; }
      if (NOT_A_TOWN.test(r.en.value) || NOT_A_TOWN.test(r.te.value)) { notTown++; continue; }
      const pop = Number(r.pop.value);
      const cur = best.get(qid);
      if (!cur || pop > cur.pop) best.set(qid, { en: r.en.value, te: r.te.value, lon: Math.round(Number(m[1]) * 1e4) / 1e4, lat: Math.round(Number(m[2]) * 1e4) / 1e4, pop });
    }
    // one label per name: keep the biggest when Wikidata lists a town and its municipality separately
    const byName = new Map<string, { en: string; te: string; lon: number; lat: number; pop: number }>();
    for (const p of best.values()) { const k = p.te; const c = byName.get(k); if (!c || p.pop > c.pop) byName.set(k, p); }
    const places = [...byName.values()].sort((a, b) => b.pop - a.pop).map((p) => [p.en, p.te, p.lon, p.lat, p.pop]);
    writeCompact(join(GEO_OUT, `places-${st}.json`), {
      schema: 1, state: st, asOf: new Date().toISOString().slice(0, 10), source: `${WIKIDATA_ENDPOINT} (CC0), 1 request`, licence: "CC0-1.0",
      note: `Towns with population >= ${MIN_POP} that have a Telugu label on Wikidata. Never guessed: ${noTe} listed items had no Telugu or English label, ${noCoord} had no coordinate ${outside} were outside AP and TG (wrong coordinates on Wikidata) and ${notTown} were districts, mandals, constituencies or wards, and were left out.`,
      columns: ["en", "te", "lon", "lat", "population"], places,
    }, 3);
    console.log(`${st}: ${places.length} towns with Telugu names; ${noTe} without a Telugu label, ${noCoord} without coordinates, ${notTown} not towns, ${outside} outside the area`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
