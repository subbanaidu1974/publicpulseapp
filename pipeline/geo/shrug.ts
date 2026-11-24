/**
 * S-90: village POLYGONS from SHRUG (Development Data Lab, CC BY-NC-SA 4.0), Census 2011 boundaries.
 * Owner decision 2026-11-24: the app is operated non-commercially, so these terms are usable (see docs/NONCOMMERCIAL.md).
 *
 * Pure functions only; the file reading lives in scripts/ingest-shrug.ts. Input is the SHRUG "PC11 village polygons"
 * shapefile (v2.2 Pakora, village_modified.shp): one feature per Census 2011 town/village with
 *   pc11_s_id (2 digits), pc11_d_id (3), pc11_sd_id (5), pc11_tv_id (6), tv_name.
 * All of undivided Andhra Pradesh is state id 28 in Census 2011, so the AP/TG split comes from LGD (a village is AP or TG
 * according to the LGD file that lists its Census 2011 village code), which also covers the pre-2014 AP districts that are TG now.
 */
import { polyArea, simplifyGeom, toPolys, fromPolys, type Geom, type Poly } from "./geometry";

export const SHRUG_STATE_ID = "28";
export const SHRUG_LICENCE = "shrug-cc-by-nc-sa";
export const SHRUG_ATTRIBUTION_EN = "Village boundaries: SHRUG, Development Data Lab, CC BY-NC-SA 4.0, 2011 Census based; for non-commercial use";
export const SHRUG_ATTRIBUTION_TE = "గ్రామ సరిహద్దులు: SHRUG, డెవలప్‌మెంట్ డేటా ల్యాబ్, CC BY-NC-SA 4.0, 2011 జనగణన ఆధారితం; వాణిజ్యేతర ఉపయోగం కోసం";
export const SHRUG_VINTAGE = "Census 2011 boundaries (SHRUG v2.2). Villages created, merged or renamed since 2011 may differ from current LGD villages; the polygon is matched by Census 2011 village code only.";

export type StateCode = "AP" | "TG";
export interface LgdVillageRef { code: string; name: string; mandalCode: string; state: StateCode; census: string }
/** Census 2011 district / sub-district of a village code (from data/generated/census-units.json), used to cross-check the join. */
export interface CensusLoc { district: string; subDistrict: string }

export interface ShrugKey { state: string; district: string; subDistrict: string; tv: string }
const pad = (v: unknown, n: number) => String(v ?? "").trim().padStart(n, "0");
/** Reads the Census ids from shapefile (pc11_s_id) or GeoPackage (pc11_state_id) style properties. */
export function shrugKey(p: Record<string, unknown>): ShrugKey | null {
  const s = p.pc11_s_id ?? p.pc11_state_id, d = p.pc11_d_id ?? p.pc11_district_id, sd = p.pc11_sd_id ?? p.pc11_subdistrict_id, tv = p.pc11_tv_id ?? p.pc11_village_id ?? p.pc11_town_village_id;
  if (s == null || tv == null) return null;
  return { state: pad(s, 2), district: pad(d, 3), subDistrict: pad(sd, 5), tv: pad(tv, 6) };
}

export interface PolyRow { lgdCode: string; censusCode: string; mandalCode: string; name: string; shrugName: string | null; geometry: Geom }
export interface JoinReport {
  featuresRead: number; featuresInAndhra: number;
  matched: number; duplicatePolygons: number;
  unmatchedPolygons: number; unmatchedTowns: number; districtMismatch: number; geometryDropped: number; geometryInvalid: number;
  unmatchedSample: { tv: string; name: string | null }[];
  mismatchSample: { tv: string; name: string | null; shrugDistrict: string; censusDistrict: string }[];
}
export const newReport = (): JoinReport => ({ featuresRead: 0, featuresInAndhra: 0, matched: 0, duplicatePolygons: 0, unmatchedPolygons: 0, unmatchedTowns: 0, districtMismatch: 0, geometryDropped: 0, geometryInvalid: 0, unmatchedSample: [], mismatchSample: [] });

export interface JoinContext {
  /** Census 2011 village code -> LGD village (codes are unique across AP+TG because Census numbered undivided AP together) */
  byCensus: Map<string, LgdVillageRef>;
  /** Census 2011 village code -> district/sub-district, when census-units has the village */
  censusLoc?: Map<string, CensusLoc>;
  /** Census 2011 town codes (to count towns separately from missing villages) */
  townCodes?: Set<string>;
  /** Douglas-Peucker ceiling in degrees (default 0.00012, about 13 m) */
  tolerance?: number;
}

