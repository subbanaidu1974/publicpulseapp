import { ApiError } from "./client";
import { useApi } from "./useApi";
import type { SeatTurnout, TurnoutTotals, DistrictTurnout, SexSummary } from "../lib/turnout";
import type { PartyCompareRow, PcCompareRow, IncumbencySummary, CandidateTrail } from "../lib/comparison";
import type { StateCode, ElectionType } from "../lib/states";
import type { PartyHistory } from "../lib/partyHistory";
import type { PanchayatResponse, PanchayatSource } from "../lib/panchayat";
import type { Group, JoinStats, JoinedUnit, Trend } from "../lib/panchayatUnits";
import { reportShed, shedFrom } from "../lib/degraded";

/** Typed client for the analytics endpoints (server/analytics-api.ts). */
export interface ElectorsItem { acNo: number; acName: string; pcName: string; general: number; nri: number; service: number; male: number; female: number; thirdGender: number; total: number }
export interface ElectorsResponse { state: StateCode; available: boolean; rollYear?: number; total: number; totalElectors?: number; items: ElectorsItem[]; note: string; source: SourceEnv | null }
export interface PanchayatUnitsResponse {
  state: StateCode; loaded: boolean; fixture: boolean; source?: PanchayatSource; notes: string[]; problems: string[];
  elections: { id: string; level: "gp" | "mptc" | "zptc"; year: number; period: string; units: number }[];
  election?: { id: string; level: "gp" | "mptc" | "zptc"; year: number; period: string; phases: { date: string }[]; caveats: string[] };
  view?: "district" | "mandal" | "units" | "search"; district?: string | null; mandal?: string | null; q?: string | null;
  groups?: Group[]; units?: JoinedUnit[]; unitTotal?: number; join?: JoinStats;
}
export interface PanchayatTrendsResponse { state: StateCode; loaded: boolean; fixture: boolean; source?: PanchayatSource; notes: string[]; problems: string[]; trends: Trend[] }
export type PartiesResponse = PartyHistory & { demo: boolean; notes: string[]; source: SourceEnv | null };
export interface SourceEnv { dataset: string; provenance: string; urls: string[]; licences: string[]; attribution: string; asOf: string | null }

export interface TurnoutResponse {
  demo: boolean; state: StateCode; year: number; type: ElectionType; years: number[];
  statewide: TurnoutTotals; districts: DistrictTurnout[]; seats: SeatTurnout[]; sex: SexSummary;
  genderTurnout: { available: false; reason: string }; notaAvailable: boolean; comparability?: "pre-bifurcation"; caveats: string[];
  source: SourceEnv | null; asOf?: string;
}
export interface CompareResponse {
  demo: boolean; state: StateCode; year: number; years: number[]; parties: PartyCompareRow[]; constituencies: PcCompareRow[];
  incumbency: { assembly: IncumbencySummary | null; ls: IncumbencySummary | null }; comparability?: "pre-bifurcation"; notes: string[]; source: SourceEnv | null; asOf?: string;
}
export interface TrailsResponse { state: StateCode; type: ElectionType; query: string; trails: CandidateTrail[]; note: string; ordering: string }
export interface HistoryResponse {
  state: StateCode; notes: string[]; source: SourceEnv | null; asOf?: string;
  elections: { year: number; type: ElectionType; seats: number; comparability: "current" | "pre-bifurcation"; note: string | null }[];
}
export interface ByElection {
  id: string; state: StateCode; type: ElectionType; acNo: number; seat: string; date: string; kind: "by-election" | "re-poll"; cause: string | null;
  winner: string; party: string; margin: number; marginPct: number | null; validVotes: number; turnoutPct: number | null; candidates: number;
  uncontested?: boolean; sources: string[]; verified: boolean; crossCheck?: string;
}
export interface ByElectionsResponse { records: ByElection[]; count: number; note: string; asOf: string }
export interface PartySwitch {
  id: string; person: string; state: StateCode; constituency: { type: ElectionType; acNo: number; name: string };
  from: string; to: string; date: string; status: "reported" | "confirmed"; sources: { publisher: string; url: string }[]; note?: string;
}
export interface PartySwitchesResponse { records: PartySwitch[]; count: number; blackout: boolean; notice: { en: string; te: string } | null; asOf: string }
export interface SeatsResponse { year: number; type: ElectionType; count: number; tally: Record<string, number>; comparability?: string; seats: { acNo: number; acName: string; winner: string; winnerParty: string }[] }

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = params ? "?" + Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&") : "";
  let res: Response;
  try { res = await fetch(`/api/v1${path}${qs}`); } catch { throw new ApiError("Network error: could not reach the data service.", 0, "network"); }
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = new ApiError(body?.error?.message ?? body?.error ?? `Request failed (${res.status})`, res.status, typeof body?.code === "string" ? body.code : "");
    const sh = shedFrom(res.status, body, res.headers.get("retry-after"));
    if (sh) { e.shed = sh; e.code = "degraded"; reportShed(sh); }
    throw e;
  }
  return body as T;
}

export const analytics = {
  turnout: (state: StateCode, year: number | undefined, type: ElectionType) => get<TurnoutResponse>(`/elections/${state}/turnout`, { year, type }),
  compare: (state: StateCode, year?: number) => get<CompareResponse>(`/analytics/compare/${state}`, { year }),
  trails: (state: StateCode, type: ElectionType, q: string) => get<TrailsResponse>(`/analytics/candidates/${state}`, { type, q }),
  electors: (state: StateCode) => get<ElectorsResponse>(`/electors/${state}`),
  parties: (state: StateCode) => get<PartiesResponse>(`/analytics/parties/${state}`),
  panchayat: (state: StateCode) => get<PanchayatResponse>(`/analytics/panchayat/${state}`),
  panchayatUnits: (state: StateCode, p: { election?: string; district?: string; mandal?: string; q?: string }) => get<PanchayatUnitsResponse>(`/analytics/panchayat/${state}/units`, p),
  panchayatTrends: (state: StateCode) => get<PanchayatTrendsResponse>(`/analytics/panchayat/${state}/trends`),
  history: (state: StateCode) => get<HistoryResponse>(`/history/${state}`),
  byelections: (p: { state?: StateCode; type?: ElectionType; acNo?: number }) => get<ByElectionsResponse>("/byelections", p),
  partySwitches: (p: { state?: StateCode; name?: string; acNo?: number; type?: ElectionType }) => get<PartySwitchesResponse>("/party-switches", p),
  seats: (state: StateCode, year: number, type: ElectionType) => get<SeatsResponse>("/elections", { state, year, type }),
};

export { useApi };
