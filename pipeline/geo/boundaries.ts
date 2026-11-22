/** S-78/S-79/S-88: AC, PC and district polygon builders (DataMeet sources, LGD-derived district assignment). */
import polygonClipping from "polygon-clipping";
import * as shapefile from "shapefile";
import type { StateCode } from "../../src/lib/states";
import type { AcMeta } from "./constituency";
import { fromPolys, geomErrors, polyArea, simplifyGeom, toPolys, type Geom, type Poly } from "./geometry";
import { AP_AC_OFFSET } from "./lgd";
import { nameClose, titleCase } from "./util";

export interface RawAc { acNo: number; name: string; dtCode: number; distName: string; pcNo: number; geometry: Geom }
export const AC_SIMPLIFY_TOL = 0.0006; // ~65 m
export const PC_SIMPLIFY_TOL = 0.0008;
export const DISTRICT_SIMPLIFY_TOL = 0.0012;

/** Read AP+TG features of India_AC.shp. DataMeet keeps undivided Andhra Pradesh (ST_CODE 28): AC_NO 1-119 = TG, 120-294 = AP. */
export async function readAcShapefile(shp: string, dbf: string): Promise<{ rows: RawAc[]; merged: number[]; dropped: string[] }> {
  const src = await shapefile.open(shp, dbf);
  const byNo = new Map<number, RawAc>();
  const merged: number[] = [], dropped: string[] = [];
  for (let r = await src.read(); !r.done; r = await src.read()) {
    const p = r.value.properties as Record<string, any>;
    if (Number(p.ST_CODE) !== 28) continue;
    const g = r.value.geometry as Geom;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    const row: RawAc = { acNo: Number(p.AC_NO), name: String(p.AC_NAME ?? "").trim(), dtCode: Number(p.DT_CODE), distName: String(p.DIST_NAME ?? "").trim(), pcNo: Number(p.PC_NO), geometry: g };
    if (!(row.acNo >= 1 && row.acNo <= 294)) { dropped.push(`AC_NO ${row.acNo} (${row.distName}, no name; unattributed area ${Number(p.Shape_Area).toFixed(5)} deg2)`); continue; }
    const prev = byNo.get(row.acNo);
    if (prev) { // the same AC appearing twice = multi-part constituency: merge parts
      merged.push(row.acNo);
      byNo.set(row.acNo, { ...prev, geometry: fromPolys([...toPolys(prev.geometry), ...toPolys(g)]) });
    } else byNo.set(row.acNo, row);
  }
  return { rows: [...byNo.values()].sort((a, b) => a.acNo - b.acNo), merged, dropped };
}

export const stateOfUndivided = (n: number): StateCode => (n <= AP_AC_OFFSET ? "TG" : "AP");
export const acNoOfUndivided = (n: number) => (n <= AP_AC_OFFSET ? n : n - AP_AC_OFFSET);

export interface AcFeatureOpts {
  /** state-specific acNo -> current (LGD) district */
  district?: (state: StateCode, acNo: number) => { lgd: string; name: string; share: number } | undefined;
  lgdAc?: (state: StateCode, acNo: number) => string | undefined;
}
export interface BuildResult { features: Record<StateCode, any[]>; problems: string[] }

