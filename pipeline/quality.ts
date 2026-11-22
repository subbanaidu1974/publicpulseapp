import type { CandidateResult } from "../src/lib/elections";
import { STATES } from "../src/lib/states";
import { geomErrors } from "./geo/geometry";
import type { CensusDistrict } from "./census";

/** Shape of data/generated/elections.json */
export interface ElectionSnapshot {
  schema: 1;
  provenance: "ECI" | "TCPD" | "demo";
  source: string;
  results: CandidateResult[];
}

export type CensusProvenance = "data.gov.in" | "census-dchb-2011" | "manual-csv" | "demo";

/** Shape of data/generated/census.json */
export interface CensusSnapshot {
  schema: 1;
  provenance: CensusProvenance;
  source: string;
  districts: CensusDistrict[];
}

/** Returns a list of human-readable violations (empty = pass). */
export function validateElections(rows: CandidateResult[], enforceSeatCounts: boolean): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  const seats = new Map<string, CandidateResult[]>();
  for (const r of rows) {
    const id = `${r.state}|${r.year}|${r.type}|${r.acNo}|${r.position}|${r.candidate}`;
    if (seen.has(id)) errs.push(`duplicate candidate row: ${id}`);
    seen.add(id);
    if (!(r.votes >= 0)) errs.push(`negative/invalid votes: ${id}`);
    if (r.votes > r.validVotes) errs.push(`votes exceed validVotes: ${id}`);
    const sk = `${r.state}|${r.year}|${r.type}`;
    const k = `${sk}|${r.acNo}`;
    seats.set(k, [...(seats.get(k) ?? []), r]);
  }
  for (const [k, list] of seats) {
    const sorted = [...list].sort((a, b) => b.votes - a.votes);
    const margin = sorted[0].votes - (sorted[1]?.votes ?? 0);
    if (margin > sorted[0].validVotes) errs.push(`margin exceeds validVotes: ${k}`);
    if (sorted.reduce((s, c) => s + c.votes, 0) > sorted[0].validVotes) errs.push(`sum of votes exceeds validVotes: ${k}`);
  }
  if (enforceSeatCounts) {
    const counts = new Map<string, Set<number>>();
    for (const r of rows) {
      const sk = `${r.state}|${r.year}|${r.type}`;
      counts.set(sk, (counts.get(sk) ?? new Set()).add(r.acNo));
    }
    for (const [sk, set] of counts) {
      const [state, year, type] = sk.split("|");
      const exp = type === "ls" ? STATES[state as "AP" | "TG"].lsSeats : STATES[state as "AP" | "TG"].assemblySeats;
      if (set.size !== exp) errs.push(`seat count ${state} ${year} ${type}: expected ${exp}, got ${set.size}`);
    }
  }
  return errs;
}

export function validateCensus(rows: CensusDistrict[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const d of rows) {
    const id = `${d.state}|${d.district}`;
    if (seen.has(id)) errs.push(`duplicate census district: ${id}`);
    seen.add(id);
    if (d.population <= 0) errs.push(`non-positive population: ${id}`);
    if (d.males + d.females !== d.population) errs.push(`males+females != population: ${id}`);
    if ((d.literate ?? 0) > d.population || d.scPop > d.population || d.stPop > d.population) errs.push(`subgroup exceeds population: ${id}`);
  }
  return errs;
}

export interface GeoJsonRules {
  /** feature property holding the numeric constituency id (e.g. acNo, pcNo) */
  idProp?: string;
  /** exact number of features required (seat count) */
  expectedCount?: number;
  /** ids that must all appear (ID-join against elections.json); extras are also errors */
  joinIds?: Iterable<number>;
}

/** Returns violations (empty = pass). With rules it also checks geometry validity, unique ids, seat count and ID-join. */
export function validateGeoJson(g: any, label: string, rules: GeoJsonRules = {}): string[] {
  if (!g || g.type !== "FeatureCollection" || !Array.isArray(g.features) || g.features.length === 0)
    return [`${label}: not a non-empty FeatureCollection`];
  const errs: string[] = [];
  const { idProp, expectedCount, joinIds } = rules;
  if (expectedCount !== undefined && g.features.length !== expectedCount)
    errs.push(`${label}: expected ${expectedCount} features, got ${g.features.length}`);
  if (idProp || expectedCount !== undefined) {
    const ids = new Set<number>();
    for (const f of g.features) {
      const ge = geomErrors(f?.geometry);
      if (ge.length) errs.push(`${label}: feature ${idProp ? f?.properties?.[idProp] : "?"}: ${[...new Set(ge)].join(", ")}`);
      if (idProp) {
        const id = f?.properties?.[idProp];
        if (!Number.isInteger(id)) errs.push(`${label}: feature without integer ${idProp}`);
        else if (ids.has(id)) errs.push(`${label}: duplicate ${idProp} ${id}`);
        else ids.add(id);
      }
    }
    if (idProp && joinIds) {
      const want = new Set(joinIds);
      const missing = [...want].filter(i => !ids.has(i)).sort((a, b) => a - b), extra = [...ids].filter(i => !want.has(i)).sort((a, b) => a - b);
      if (missing.length) errs.push(`${label}: ${missing.length} ${idProp} in elections.json have no polygon (e.g. ${missing.slice(0, 5).join(",")})`);
      if (extra.length) errs.push(`${label}: ${extra.length} polygons have no ${idProp} in elections.json (e.g. ${extra.slice(0, 5).join(",")})`);
    }
  }
  return errs;
}
