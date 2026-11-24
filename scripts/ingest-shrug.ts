/**
 * S-90: ingest SHRUG village polygons (CC BY-NC-SA 4.0, non-commercial operation only; see docs/NONCOMMERCIAL.md).
 * Offline: reads data/raw/shrug (git-ignored) and never touches the network.
 *
 *   npm run pipeline:shrug [-- --dir data/raw/shrug] [--tolerance 0.00012]
 *
 * Expects the extracted "PC11 village polygons" shapefile (shrug-pc11-village-poly-shp.zip: village_modified.shp/.dbf)
 * anywhere under the directory. See docs/data/SHRUG_DOWNLOAD.md. Writes:
 *   data/generated/geo/villages-shrug/polygons-{AP,TG}.json   one pack per state (served per mandal by the API)
 *   data/generated/geo/villages-shrug/coverage.json           join rate and unmatched report
 * Afterwards run: npm run pipeline:manifest && npm run pipeline:attribution && npm run pipeline:validate
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as shapefile from "shapefile";
import { GEO_OUT, readJsonFile, writeCompact } from "../pipeline/geo/util";
import { ROOT } from "../pipeline/io";
import { buildPack, joinFeature, mergeRow, newReport, SHRUG_VINTAGE, type CensusLoc, type LgdVillageRef, type PolyRow, type StateCode } from "../pipeline/geo/shrug";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const dir = resolve(ROOT, arg("dir") ?? "data/raw/shrug");
const tolerance = arg("tolerance") ? Number(arg("tolerance")) : undefined;

function findShp(d: string): string | null {
  if (!existsSync(d)) return null;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { const r = findShp(p); if (r) return r; }
    else if (/village.*\.shp$/i.test(n)) return p;
  }
  return null;
}
const sha = (f: string) => new Promise<string>((ok, bad) => { const h = createHash("sha256"); createReadStream(f).on("data", c => h.update(c)).on("end", () => ok(h.digest("hex"))).on("error", bad); });

const shp = findShp(dir);
if (!shp) {
  console.error(`[shrug] No village shapefile found under ${dir}.\nFollow docs/data/SHRUG_DOWNLOAD.md: download shrug-pc11-village-poly-shp.zip, extract it into data/raw/shrug/, then rerun npm run pipeline:shrug.`);
  process.exit(2);
}

const byCensus = new Map<string, LgdVillageRef>();
for (const state of ["AP", "TG"] as StateCode[]) {
  const lgd = readJsonFile(join(GEO_OUT, `lgd-${state}.json`));
  for (const v of lgd.villages as (string | number)[][]) {
    const census = String(v[4]);
    if (!census || census === "0") continue;
    if (byCensus.has(census)) console.warn(`[shrug] census code ${census} listed twice in LGD; keeping the first`);
    else byCensus.set(census, { code: String(v[0]), name: String(v[1]), mandalCode: String(v[3]), state, census });
  }
}
const censusLoc = new Map<string, CensusLoc>(), townCodes = new Set<string>();
const cu = join(ROOT, "data", "generated", "census-units.json");
if (existsSync(cu)) for (const u of readJsonFile(cu).units as string[][]) { if (u[0] === "V") censusLoc.set(String(u[4]), { district: String(u[2]), subDistrict: String(u[3]) }); else townCodes.add(String(u[4])); }

const rep = newReport();
const perState: Record<StateCode, Map<string, PolyRow>> = { AP: new Map(), TG: new Map() };
const src = await shapefile.open(shp);
const t0 = Date.now();
for (;;) {
  const r = await src.read();
  if (r.done) break;
  const row = joinFeature(r.value as never, { byCensus, censusLoc, townCodes, tolerance }, rep);
  if (row) mergeRow(perState[byCensus.get(row.censusCode)!.state], row, rep);
  if (rep.featuresRead % 100000 === 0) console.log(`[shrug] ${rep.featuresRead} features, ${rep.matched} matched`);
}
const file = shp.slice(dir.length + 1).split("\\").join("/");
const hash = existsSync(join(dir, "shrug-pc11-village-poly-shp.zip")) ? await sha(join(dir, "shrug-pc11-village-poly-shp.zip")) : null;
const asOf = "2011-03-01";
const lgdCounts: Record<string, number> = { AP: 0, TG: 0 };
for (const v of byCensus.values()) lgdCounts[v.state]++;
const lgdTotals = Object.fromEntries((['AP', 'TG'] as StateCode[]).map(s => [s, (readJsonFile(join(GEO_OUT, `lgd-${s}.json`)).villages as unknown[]).length])) as Record<StateCode, number>;
const states = {} as Record<StateCode, { lgdVillagesTotal: number; lgdVillagesWithCensusCode: number; polygons: number; joinRate: number; joinRateOfAllLgdVillages: number }>;
for (const state of ["AP", "TG"] as StateCode[]) {
  const rows = [...perState[state].values()];
  const pack = buildPack(state, rows, { asOf, file, sha256: hash });
  writeCompact(join(GEO_OUT, "villages-shrug", `polygons-${state}.json`), pack, 2);
  states[state] = { lgdVillagesTotal: lgdTotals[state], lgdVillagesWithCensusCode: lgdCounts[state], polygons: rows.length, joinRate: Math.round((rows.length / lgdCounts[state]) * 10000) / 100, joinRateOfAllLgdVillages: Math.round((rows.length / lgdTotals[state]) * 10000) / 100 };
  console.log(`[shrug] ${state}: ${rows.length} of ${lgdCounts[state]} LGD villages have a polygon (${states[state].joinRate}%)`);
}
writeCompact(join(GEO_OUT, "villages-shrug", "coverage.json"), {
  schema: 1, asOf, generator: "scripts/ingest-shrug.ts", vintage: SHRUG_VINTAGE,
  source: { name: "SHRUG v2.2 Pakora PC11 village polygons", file, zipSha256: hash },
  tolerance: tolerance ?? 0.00012, states, report: rep,
  note: "joinRate = LGD villages with a polygon / LGD villages carrying a Census 2011 code. Unmatched polygons are SHRUG features of Census state 28 whose village code is not an LGD village of AP or TG (towns are counted separately).",
}, 4);
console.log(`[shrug] done in ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(rep));
