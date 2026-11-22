export type StateCode = "AP" | "TG";
export type ElectionType = "assembly" | "ls";

export interface StateConfig {
  code: StateCode;
  name: string;
  nameTe: string;
  assemblySeats: number;
  lsSeats: number;
  regions: string[];
  /** Census 2011 state code (Census of India) */
  censusStateCode: string;
}

export const STATES: Record<StateCode, StateConfig> = {
  AP: { code: "AP", name: "Andhra Pradesh", nameTe: "ఆంధ్ర ప్రదేశ్", assemblySeats: 175, lsSeats: 25, regions: ["Uttarandhra", "Coastal", "Rayalaseema"], censusStateCode: "28" },
  TG: { code: "TG", name: "Telangana", nameTe: "తెలంగాణ", assemblySeats: 119, lsSeats: 17, regions: ["Hyderabad", "North Telangana", "South Telangana"], censusStateCode: "36" },
};

export const isStateCode = (s: string): s is StateCode => s === "AP" || s === "TG";
export const isElectionType = (s: string): s is ElectionType => s === "assembly" || s === "ls";

import alliancesData from "../../data/reference/alliances.json";

export type AllianceKind = "pre-poll" | "post-hoc";
export interface AllianceGroup {
  name: string; parties: string[]; kind: AllianceKind; confidence: "high" | "medium" | "low"; note?: string; sources: string[];
}
export interface AllianceRecord {
  key: string; state: StateCode; year: number; type: ElectionType; groups: AllianceGroup[]; comparabilityNotes?: string[];
}

/** Cited per-election alliance records (data/reference/alliances.json). Elections without a record have no grouping. */
export const ALLIANCE_RECORDS: Record<string, AllianceRecord> =
  Object.fromEntries((alliancesData.records as AllianceRecord[]).map(r => [r.key, r]));

export const alliancesAsOf: string = alliancesData.asOf;

/** Groups for one election, optionally restricted by kind (default: all). */
export function allianceGroups(state: StateCode, year: number, type: ElectionType, kind?: AllianceKind): AllianceGroup[] {
  const g = ALLIANCE_RECORDS[`${state}-${year}-${type}`]?.groups ?? [];
  return kind ? g.filter(x => x.kind === kind) : g;
}

/**
 * Pre-poll alliances by state/year/type as { name: parties[] }, used for alliance aggregation. Derived from the cited
 * records; post-hoc (hindsight) groupings are excluded here and available through allianceGroups().
 */
export const ALLIANCES: Record<string, Record<string, string[]>> = Object.fromEntries(
  Object.values(ALLIANCE_RECORDS)
    .map(r => [r.key, Object.fromEntries(r.groups.filter(g => g.kind === "pre-poll").map(g => [g.name, g.parties]))] as const)
    .filter(([, g]) => Object.keys(g).length > 0),
);