export function buildAcFeatures(raw: RawAc[], meta: AcMeta[], opts: AcFeatureOpts = {}): BuildResult {
  const problems: string[] = [];
  const features: Record<StateCode, any[]> = { AP: [], TG: [] };
  const metaBy = new Map(meta.map(m => [`${m.state}|${m.acNo}`, m]));
  for (const r of raw) {
    const state = stateOfUndivided(r.acNo), acNo = acNoOfUndivided(r.acNo);
    const m = metaBy.get(`${state}|${acNo}`);
    if (!m) { problems.push(`${state} AC ${acNo} (${r.name}) in the shapefile is not in the 2008 table`); continue; }
    const shpName = r.name.replace(/\s*\((ST|SC)\)\s*$/i, "").replace(/\s*\((ST|SC)$/i, "").trim();
    if (!nameClose(shpName, m.name)) problems.push(`${state} AC ${acNo}: shapefile name '${shpName}' differs from 2008 table '${m.name}'`);
    const geom = simplifyGeom(r.geometry, AC_SIMPLIFY_TOL);
    if (!geom) { problems.push(`${state} AC ${acNo}: geometry vanished on simplification`); continue; }
    const errs = geomErrors(geom);
    if (errs.length) { problems.push(`${state} AC ${acNo}: ${[...new Set(errs)].join(", ")}`); continue; }
    const d = opts.district?.(state, acNo);
    features[state].push({
      type: "Feature",
      properties: {
        state, acNo, acName: titleCase(m.name), reservation: m.reservation, pcNo: m.pcNo,
        district: d?.name ?? null, districtLgd: d?.lgd ?? null, districtShare: d?.share ?? null,
        districtPre2014: titleCase(r.distName), lgdAc: opts.lgdAc?.(state, acNo) ?? null,
      },
      geometry: geom,
    });
    if (r.pcNo && Number.isFinite(r.pcNo) && r.pcNo !== (state === "TG" ? m.pcNo : m.pcNo + 17)) problems.push(`${state} AC ${acNo}: shapefile PC_NO ${r.pcNo} disagrees with the 2008 table (PC ${m.pcNo})`);
  }
  for (const f of features.AP.concat(features.TG)) f.properties.acName = f.properties.acName.replace(/\s+/g, " ");
  for (const s of ["AP", "TG"] as StateCode[]) features[s].sort((a, b) => a.properties.acNo - b.properties.acNo);
  return { features, problems };
}

export function buildPcFeatures(fc: any, names?: Record<string, string>): BuildResult {
  const problems: string[] = [];
  const features: Record<StateCode, any[]> = { AP: [], TG: [] };
  for (const f of fc.features ?? []) {
    const p = f.properties ?? {};
    const state: StateCode | null = /^andhra/i.test(p.st_name) ? "AP" : /^telangana/i.test(p.st_name) ? "TG" : null;
    if (!state) continue;
    const geom = simplifyGeom(f.geometry, PC_SIMPLIFY_TOL);
    if (!geom) { problems.push(`${state} PC ${p.pc_no}: empty geometry`); continue; }
    const errs = geomErrors(geom);
    if (errs.length) { problems.push(`${state} PC ${p.pc_no}: ${[...new Set(errs)].join(", ")}`); continue; }
    features[state].push({
      type: "Feature",
      properties: { state, pcNo: Number(p.pc_no), pcName: String(p.pc_name), reservation: p.pc_category === "SC" ? "SC" : p.pc_category === "ST" ? "ST" : "GEN", wikidata_qid: p.wikidata_qid ?? null },
      geometry: geom,
    });
  }
  for (const s of ["AP", "TG"] as StateCode[]) features[s].sort((a, b) => a.properties.pcNo - b.properties.pcNo);
  void names;
  return { features, problems };
}

/** Union polygons; falls back to a plain MultiPolygon of the parts if the union throws. */
export function dissolve(parts: Geom[]): { geom: Geom; dissolved: boolean } {
  const polys = parts.flatMap(toPolys) as Poly[];
  try {
    const out = polygonClipping.union(polys[0] as any, ...(polys.slice(1) as any[])) as unknown as Poly[];
    return { geom: fromPolys(out), dissolved: true };
  } catch {
    return { geom: fromPolys(polys), dissolved: false };
  }
}

export interface DistrictBuild { features: any[]; problems: string[]; notes: string[] }
/**
 * S-88: district polygons by dissolving the full-resolution AC polygons, assigning every AC to the LGD district that
 * holds most of its villages and wards. APPROXIMATION: a district's real border cuts through mandal-split ACs, which we
 * cannot split (no mandal polygons are available). Each feature carries the list of assigned ACs and the share of units
 * of those ACs that actually lie in other districts.
 */
export function buildDistrictFeatures(
  state: StateCode, raw: RawAc[],
  assign: Map<number, { lgd: string; share: number }>, districts: { lgd: string; name: string }[],
): DistrictBuild {
  const problems: string[] = [], notes: string[] = [];
  const groups = new Map<string, { acs: number[]; shares: number[]; geoms: Geom[] }>();
  for (const r of raw) {
    if (stateOfUndivided(r.acNo) !== state) continue;
    const no = acNoOfUndivided(r.acNo), a = assign.get(no);
    if (!a) { problems.push(`${state} AC ${no} has no district assignment`); continue; }
    const g = groups.get(a.lgd) ?? { acs: [], shares: [], geoms: [] };
    g.acs.push(no); g.shares.push(a.share); g.geoms.push(simplifyGeom(r.geometry, 0.0002, 5) ?? r.geometry);
    groups.set(a.lgd, g);
  }
  const features: any[] = [];
  for (const d of [...districts].sort((a, b) => Number(a.lgd) - Number(b.lgd))) {
    const g = groups.get(d.lgd);
    if (!g) { notes.push(`${state} district ${d.name} (${d.lgd}) has no AC whose majority of units lie in it: no polygon (new district with no majority AC)`); continue; }
    const { geom, dissolved } = dissolve(g.geoms);
    // drop sliver holes left by independent AC boundaries
    const cleaned: Poly[] = toPolys(geom).map(p => [p[0], ...p.slice(1).filter(h => Math.abs(polyArea([h])) > 2e-6)]);
    const simp = simplifyGeom(fromPolys(cleaned), DISTRICT_SIMPLIFY_TOL, 4);
    if (!simp) { problems.push(`${state} district ${d.name}: empty after simplification`); continue; }
    const errs = geomErrors(simp);
    if (errs.length) { problems.push(`${state} district ${d.name}: ${[...new Set(errs)].join(", ")}`); continue; }
    const minShare = Math.min(...g.shares);
    features.push({
      type: "Feature",
      properties: {
        state, district: d.name, districtLgd: d.lgd, method: "ac-dissolve-majority", approximate: true, dissolved,
        acs: g.acs.sort((a, b) => a - b), minAcShareInDistrict: minShare,
      },
      geometry: simp,
    });
  }
  return { features, problems, notes };
}

/** Reservation tag embedded in the shapefile AC name, e.g. "Boath (ST)" (tolerates the truncated "(SC"). */
export const reservationTag = (name: string): "SC" | "ST" | "GEN" => (/\(\s*SC\)?\s*$/i.test(name) ? "SC" : /\(\s*ST\)?\s*$/i.test(name) ? "ST" : "GEN");

/**
 * S-82: the 2008 CSV is the primary source for reservation and PC link, cross-checked against the "(SC)/(ST)" tags in the
 * shapefile names. Where they disagree the shapefile tag wins (the CSV marks Nagarkurnool SC, which would give TG 20 SC
 * seats against the statutory 19) and the conflict is returned for the report.
 */
export function reconcileReservation(meta: AcMeta[], raw: RawAc[]): { acs: AcMeta[]; conflicts: string[] } {
  const tags = new Map(raw.map(r => [`${stateOfUndivided(r.acNo)}|${acNoOfUndivided(r.acNo)}`, reservationTag(r.name)]));
  const conflicts: string[] = [];
  const acs = meta.map(m => {
    const t = tags.get(`${m.state}|${m.acNo}`);
    if (!t || t === m.reservation) return m;
    conflicts.push(`${m.state} AC ${m.acNo} ${m.name}: 2008 CSV says ${m.reservation}, shapefile name tag says ${t}; using ${t}`);
    return { ...m, reservation: t };
  });
  return { acs, conflicts };
}