/** Tolerance scales with polygon size so a tiny hamlet keeps a recognisable shape while a big village loses vertices. */
export function adaptiveTolerance(g: Geom, ceiling = 0.00012): number {
  const area = toPolys(g).reduce((s, p) => s + Math.max(polyArea(p), 0), 0);
  return Math.min(ceiling, Math.max(0.00002, Math.sqrt(area) * 0.03));
}
export function simplifyVillage(g: Geom, ceiling = 0.00012): Geom | null {
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) return null;
  const tol = adaptiveTolerance(g, ceiling);
  return simplifyGeom(g, tol, 5, tol * tol) ?? simplifyGeom(g, tol / 4, 5, 1e-12);
}

/**
 * Join one SHRUG feature. Returns the row to keep or null. Counts into `rep`. Features of the same village are merged by the caller via mergeRows.
 */
export function joinFeature(f: { properties: Record<string, unknown>; geometry: Geom }, ctx: JoinContext, rep: JoinReport): PolyRow | null {
  rep.featuresRead++;
  const k = shrugKey(f.properties);
  if (!k || k.state !== SHRUG_STATE_ID) return null;
  rep.featuresInAndhra++;
  const name = typeof f.properties.tv_name === "string" ? f.properties.tv_name : null;
  const v = ctx.byCensus.get(k.tv);
  if (!v) {
    if (ctx.townCodes?.has(k.tv)) rep.unmatchedTowns++;
    else { rep.unmatchedPolygons++; if (rep.unmatchedSample.length < 25) rep.unmatchedSample.push({ tv: k.tv, name }); }
    return null;
  }
  const loc = ctx.censusLoc?.get(k.tv);
  if (loc && loc.district !== k.district) {
    rep.districtMismatch++;
    if (rep.mismatchSample.length < 25) rep.mismatchSample.push({ tv: k.tv, name, shrugDistrict: k.district, censusDistrict: loc.district });
    return null;
  }
  if (!f.geometry) { rep.geometryInvalid++; return null; }
  const geometry = simplifyVillage(f.geometry, ctx.tolerance);
  if (!geometry) { rep.geometryDropped++; return null; }
  rep.matched++;
  return { lgdCode: v.code, censusCode: k.tv, mandalCode: v.mandalCode, name: v.name, shrugName: name, geometry };
}

/** Same village in several features (SHRUG keeps split villages separately): merge to one MultiPolygon. */
export function mergeRow(map: Map<string, PolyRow>, row: PolyRow, rep: JoinReport): void {
  const prev = map.get(row.lgdCode);
  if (!prev) { map.set(row.lgdCode, row); return; }
  rep.duplicatePolygons++;
  const polys: Poly[] = [...toPolys(prev.geometry), ...toPolys(row.geometry)];
  prev.geometry = fromPolys(polys);
}

export const PACK_COLUMNS = ["lgdCode", "censusCode", "mandalCode", "geometry"] as const;
export interface PackFile {
  schema: 1; state: StateCode; layer: "shrug"; asOf: string; vintage: string; licence: string;
  attribution: string; attributionTe: string; shareAlike: string; nonCommercial: true; precision: string;
  source: { name: string; version: string; file: string; sha256: string | null; url: string };
  columns: readonly string[];
  villages: [string, string, string, Geom][];
}
export function buildPack(state: StateCode, rows: PolyRow[], meta: { asOf: string; file: string; sha256: string | null }): PackFile {
  const sorted = [...rows].sort((a, b) => a.mandalCode.localeCompare(b.mandalCode, "en", { numeric: true }) || a.lgdCode.localeCompare(b.lgdCode, "en", { numeric: true }));
  return {
    schema: 1, state, layer: "shrug", asOf: meta.asOf, vintage: SHRUG_VINTAGE, licence: SHRUG_LICENCE,
    attribution: SHRUG_ATTRIBUTION_EN, attributionTe: SHRUG_ATTRIBUTION_TE, nonCommercial: true,
    shareAlike: "Derived boundary files must be offered under CC BY-NC-SA 4.0 (see docs/NONCOMMERCIAL.md).",
    precision: "Simplified for web (Douglas-Peucker, 2e-5 to 1.2e-4 degrees, 5 decimals); not survey grade; 2011 Census extent.",
    source: { name: "SHRUG v2.2 Pakora, PC11 village polygons (Development Data Lab)", version: "2.2", file: meta.file, sha256: meta.sha256, url: "https://www.devdatalab.org/shrug_download/" },
    columns: PACK_COLUMNS,
    villages: sorted.map(r => [r.lgdCode, r.censusCode, r.mandalCode, r.geometry]),
  };
}
