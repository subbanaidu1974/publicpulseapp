/**
 * S-193: Telugu village names for the map background. Offline, no network: joins the committed village location points (Wikidata CC0 layer
 * first, OpenStreetMap ODbL layer for the rest) to the Telugu names the LGD village directory already carries. A village without a Telugu
 * name or without a location point is left out and counted. Names are shown exactly as the source holds them (never cleaned or guessed).
 * Where LGD has no Telugu name, a Telugu label from Wikidata (CC0) keyed by the Census 2011 code is used when
 * data/generated/geo/village-names-te-<ST>.json exists (S-196, npm run pipeline:village-names-te; Andhra Pradesh only).
 * Output data/generated/geo/village-labels-AP.json and village-labels-TG.json: { villages: [[te, lon, lat], ...] }.
 * Usage: npx tsx scripts/build-village-labels.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GEO_OUT, readJsonFile, writeCompact } from "../pipeline/geo/util";

const TELUGU = /[ఀ-౿]/;
const round = (n: number) => Math.round(n * 1e4) / 1e4;

for (const st of ["AP", "TG"]) {
  const lgd = readJsonFile(join(GEO_OUT, `lgd-${st}.json`));
  const cols: string[] = lgd.cols.villages;
  const iLgd = cols.indexOf("lgd"), iTe = cols.indexOf("nameTe"), iCensus = cols.indexOf("census2011");
  const te = new Map<string, string>();
  for (const r of lgd.villages as unknown[][]) { const n = String(r[iTe] ?? "").trim(); if (n && TELUGU.test(n)) te.set(String(r[iLgd]), n); }
  const lgdNames = te.size;
  // Wikidata fallback: only for villages LGD has no Telugu name for; LGD's own name always wins
  let fromWd = 0;
  const wdFile = join(GEO_OUT, `village-names-te-${st}.json`);
  if (existsSync(wdFile)) {
    const wd = new Map<string, string>((readJsonFile(wdFile).names as [string, string][]).map(([c, t]) => [String(c), t]));
    for (const r of lgd.villages as unknown[][]) {
      const code = String(r[iLgd]);
      if (te.has(code)) continue;
      const name = wd.get(String(r[iCensus] ?? ""));
      if (name) { te.set(code, name); fromWd++; }
    }
  }
  const out: [string, number, number][] = [];
  const used = new Set<string>(), seen = new Set<string>();
  let dup = 0;
  let noName = 0, fromWikidata = 0, fromOsm = 0;
  for (const layer of ["wikidata", "osm"] as const) {
    const pts = readJsonFile(join(GEO_OUT, `village-points-${layer}-${st}.json`)).points as [string, string, number, number][];
    for (const [code, , lon, lat] of pts) {
      if (used.has(code)) continue;
      const name = te.get(String(code));
      if (!name) { noName++; continue; }
      const key = `${name}|${round(lon)}|${round(lat)}`;
      if (seen.has(key)) { dup++; continue; } // two directory villages mapped to one place point: one label
      seen.add(key); used.add(code); out.push([name, round(lon), round(lat)]);
      if (layer === "wikidata") fromWikidata++; else fromOsm++;
    }
  }
  out.sort((a, b) => b[2] - a[2] || a[1] - b[1]); // north to south, so the file is stable
  writeCompact(join(GEO_OUT, `village-labels-${st}.json`), {
    schema: 1, state: st, asOf: lgd.asOf ?? null, licence: "LGD public directory names; locations Wikidata CC0 and OpenStreetMap contributors ODbL 1.0",
    note: `Villages that have BOTH a Telugu name (from the LGD directory, or from Wikidata where the directory has none) AND a location point (${fromWikidata} from the Wikidata layer, ${fromOsm} from the OpenStreetMap layer). ${lgdNames} of ${lgd.villages.length} LGD villages have a Telugu name in the directory${fromWd ? ` and ${fromWd} more from Wikidata (CC0, matched by Census 2011 code)` : ""}; ${noName} located points had none and ${dup} shared a place point with a same-named village, and were left out. Names are as the source holds them. Locations are approximate place points, not boundaries.`,
    columns: ["te", "lon", "lat"], villages: out,
  }, 3);
  console.log(`${st}: ${out.length} labelled villages (LGD Telugu names ${lgdNames}/${lgd.villages.length}, +${fromWd} from Wikidata; ${noName} located points without a Telugu name)`);
}
