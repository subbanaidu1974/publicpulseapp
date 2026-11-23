/**
 * S-89: mandal (sub-district) polygons from OpenStreetMap (ODbL), joined to LGD mandals by English name.
 * Pure functions only; the network lives in scripts/fetch-mandals.ts. Polygons are never invented: a unit
 * ships only when the join confidence reaches MATCH_THRESHOLD.
 *
 * Confidence ladder (documented in docs/ATTRIBUTION.md and the coverage report):
 *   1.00  exact normalised name, unique in the state, and the polygon centroid lies in the LGD district (or the
 *         Wikidata parent label names the district)
 *   0.90  exact normalised name, several LGD mandals share it, the district evidence picks exactly one
 *   0.85  exact normalised name, unique in the state, no district evidence either way
 *   0.70  edit-distance match (transliteration noise), unique inside the district: NOT shipped
 *   0.40  district evidence contradicts the name match: NOT shipped
 * An LGD mandal claimed by two different OSM relations is ambiguous and neither ships.
 */
import type { Geom, Pos } from "./geometry";
import { toPolys } from "./geometry";
import { nameClose, normName } from "./util";

export const MATCH_THRESHOLD = 0.8;

export interface OsmMandal { qid: string; en: string; district: string; osmRel: number }
export interface LgdMandal { code: string; name: string; districtCode: string }
export interface LgdDistrict { code: string; name: string }
export interface DistrictPoly { code: string; geometry: Geom }

export interface MandalMatch {
  osmRel: number; qid: string; osmName: string; lgdCode: string; lgdName: string; districtCode: string; confidence: number; basis: string;
}
export interface MatchReport {
  matches: MandalMatch[];
  /** below threshold or contested: not shipped */
  rejected: { osmRel: number; qid: string; osmName: string; reason: string; confidence: number; lgdCandidates: string[] }[];
  /** LGD mandals with no accepted polygon */
  lgdUnmatched: { code: string; name: string }[];
}

export const stripMandalWord = (s: string) => s.replace(/\s+(revenue\s+)?mandal$/i, "").trim();
const stripDistrictWord = (s: string) => s.replace(/\s+district$/i, "").trim();

export function parseOsmMandals(json: unknown): OsmMandal[] {
  const out = new Map<number, OsmMandal>();
  const b = (json as { results?: { bindings?: Record<string, { value: string }>[] } })?.results?.bindings ?? [];
  for (const r of b) {
    const rel = Number(r.o?.value);
    if (!Number.isInteger(rel) || rel <= 0) continue;
    const qid = String(r.item?.value ?? "").split("/").pop() ?? "";
    if (!qid || !r.en?.value) continue;
    if (!out.has(rel)) out.set(rel, { qid, en: stripMandalWord(r.en.value), district: stripDistrictWord(r.parentLabel?.value ?? ""), osmRel: rel });
  }
  return [...out.values()].sort((a, b2) => a.osmRel - b2.osmRel);
}

