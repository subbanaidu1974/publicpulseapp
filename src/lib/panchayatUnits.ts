/**
 * Panchayat unit-level logic (S-213 place matching, S-214 browsing roll-ups, S-215 trends). Pure functions over unit rows and the LGD directory.
 * Nothing here invents a match: a unit is matched by its LGD code, or by district + mandal + name when that is unique, and is otherwise reported
 * as unmatched or in conflict. Roll-ups never rank places.
 */
import type { PanchayatElection, PanchayatUnit } from "./panchayat";

/** The parts of data/generated/geo/lgd-<ST>.json used here: [lgd, name, ...] rows. */
export interface LgdFile {
  districts: (string | number)[][];            // [lgd, name, ...]
  mandals: (string | number)[][];              // [lgd, name, districtLgd, ...]
  gps: (string | number)[][];                  // [lgd, name, nameTe, mandalLgd]
}
export type MatchKind = "code" | "name" | "conflict" | "none";
export interface JoinedUnit extends PanchayatUnit {
  id: string; nameTe: string | null; matchedLgd: string | null; match: MatchKind; lgdDistrict: string | null; lgdMandal: string | null;
}
export interface JoinStats { total: number; byCode: number; byName: number; conflicts: number; unmatched: number; unmatchedNames: string[] }

/** Lower-case letters and digits only, with the words "gram", "panchayat" and "gp" dropped, so "Tamsi (GP)" and "Tamsi Gram Panchayat" meet. */
export const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\b(gram|panchayat|gp|mandal)\b/g, " ").replace(/\s+/g, "");

export interface Directory {
  byLgd: Map<string, { name: string; nameTe: string; mandal: string; district: string }>;
  byName: Map<string, string[]>;   // district|mandal|name -> lgd codes
  byNameNoMandal: Map<string, string[]>; // district|name -> lgd codes
}

export function buildDirectory(lgd: LgdFile): Directory {
  const dist = new Map(lgd.districts.map((d) => [String(d[0]), String(d[1])]));
  const mand = new Map(lgd.mandals.map((m) => [String(m[0]), { name: String(m[1]), district: dist.get(String(m[2])) ?? "" }]));
  const byLgd: Directory["byLgd"] = new Map(); const byName: Directory["byName"] = new Map(); const byNameNoMandal: Directory["byNameNoMandal"] = new Map();
  const push = (m: Map<string, string[]>, k: string, v: string) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const g of lgd.gps) {
    const code = String(g[0]); const m = mand.get(String(g[3]));
    if (!m) continue;
    byLgd.set(code, { name: String(g[1]), nameTe: String(g[2] ?? ""), mandal: m.name, district: m.district });
    push(byName, `${norm(m.district)}|${norm(m.name)}|${norm(String(g[1]))}`, code);
    push(byNameNoMandal, `${norm(m.district)}|${norm(String(g[1]))}`, code);
  }
  return { byLgd, byName, byNameNoMandal };
}

/** Match units to LGD gram panchayats. Only gram panchayat elections are matched; other levels pass through unmatched. */
export function joinUnits(units: PanchayatUnit[], level: PanchayatElection["level"], dir: Directory | null, electionId = ""): { units: JoinedUnit[]; stats: JoinStats } {
  const stats: JoinStats = { total: units.length, byCode: 0, byName: 0, conflicts: 0, unmatched: 0, unmatchedNames: [] };
  const out = units.map((u, i): JoinedUnit => {
    const base: JoinedUnit = { ...u, mandal: u.mandal, id: `${electionId}:${u.lgdCode ?? i}`, nameTe: null, matchedLgd: null, match: "none", lgdDistrict: null, lgdMandal: null };
    if (level !== "gp" || !dir) return base;
    if (u.lgdCode) {
      const g = dir.byLgd.get(String(u.lgdCode));
      if (g) {
        const sameDistrict = norm(g.district) === norm(u.district);
        const sameMandal = !u.mandal || norm(g.mandal) === norm(u.mandal);
        if (!sameDistrict || !sameMandal) { stats.conflicts++; return { ...base, match: "conflict", lgdDistrict: g.district, lgdMandal: g.mandal }; }
        stats.byCode++;
        return { ...base, match: "code", matchedLgd: String(u.lgdCode), nameTe: g.nameTe || null, lgdDistrict: g.district, lgdMandal: g.mandal };
      }
    }
    const hits = u.mandal ? dir.byName.get(`${norm(u.district)}|${norm(u.mandal)}|${norm(u.name)}`) : dir.byNameNoMandal.get(`${norm(u.district)}|${norm(u.name)}`);
    if (hits && hits.length === 1) {
      const g = dir.byLgd.get(hits[0])!;
      stats.byName++;
      return { ...base, match: "name", matchedLgd: hits[0], nameTe: g.nameTe || null, lgdDistrict: g.district, lgdMandal: g.mandal };
    }
    stats.unmatched++;
    if (stats.unmatchedNames.length < 10) stats.unmatchedNames.push(`${u.name} (${u.district}${u.mandal ? `, ${u.mandal}` : ""})`);
    return base;
  });
  return { units: out, stats };
}

