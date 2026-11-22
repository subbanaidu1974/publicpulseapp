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

/** Pre-poll alliances by state/year, used for alliance aggregation. Editable data, not editorial. */
export const ALLIANCES: Record<string, Record<string, string[]>> = {
  "AP-2024-assembly": { "NDA (TDP+JSP+BJP)": ["TDP", "JSP", "BJP"] },
  "AP-2024-ls": { "NDA (TDP+JSP+BJP)": ["TDP", "JSP", "BJP"] },
};