/* ---------- geometry helpers ---------- */
function inRing(p: Pos, ring: Pos[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
export function pointInGeom(p: Pos, g: Geom): boolean {
  return toPolys(g).some(poly => inRing(p, poly[0]) && !poly.slice(1).some(h => inRing(p, h)));
}
/** Area-weighted centroid of the largest polygon ring (good enough as an interior-ish point for a district test). */
export function interiorPoint(g: Geom): Pos {
  let best: Pos[] = [], bestA = -1;
  for (const poly of toPolys(g)) {
    const r = poly[0]; let a = 0;
    for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = r; }
  }
  let cx = 0, cy = 0, a2 = 0;
  for (let i = 0; i < best.length - 1; i++) {
    const f = best[i][0] * best[i + 1][1] - best[i + 1][0] * best[i][1];
    a2 += f; cx += (best[i][0] + best[i + 1][0]) * f; cy += (best[i][1] + best[i + 1][1]) * f;
  }
  const c: Pos = a2 ? [cx / (3 * a2), cy / (3 * a2)] : best[0];
  if (pointInGeom(c, { type: "Polygon", coordinates: [best] })) return c;
  // concave: fall back to the mean of the ring vertices, then to the first vertex
  const m: Pos = [best.reduce((s, p) => s + p[0], 0) / best.length, best.reduce((s, p) => s + p[1], 0) / best.length];
  return pointInGeom(m, { type: "Polygon", coordinates: [best] }) ? m : best[0];
}

/* ---------- the join ---------- */
export function matchMandals(
  osm: (OsmMandal & { geometry: Geom })[], lgd: LgdMandal[], districts: LgdDistrict[], districtPolys: DistrictPoly[],
): MatchReport {
  const dName = new Map(districts.map(d => [d.code, d.name]));
  const byNorm = new Map<string, LgdMandal[]>();
  for (const m of lgd) (byNorm.get(normName(m.name)) ?? byNorm.set(normName(m.name), []).get(normName(m.name))!).push(m);

  const districtOfPoint = (p: Pos): string | null => districtPolys.find(d => pointInGeom(p, d.geometry))?.code ?? null;
  type Cand = MandalMatch & { _o: number };
  const cands: Cand[] = [];
  const rejected: MatchReport["rejected"] = [];

  for (const o of osm) {
    const spatial = districtOfPoint(interiorPoint(o.geometry));
    const parentOk = (m: LgdMandal) => !!o.district && (nameClose(o.district, dName.get(m.districtCode) ?? "") || normName(dName.get(m.districtCode) ?? "").includes(normName(o.district)) || normName(o.district).includes(normName(dName.get(m.districtCode) ?? "~")));
    // district evidence for a candidate: true = supports, false = contradicts, null = none available
    const evidence = (m: LgdMandal): boolean | null => {
      const e: boolean[] = [];
      if (spatial) e.push(spatial === m.districtCode);
      if (o.district) e.push(parentOk(m));
      if (!e.length) return null;
      return e.some(Boolean);
    };
    const exact = byNorm.get(normName(o.en)) ?? [];
    let chosen: LgdMandal | null = null, conf: number, basis = "", reason = "";
    let listed = exact;
    if (exact.length === 1) {
      const ev = evidence(exact[0]);
      if (ev === true) { chosen = exact[0]; conf = 1; basis = "exact name, district confirmed"; }
      else if (ev === null) { chosen = exact[0]; conf = 0.85; basis = "exact name, unique in state, no district evidence"; }
      else { conf = 0.4; reason = "name matches but district evidence contradicts"; }
    } else if (exact.length > 1) {
      const sup = exact.filter(m => evidence(m) === true);
      if (sup.length === 1) { chosen = sup[0]; conf = 0.9; basis = "exact name shared by several mandals; district evidence selects one"; }
      else { conf = 0.3; reason = `name shared by ${exact.length} LGD mandals and district evidence does not pick one`; }
    } else {
      const near = lgd.filter(m => nameClose(m.name, o.en) && evidence(m) === true);
      listed = near;
      if (near.length === 1) { chosen = near[0]; conf = 0.7; basis = "edit-distance name match inside the district"; reason = "fuzzy name match below threshold"; }
      else if (near.length > 1) { conf = 0.3; reason = "several near-name candidates"; }
      else { conf = 0; reason = "no LGD mandal with this name"; }
    }
    if (chosen && conf >= MATCH_THRESHOLD) cands.push({ osmRel: o.osmRel, qid: o.qid, osmName: o.en, lgdCode: chosen.code, lgdName: chosen.name, districtCode: chosen.districtCode, confidence: conf, basis, _o: o.osmRel });
    else rejected.push({ osmRel: o.osmRel, qid: o.qid, osmName: o.en, reason: reason || "below threshold", confidence: conf, lgdCandidates: (chosen ? [chosen] : listed).slice(0, 4).map(m => `${m.code} ${m.name}`) });
  }

  // one polygon per LGD mandal: contested codes ship nothing
  const byLgd = new Map<string, Cand[]>();
  for (const c of cands) (byLgd.get(c.lgdCode) ?? byLgd.set(c.lgdCode, []).get(c.lgdCode)!).push(c);
  const matches: MandalMatch[] = [];
  for (const [code, list] of byLgd) {
    if (list.length === 1) { const { _o, ...m } = list[0]; void _o; matches.push(m); }
    else for (const c of list) rejected.push({ osmRel: c.osmRel, qid: c.qid, osmName: c.osmName, reason: `LGD mandal ${code} claimed by ${list.length} OSM relations`, confidence: c.confidence, lgdCandidates: [`${code} ${c.lgdName}`] });
  }
  matches.sort((a, b) => Number(a.lgdCode) - Number(b.lgdCode));
  const got = new Set(matches.map(m => m.lgdCode));
  return { matches, rejected: rejected.sort((a, b) => a.osmRel - b.osmRel), lgdUnmatched: lgd.filter(m => !got.has(m.code)).map(m => ({ code: m.code, name: m.name })) };
}