export interface Group { key: string; name: string; units: number; posts: number; unopposed: number; unopposedPct: number; meanTurnoutPct: number | null; unmatched: number }

/** Roll units up by district or by mandal. Orders by name, never by a result. */
export function rollup(units: JoinedUnit[], by: "district" | "mandal"): Group[] {
  const m = new Map<string, JoinedUnit[]>();
  for (const u of units) {
    const k = by === "district" ? u.district : (u.mandal ?? "-");
    const a = m.get(k); if (a) a.push(u); else m.set(k, [u]);
  }
  return [...m.entries()].map(([key, us]) => {
    const t = us.filter((u) => u.turnoutPct != null);
    const un = us.filter((u) => u.unopposed).length;
    return {
      key, name: key, units: us.length, posts: us.reduce((n, u) => n + u.posts, 0), unopposed: un, unopposedPct: Math.round((un / us.length) * 1000) / 10,
      meanTurnoutPct: t.length ? Math.round((t.reduce((n, u) => n + (u.turnoutPct as number), 0) / t.length) * 100) / 100 : null,
      unmatched: us.filter((u) => u.match === "none" || u.match === "conflict").length,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export interface TrendPoint { id: string; year: number; period: string; units: number; posts: number; unopposedPct: number; meanTurnoutPct: number | null }
export interface Trend { level: PanchayatElection["level"]; points: TrendPoint[]; sharedUnits: number; notes: string[] }

/** Compare cycles of one level. Needs at least two cycles with unit rows; says how many units appear in every cycle so a change in the unit list is visible. */
export function trends(elections: PanchayatElection[], level: PanchayatElection["level"]): Trend {
  const els = elections.filter((e) => e.level === level && e.units?.length).sort((a, b) => a.year - b.year);
  const key = (u: PanchayatUnit) => (u.lgdCode ? `c:${u.lgdCode}` : `n:${norm(u.district)}|${norm(u.mandal)}|${norm(u.name)}`);
  const points = els.map((e): TrendPoint => {
    const us = e.units!; const t = us.filter((u) => u.turnoutPct != null);
    return {
      id: e.id, year: e.year, period: e.period, units: us.length, posts: us.reduce((n, u) => n + u.posts, 0),
      unopposedPct: Math.round((us.filter((u) => u.unopposed).length / us.length) * 1000) / 10,
      meanTurnoutPct: t.length ? Math.round((t.reduce((n, u) => n + (u.turnoutPct as number), 0) / t.length) * 100) / 100 : null,
    };
  });
  let shared = 0;
  if (els.length) {
    const sets = els.map((e) => new Set(e.units!.map(key)));
    shared = [...sets[0]].filter((k) => sets.every((s) => s.has(k))).length;
  }
  const notes: string[] = [];
  if (els.length < 2) notes.push("Needs at least two cycles with unit rows to compare.");
  else {
    notes.push("Turnout is the plain average of the units' own turnout, not weighted by electors.");
    if (new Set(points.map((p) => p.units)).size > 1) notes.push("The number of units differs between cycles (new or merged panchayats), so totals are not like for like.");
    notes.push(`${shared} unit(s) appear in every cycle shown.`);
  }
  return { level, points, sharedUnits: shared, notes };
}
