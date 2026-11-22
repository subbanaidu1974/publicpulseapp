import type { ElectionType, StateCode } from "../lib/states";

/** Typed client for the read-only /api/v1 contract. Responses carry `demo:boolean`. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface Envelope { demo?: boolean; source?: string; asOf?: string }

export interface StateInfo {
  code: StateCode;
  name?: string;
  assemblySeats?: number;
  lsSeats?: number;
  years?: number[];
  elections?: { year: number; type: ElectionType }[];
}

export interface Seat {
  acNo: number;
  acName: string;
  acNameTe?: string;
  district?: string;
  winner?: string;
  winnerParty: string;
  runnerUpParty?: string | null;
  margin?: number;
  marginPct?: number;
  validVotes?: number;
  electors?: number;
  turnout?: number;
  provenance?: string;
  year?: number;
  type?: ElectionType;
}

export interface AllianceRow { name: string; seats: number; parties?: string[]; voteShare?: number }

export interface Summary extends Envelope {
  totalSeats?: number;
  tally: Record<string, number>;
  voteShare: Record<string, number>;
  alliances: unknown | null;
  marginBuckets: Record<string, number>;
}

export interface DataStatusRow { name: string; rows: number; provenance: string; generatedAt: string | null }

export interface SwingResult extends Envelope { from: number; to: number; type: ElectionType; swing: Record<string, number> }

export interface ForecastSeat { acNo: number; acName: string; district?: string; leader: string; runnerUp: string; marginPct: number; winProbLeader: number; class: "safe" | "lean" | "toss-up" | string }
export interface ForecastAlliance { alliance: string; seatsMedian: number; seatsP10: number; seatsP90: number; majorityProb: number }
export interface Forecast {
  state: StateCode; basedOn?: unknown; method?: string; disclaimer?: string; blackout?: boolean;
  seats?: ForecastSeat[]; alliances?: ForecastAlliance[]; backtest?: unknown;
}

export interface CensusRow { district?: string; name?: string; censusYear?: number; population?: number; literacy?: number; literacyPct?: number; scPct?: number; stPct?: number; [k: string]: unknown }

const BASE = "/api/v1";

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = params
    ? "?" + Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
    : "";
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs}`);
  } catch {
    throw new ApiError("Network error: could not reach the data service.", 0);
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new ApiError(body?.error?.message ?? body?.error ?? body?.message ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

const arr = <T,>(x: any, ...keys: string[]): T[] => {
  if (Array.isArray(x)) return x as T[];
  for (const k of keys) if (Array.isArray(x?.[k])) return x[k] as T[];
  return [];
};

export const api = {
  async states(): Promise<StateInfo[]> {
    return arr<StateInfo>(await get<any>("/states"), "states", "data");
  },
  async seats(state: StateCode, year: number, type: ElectionType): Promise<{ seats: Seat[]; demo: boolean }> {
    const r = await get<any>("/elections", { state, year, type });
    return { seats: arr<Seat>(r, "seats", "results"), demo: !!r?.demo };
  },
  summary(state: StateCode, year: number, type: ElectionType) {
    return get<Summary>(`/elections/${state}/summary`, { year, type });
  },
  async marginal(state: StateCode, year: number, type: ElectionType, threshold = 2): Promise<{ seats: Seat[]; demo: boolean }> {
    const r = await get<any>(`/elections/${state}/marginal`, { year, type, threshold });
    return { seats: arr<Seat>(r, "seats", "marginal", "results"), demo: !!r?.demo };
  },
  swing(state: StateCode, type: ElectionType, from: number, to: number) {
    return get<SwingResult>(`/elections/${state}/swing`, { type, from, to });
  },
  /** Forecast endpoint may not exist yet: 404 resolves to null so the UI can show a quiet "unavailable" state. */
  async forecast(state: StateCode): Promise<Forecast | null> {
    try { return await get<Forecast>(`/elections/${state}/forecast`); }
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  },
  async census(state: StateCode): Promise<{ rows: CensusRow[]; demo: boolean }> {
    const r = await get<any>(`/census/${state}/districts`);
    return { rows: arr<CensusRow>(r, "districts", "rows", "data"), demo: !!r?.demo };
  },
  async dataStatus(): Promise<{ rows: DataStatusRow[]; demo: boolean }> {
    const r = await get<any>("/data-status");
    return { rows: arr<DataStatusRow>(r, "datasets", "sources", "status", "data"), demo: !!r?.demo };
  },
};

/** Normalise the (loosely specified) alliances payload to rows. */
export function normaliseAlliances(raw: unknown): AllianceRow[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((a: any) => ({
      name: String(a.name ?? a.alliance ?? "Alliance"),
      seats: Number(a.seats ?? a.total ?? a.wins ?? 0),
      parties: a.parties,
      voteShare: a.voteShare ?? a.share,
    }));
  }
  const o = raw as any;
  if (o && typeof o === "object" && o.tally && typeof o.tally === "object") {
    return Object.entries(o.tally as Record<string, number>).map(([name, seats]) => ({ name, seats: Number(seats), parties: o.definition?.[name] }));
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, any>).map(([name, v]) =>
      typeof v === "number"
        ? { name, seats: v }
        : { name, seats: Number(v?.seats ?? v?.total ?? v?.wins ?? 0), parties: v?.parties, voteShare: v?.voteShare ?? v?.share },
    );
  }
  return [];
}

/** True when the elections dataset is real (TCPD/ECI) rather than demo seed data. */
export function electionsProvenance(rows: DataStatusRow[]): { provenance: string; real: boolean; generatedAt: string | null } {
  const r = rows.find((x) => x.name === "elections");
  const provenance = r?.provenance ?? "unknown";
  return { provenance, real: !!r && !/demo|unknown/i.test(provenance), generatedAt: r?.generatedAt ?? null };
}
