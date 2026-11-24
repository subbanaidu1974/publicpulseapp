/**
 * S-90: village / hamlet POINTS (centroid-like locations) for AP and TG from licence-compatible sources, joined to LGD villages.
 * Pure functions only; the network lives in scripts/fetch-village-points.ts. SHRUG (CC BY-NC-SA) is NOT used.
 *
 * Two layers, kept separate so the licence scope is clear (see docs/decisions/S-90-village-boundaries.md):
 *   wikidata  Wikidata item with "Indian census area code (2011)" (P5578) + coordinates (P625). Wikidata is CC0.
 *             Joined to LGD by the Census 2011 village code (LGD village rows carry it). Confidence 1.0 on a unique code match.
 *   osm       OpenStreetMap place=village|hamlet nodes (ODbL). Used ONLY for LGD villages the Wikidata layer does not cover.
 *             Joined by normalised name inside the LGD mandal (mandal polygon where available, else the district).
 *             0.90 unique name in the mandal, 0.80 unique name in the district only. Anything weaker is not shipped.
 * A point is never invented: unmatched, ambiguous and out-of-district candidates are counted in the coverage report.
 */
import type { Geom, Pos } from "./geometry";
import { pointInGeom } from "./mandals";
import { normName } from "./util";

export const POINT_THRESHOLD = 0.8;

export interface LgdVillage { code: string; name: string; mandalCode: string; census: string }
export interface LgdMandalRef { code: string; districtCode: string }
export interface Poly { code: string; geometry: Geom }
export interface WdVillage { qid: string; census: string; lon: number; lat: number }
export interface OsmNode { id: number; name: string; nameTe?: string; place: string; lon: number; lat: number; wikidata?: string }
export interface PointRow { lgdCode: string; censusCode: string; lon: number; lat: number; confidence: number; basis: string; ref: string }

