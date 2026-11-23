import type { ElectionType, StateCode } from "./states";

/** One row per candidate per constituency per election (normalised). */
export interface CandidateResult {
  state: StateCode;
  year: number;
  type: ElectionType;
  acNo: number;
  acName: string;
  district?: string;
  candidate: string;
  party: string;
  votes: number;
  position: number; // 1 = winner
  validVotes: number;
  electors?: number;
  /** TCPD candidate attributes (S-109): present only where the source file carries them. */
  sex?: "M" | "F" | "O";
  age?: number;
  incumbent?: boolean;
  /** TCPD's own party-switch flag. INTERNAL: never published as a fact or shown as a label (MCC neutrality). */
  tcpdTurncoat?: boolean;
  provenance?: "ECI" | "TCPD" | "demo";
  /** Source's own turnout figure (TCPD Turnout_Percentage = valid votes / electors, in %), kept when present. */
  turnoutPct?: number;
  /** Set on rows fought before the 2 June 2014 bifurcation, mapped onto today's AP/TG seats (data/generated/history). */
  comparability?: "pre-bifurcation";
  /** Constituency number in the undivided-AP source numbering (pre-bifurcation rows only). */
  undividedNo?: number;
}

export interface SeatResult {
  acNo: number; acName: string; winner: string; winnerParty: string;
  runnerUpParty: string | null; margin: number; marginPct: number; validVotes: number;
  /** True when top two candidates have equal votes (winner decided by `position`). */
  tie?: boolean;
  /** True when only one candidate stood. */
  uncontested?: boolean;
  /** Current (LGD) district of the seat; for LS seats the district holding most of the PC's assembly segments. */
  district?: string;
  /** Registered electors (from the candidate rows) when the source carries them. */
  electors?: number;
  /** Telugu constituency name when the gazetteer has one (never guessed). */
  acNameTe?: string;
}
/** Optional per-seat enrichment supplied by the API layer from the committed geo data. */
export type SeatGeoFn = (acNo: number) => { district?: string; acNameTe?: string } | undefined;

const key = (r: CandidateResult) => `${r.state}|${r.year}|${r.type}`;

export function filterElection(rows: CandidateResult[], state: StateCode, year: number, type: ElectionType) {
  return rows.filter(r => r.state === state && r.year === year && r.type === type);
}

function extras(sorted: CandidateResult[], acNo: number, geo?: SeatGeoFn): Pick<SeatResult, "district" | "electors" | "acNameTe"> {
  const electors = sorted.find(c => (c.electors ?? 0) > 0)?.electors;
  const g = geo?.(acNo);
  return { ...(g?.district ? { district: g.district } : {}), ...(electors ? { electors } : {}), ...(g?.acNameTe ? { acNameTe: g.acNameTe } : {}) };
}

/** Winner / runner-up / margin per constituency. */
export function seatResults(rows: CandidateResult[], geo?: SeatGeoFn): SeatResult[] {
  const byAc = new Map<number, CandidateResult[]>();
  for (const r of rows) byAc.set(r.acNo, [...(byAc.get(r.acNo) ?? []), r]);
  return [...byAc.values()].map(list => {
    // Votes desc; ties broken by recorded position (1 = winner), then name for determinism.
    const sorted = [...list].sort((a, b) =>
      (b.votes || 0) - (a.votes || 0) || (a.position || 99) - (b.position || 99) || a.candidate.localeCompare(b.candidate));
    const [w, ru] = sorted;
    const margin = Math.max(0, (w.votes || 0) - (ru?.votes ?? 0));
    const valid = w.validVotes || sorted.reduce((s, c) => s + (c.votes || 0), 0);
    return {
      acNo: w.acNo, acName: w.acName, winner: w.candidate, winnerParty: w.party,
      runnerUpParty: ru?.party ?? null, margin, marginPct: valid ? (margin / valid) * 100 : 0, validVotes: valid,
      tie: !!ru && ru.votes === w.votes, uncontested: !ru,
      ...extras(sorted, w.acNo, geo),
    };
  }).sort((a, b) => a.acNo - b.acNo);
}

export function seatTally(seats: SeatResult[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const s of seats) t[s.winnerParty] = (t[s.winnerParty] ?? 0) + 1;
  return t;
}

/** Party vote share (%) of total votes polled for the election. */
export function voteShare(rows: CandidateResult[]): Record<string, number> {
  const total = rows.reduce((s, r) => s + r.votes, 0);
  const by: Record<string, number> = {};
  for (const r of rows) by[r.party] = (by[r.party] ?? 0) + r.votes;
  for (const p of Object.keys(by)) by[p] = total ? (by[p] / total) * 100 : 0;
  return by;
}

/** Swing in percentage points per party: share(to) - share(from). Parties absent in one election count as 0. */
export function swing(from: CandidateResult[], to: CandidateResult[]): Record<string, number> {
  const a = voteShare(from), b = voteShare(to);
  const out: Record<string, number> = {};
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) out[p] = (b[p] ?? 0) - (a[p] ?? 0);
  return out;
}

export function marginalSeats(seats: SeatResult[], thresholdPct: number): SeatResult[] {
  if (!Number.isFinite(thresholdPct)) return [];
  return seats.filter(s => s.marginPct < thresholdPct).sort((a, b) => a.marginPct - b.marginPct);
}

export type MarginBucket = "<2%" | "2-5%" | "5-10%" | ">10%";
export function marginBuckets(seats: SeatResult[]): Record<MarginBucket, number> {
  const o: Record<MarginBucket, number> = { "<2%": 0, "2-5%": 0, "5-10%": 0, ">10%": 0 };
  for (const s of seats) o[s.marginPct < 2 ? "<2%" : s.marginPct < 5 ? "2-5%" : s.marginPct < 10 ? "5-10%" : ">10%"]++;
  return o;
}

/** Aggregate parties into named alliances; unlisted parties stay as themselves. */
export function aggregateAlliances(tally: Record<string, number>, alliances: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  const member = new Map<string, string>();
  for (const [name, parties] of Object.entries(alliances)) parties.forEach(p => member.set(p, name));
  for (const [p, n] of Object.entries(tally)) { const k = member.get(p) ?? p; out[k] = (out[k] ?? 0) + n; }
  return out;
}

/** Constituencies (by name) where the Lok Sabha-segment winner differs from the assembly winner in the same state/year. */
export function splitVoting(assembly: SeatResult[], lsSegmentWinners: Record<number, string>): SeatResult[] {
  return assembly.filter(s => lsSegmentWinners[s.acNo] && lsSegmentWinners[s.acNo] !== s.winnerParty);
}

export function turnoutPct(votesPolled: number, electors: number): number {
  return electors > 0 ? (votesPolled / electors) * 100 : 0;
}
