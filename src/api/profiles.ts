import { ApiError } from "./client";
import type { StateCode } from "../lib/states";

/** Typed client for the geography / profile routes (server/geo-api.ts) plus optional civic and member lookups. */

export interface SourceInfo { dataset: string; provenance?: string; urls?: string[]; licences?: string[]; attribution: string; asOf: string | null }
export interface NamePair { nameEn: string; nameTe?: string }

export interface HistoryCandidate { name: string; party: string; votes: number; position: number }
export interface HistoryRow {
  year: number; name: string; winner: string; winnerParty: string; runnerUpParty: string | null; margin: number; marginPct: number;
  validVotes: number; electors?: number; turnoutPct?: number; uncontested?: boolean; tie?: boolean; candidateCount: number;
  candidates: HistoryCandidate[]; provenance: string | null;
}
export interface ConstituencyProfileData extends NamePair {
  state: StateCode; acNo: number; lgdCode: string | null; reservation: string | null;
  district: (NamePair & { code: string; share: number; href: string }) | null;
  districtPre2014: string | null;
  pc: (NamePair & { pcNo: number; nameEn: string | null; reservation: string | null; segments: number[]; history: HistoryRow[] }) | null;
  units: { mandals: number; villages: number; wards: number; urbanBodies: number } | null;
  mandals: (NamePair & { code: string; href: string })[];
  electors: number | null; electorsYear: number | null;
  /** GE-2024 rolls (not SSR 2025), counts only; null when the ECI file has no row. */
  electorsRoll?: { general: number; nri: number; service: number; male: number; female: number; thirdGender: number; total: number; votesPolledEvm: number; rollYear: number; rollBasis: string; note: string } | null;
  census: { basis: string; villagesWithCensus: number; villagesTotal: number; population: number | null; scPop: number | null; stPop: number | null; scPct: number | null; stPct: number | null; literacy?: AcLiteracy | null } | null;
  history: HistoryRow[];
  links: { boundary: string; pcBoundary: string; page: string };
  delimitation: string; asOf: string | null; demo: boolean; source?: SourceInfo[];
}

/** Approximate constituency literacy from whole Census 2011 village and town units (S-84). */
export interface AcLiteracy {
  approximate: true; basis: string; literate: number; pop0to6: number; literacyPct: number | null; unitsMapped: number; villageUnits: number; townUnits: number; splitUnits: number;
  populationMapped: number; populationWithLiteracy: number; literacyCoveragePct: number | null; reasons: string[]; source: string;
}
export interface CensusBlock {
  available: boolean; censusYear: number; reason?: string; kind?: string;
  population?: number; households?: number; males?: number; females?: number; scPop?: number; stPop?: number;
  scPct?: number | null; stPct?: number | null; sexRatio?: number | null; literacyPct?: number | null; literacyNote?: string; literate?: number; pop0to6?: number;
}
export interface PlaceProfileData extends NamePair {
  state: StateCode; level: "district" | "mandal" | "village"; code: string; censusCode: string; category?: string;
  path: ({ level: string; code?: string; name?: string } & Partial<NamePair>)[];
  villages?: number; mandals?: number;
  constituency?: (NamePair & { acNo: number; reservation: string | null; href: string }) | null;
  constituencies?: (NamePair & { acNo: number; reservation: string | null; href: string })[];
  census: CensusBlock; censusNote: string; asOf: string | null; source?: SourceInfo[];
}

export interface GeoHit { kind: "ac" | "district" | "mandal" | "village"; code: string; nameEn: string; nameTe?: string; path: string[]; href: string; acNo?: number }
export interface GeoSearch { state: StateCode; q: string; total: number; results: GeoHit[] }

export interface IssueAgg { unit: string; total: number; resolved: number; open: number }

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try { res = await fetch(`/api/v1${path}`); } catch { throw new ApiError("Network error: could not reach the data service.", 0, "network"); }
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, typeof body?.code === "string" ? body.code : "");
  return body as T;
}

/** Suppression threshold for civic aggregates (matches the server MIN_CELL). Nothing smaller is ever shown. */
export const MIN_ISSUE_CELL = 30;

export const profiles = {
  constituency: (state: StateCode, acNo: number) => getJson<ConstituencyProfileData>(`/constituencies/${state}/${acNo}`),
  place: (state: StateCode, level: string, code: string) => getJson<PlaceProfileData>(`/geo/${state}/places/${level}/${encodeURIComponent(code)}`),
  search: (state: StateCode, q: string) => getJson<GeoSearch>(`/geo/${state}/search?q=${encodeURIComponent(q)}`),
  boundary: (state: StateCode, kind: "ac" | "pc" | "district") => getJson<any>(`/geo/${state}/${kind}.geojson`),

  /** Current member, if the members route exists. Any failure (404, network, odd shape) resolves to null: the UI omits the row. */
  async member(state: StateCode, acNo: number): Promise<{ name: string; party?: string; since?: string } | null> {
    try {
      const r: any = await getJson(`/members/${state}/assembly/${acNo}`);
      const m = r?.member ?? null; // MemberDetail from server/people-api.ts (null when the seat is vacant)
      const name = m?.name;
      return typeof name === "string" && name ? { name, party: m.party?.name ?? m.party?.code, since: m.since ?? undefined } : null;
    } catch { return null; }
  },

  /**
   * Civic issue totals for a civic unit code (V-/M-/D-<lgd>). Server cells under 30 are already rolled up; cells under
   * MIN_ISSUE_CELL are dropped again here as a second guard. Returns null when the civic API is unavailable.
   */
  async issues(unit: string): Promise<IssueAgg | null> {
    try {
      const r: any = await getJson("/civic/issues/metrics?level=department");
      const cells = (r?.cells ?? []).filter((c: any) => c.unit_lgd === unit && c.total >= MIN_ISSUE_CELL);
      if (!cells.length) return { unit, total: 0, resolved: 0, open: 0 };
      return {
        unit, total: cells.reduce((s: number, c: any) => s + c.total, 0),
        resolved: cells.reduce((s: number, c: any) => s + c.resolved, 0), open: cells.reduce((s: number, c: any) => s + c.open, 0),
      };
    } catch { return null; }
  },
};

/** Hash routes: #/place/<ST>/<district|mandal|village>/<code> and #/constituency/<ST>/<acNo>. */
export type ProfileRoute = { kind: "place"; state: StateCode; level: "district" | "mandal" | "village"; code: string } | { kind: "ac"; state: StateCode; acNo: number };

export function parseProfileHash(hash: string): ProfileRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return ""; } });
  const st = (parts[1] ?? "").toUpperCase();
  if (st !== "AP" && st !== "TG") return null;
  if (parts[0] === "place" && parts.length === 4 && ["district", "mandal", "village"].includes(parts[2]) && /^\w{1,20}$/.test(parts[3])) {
    return { kind: "place", state: st, level: parts[2] as "district" | "mandal" | "village", code: parts[3] };
  }
  if (parts[0] === "constituency" && parts.length === 3 && /^\d{1,3}$/.test(parts[2])) return { kind: "ac", state: st, acNo: Number(parts[2]) };
  return null;
}

/** Civic unit code for an LGD code at a level. */
export const civicUnit = (level: "district" | "mandal" | "village", code: string) => `${level === "district" ? "D" : level === "mandal" ? "M" : "V"}-${code}`;

export const placeHash = (state: StateCode, level: string, code: string | number) => (level === "ac" ? `#/constituency/${state}/${code}` : `#/place/${state}/${level}/${code}`);