const inIndia = (lon: number, lat: number) => lon >= 76 && lon <= 85 && lat >= 12 && lat <= 20;
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
export function distKm(a: Pos, b: Pos): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Parse "Point(lon lat)" from WDQS. */
export function parseWktPoint(s: string): Pos | null {
  const m = /^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function parseWikidataVillages(json: unknown): WdVillage[] {
  const b = (json as { results?: { bindings?: Record<string, { value: string }>[] } })?.results?.bindings ?? [];
  const out: WdVillage[] = [];
  for (const r of b) {
    const p = parseWktPoint(r.co?.value ?? "");
    const census = String(r.cen?.value ?? "").trim();
    const qid = String(r.item?.value ?? "").split("/").pop() ?? "";
    if (!p || !/^\d{1,8}$/.test(census) || !qid) continue;
    out.push({ qid, census, lon: p[0], lat: p[1] });
  }
  return out;
}

export function parseOverpassNodes(json: unknown): OsmNode[] {
  const els = (json as { elements?: { type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string> }[] })?.elements ?? [];
  const out: OsmNode[] = [];
  for (const e of els) {
    if (e.type !== "node" || typeof e.lat !== "number" || typeof e.lon !== "number") continue;
    const t = e.tags ?? {};
    const name = (t["name:en"] || t.name || "").trim();
    if (!name || !/^(village|hamlet)$/.test(t.place ?? "")) continue;
    out.push({ id: e.id, name, ...(t["name:te"] ? { nameTe: t["name:te"] } : {}), place: t.place, lon: e.lon, lat: e.lat, ...(t.wikidata ? { wikidata: t.wikidata } : {}) });
  }
  return out;
}

export interface WdReport {
  rows: PointRow[];
  rejected: { reason: string; census: string; qids: string[] }[];
  counts: { wikidataRows: number; matched: number; notInLgd: number; ambiguous: number; outsideDistrict: number; outsideBounds: number };
}

/** Wikidata layer: join by Census 2011 village code. */
export function matchWikidata(wd: WdVillage[], lgd: LgdVillage[], mandals: LgdMandalRef[], districtPolys: Poly[]): WdReport {
  const byCensus = new Map<string, LgdVillage[]>();
  for (const v of lgd) if (v.census && v.census !== "0") (byCensus.get(v.census) ?? byCensus.set(v.census, []).get(v.census)!).push(v);
  const distOf = new Map(mandals.map(m => [m.code, m.districtCode]));
  const group = new Map<string, WdVillage[]>();
  for (const w of wd) (group.get(w.census) ?? group.set(w.census, []).get(w.census)!).push(w);
  const rows: PointRow[] = [], rejected: WdReport["rejected"] = [];
  const counts = { wikidataRows: wd.length, matched: 0, notInLgd: 0, ambiguous: 0, outsideDistrict: 0, outsideBounds: 0 };
  for (const [census, list] of [...group].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const targets = byCensus.get(census) ?? [];
    if (targets.length !== 1) {
      counts.notInLgd++; rejected.push({ reason: targets.length ? "census code shared by several LGD villages" : "census code is not an LGD village of this state", census, qids: list.map(l => l.qid) });
      continue;
    }
    const first = list[0];
    // several items or several coordinates for one code: ship only if they agree within 2 km
    if (list.some(l => distKm([first.lon, first.lat], [l.lon, l.lat]) > 2)) {
      counts.ambiguous++; rejected.push({ reason: "several Wikidata coordinates for this code disagree by more than 2 km", census, qids: [...new Set(list.map(l => l.qid))] });
      continue;
    }
    if (!inIndia(first.lon, first.lat)) { counts.outsideBounds++; rejected.push({ reason: "coordinates outside the AP/TG bounding region", census, qids: [first.qid] }); continue; }
    const v = targets[0], dCode = distOf.get(v.mandalCode);
    const dp = districtPolys.find(d => d.code === dCode);
    if (dp && !pointInGeom([first.lon, first.lat], dp.geometry)) {
      counts.outsideDistrict++; rejected.push({ reason: "point lies outside the LGD district of this village (district polygons are approximate)", census, qids: [first.qid] });
      continue;
    }
    counts.matched++;
    rows.push({ lgdCode: v.code, censusCode: census, lon: round5(first.lon), lat: round5(first.lat), confidence: 1, basis: "Census 2011 village code", ref: first.qid });
  }
  rows.sort((a, b) => Number(a.lgdCode) - Number(b.lgdCode));
  return { rows, rejected, counts };
}

export interface OsmReport {
  rows: PointRow[];
  counts: { nodes: number; matched: number; skippedAlreadyHavePoint: number; noName: number; unmatched: number; ambiguous: number; outsideState: number };
  /** median / p90 distance (km) between OSM and Wikidata points where both exist for the same LGD village */
  agreement: { pairs: number; medianKm: number | null; p90Km: number | null };
}

/** OSM layer: fills only villages with no Wikidata point. Also measures agreement with Wikidata where both exist. */
export function matchOsm(nodes: OsmNode[], lgd: LgdVillage[], mandals: LgdMandalRef[], mandalPolys: Poly[], districtPolys: Poly[], have: Map<string, Pos>): OsmReport {
  const distOf = new Map(mandals.map(m => [m.code, m.districtCode]));
  const byMandalName = new Map<string, LgdVillage[]>(), byDistName = new Map<string, LgdVillage[]>();
  const push = (m: Map<string, LgdVillage[]>, k: string, v: LgdVillage) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const v of lgd) { const n = normName(v.name); if (!n) continue; push(byMandalName, `${v.mandalCode}|${n}`, v); push(byDistName, `${distOf.get(v.mandalCode)}|${n}`, v); }
  const counts = { nodes: nodes.length, matched: 0, skippedAlreadyHavePoint: 0, noName: 0, unmatched: 0, ambiguous: 0, outsideState: 0 };
  const claims = new Map<string, { node: OsmNode; conf: number; basis: string }[]>();
  const dists: number[] = [];
  for (const nd of nodes) {
    const n = normName(nd.name);
    if (!n) { counts.noName++; continue; }
    const p: Pos = [nd.lon, nd.lat];
    const dist = districtPolys.find(d => pointInGeom(p, d.geometry));
    if (!dist) { counts.outsideState++; continue; }
    const mand = mandalPolys.find(m => distOf.get(m.code) === dist.code && pointInGeom(p, m.geometry));
    let cand: LgdVillage[] = [], conf = 0, basis = "";
    if (mand) { cand = byMandalName.get(`${mand.code}|${n}`) ?? []; conf = 0.9; basis = "unique name inside the mandal polygon"; }
    if (cand.length === 0) { cand = byDistName.get(`${dist.code}|${n}`) ?? []; conf = 0.8; basis = mand ? "name not in the polygon's mandal; unique in the district" : "unique name in the district (no mandal polygon for this point)"; }
    if (cand.length === 0) { counts.unmatched++; continue; }
    if (cand.length > 1) { counts.ambiguous++; continue; }
    const code = cand[0].code;
    const wd = have.get(code);
    if (wd) { dists.push(distKm(wd, p)); counts.skippedAlreadyHavePoint++; continue; }
    (claims.get(code) ?? claims.set(code, []).get(code)!).push({ node: nd, conf, basis });
  }
  const byCode = new Map(lgd.map(v => [v.code, v]));
  const rows: PointRow[] = [];
  for (const [code, list] of claims) {
    const a = list[0].node;
    // several OSM nodes with the same name for one village: accept only when they cluster within 2 km
    if (list.some(c => distKm([a.lon, a.lat], [c.node.lon, c.node.lat]) > 2)) { counts.ambiguous++; continue; }
    if (list[0].conf < POINT_THRESHOLD) continue;
    const v = byCode.get(code)!;
    counts.matched++;
    rows.push({ lgdCode: code, censusCode: v.census, lon: round5(a.lon), lat: round5(a.lat), confidence: list[0].conf, basis: list[0].basis, ref: `node/${a.id}` });
  }
  rows.sort((a, b) => Number(a.lgdCode) - Number(b.lgdCode));
  dists.sort((x, y) => x - y);
  const q = (f: number) => dists.length ? Math.round(dists[Math.min(dists.length - 1, Math.floor(f * dists.length))] * 100) / 100 : null;
  return { rows, counts, agreement: { pairs: dists.length, medianKm: q(0.5), p90Km: q(0.9) } };
}

/** Compact file body: rows as [lgdCode, censusCode, lon, lat, confidence, ref]. */
export const POINT_COLUMNS = ["lgdCode", "censusCode", "lon", "lat", "confidence", "ref"] as const;
export const toPointArrays = (rows: PointRow[]) => rows.map(r => [r.lgdCode, r.censusCode, r.lon, r.lat, r.confidence, r.ref]);
