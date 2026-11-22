import type { CandidateResult } from "../src/lib/elections";
import { STATES } from "../src/lib/states";
import type { CensusDistrict } from "./census";

/** Shape of data/generated/elections.json */
export interface ElectionSnapshot {
  schema: 1;
  provenance: "ECI" | "TCPD" | "demo";
  source: string;
  results: CandidateResult[];
}

/** Shape of data/generated/census.json */
export interface CensusSnapshot {
  schema: 1;
  provenance: "data.gov.in" | "demo";
  source: string;
  districts: CensusDistrict[];
}

/** Returns a list of human-readable violations (empty = pass). */
export function validateElections(rows: CandidateResult[], enforceSeatCounts: boolean): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  const seats = new Map<string, CandidateResult[]>();
  for (const r of rows) {
    const id = `${r.state}|${r.year}|${r.type}|${r.acNo}|${r.candidate}`;
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
    if (d.literate > d.population || d.scPop > d.population || d.stPop > d.population) errs.push(`subgroup exceeds population: ${id}`);
  }
  return errs;
}

export function validateGeoJson(g: any, label: string): string[] {
  if (!g || g.type !== "FeatureCollection" || !Array.isArray(g.features) || g.features.length === 0)
    return [`${label}: not a non-empty FeatureCollection`];
  return [];
}
