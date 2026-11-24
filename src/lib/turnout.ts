import type { CandidateResult, SeatGeoFn } from "./elections";
import type { ElectionType, StateCode } from "./states";

/**
 * Turnout, NOTA and candidate-sex analytics (S-120). Pure functions over CandidateResult rows.
 *
 * Definitions (all from the source rows, nothing estimated):
 *  - turnout % = valid votes polled / registered electors x 100. This is exactly TCPD's Turnout_Percentage (checked against every
 *    seat of every election in the file). Rejected votes and postal-ballot handling follow the source; it is "valid-votes turnout".
 *  - NOTA = rows whose party is NOTA ("None of the Above"); NOTA share = NOTA votes / valid votes. NOTA exists from late 2013.
 *  - Gender TURNOUT (women voters / men voters) is not in the TCPD assembly or Lok Sabha result files: reported as not available.
 *    What the files do carry is the SEX OF CANDIDATES, summarised separately and labelled as candidates, never as voters.
 */

export interface SeatTurnout {
  acNo: number; acName: string; district?: string; acNameTe?: string;
  electors: number | null; validVotes: number;
  turnoutPct: number | null; turnoutBasis: "source" | "computed" | null;
  notaVotes: number | null; notaSharePct: number | null;
  candidates: number; womenCandidates: number | null; winnerSex: "M" | "F" | "O" | null;
  margin: number; marginPct: number;
}

export interface TurnoutTotals {
  seats: number; seatsWithElectors: number; electors: number; validVotes: number; turnoutPct: number | null;
  notaVotes: number | null; notaSharePct: number | null;
}
export interface DistrictTurnout extends TurnoutTotals { district: string }

export interface SexSummary {
  /** share of non-NOTA candidate rows that carry a sex value */
  coveragePct: number;
  available: boolean;
  candidates: number; women: number; womenSharePct: number | null; womenWinners: number | null; seatsWithWomenWinner: number | null; seats: number;
}

export interface TurnoutReport {
  state: StateCode; year: number; type: ElectionType;
  statewide: TurnoutTotals; districts: DistrictTurnout[]; seats: SeatTurnout[]; sex: SexSummary;
  genderTurnout: { available: false; reason: string };
  notaAvailable: boolean; comparability?: "pre-bifurcation";
  caveats: string[];
}

export const GENDER_TURNOUT_NA = "Voter turnout split by gender (women and men voters) is not part of the TCPD/ECI candidate-level result files used here, so it is not shown and not estimated. Candidate sex is shown separately.";

const isNota = (r: CandidateResult) => r.party === "NOTA";
const r2 = (n: number) => Math.round(n * 100) / 100;

export function seatTurnouts(rows: CandidateResult[], geo?: SeatGeoFn): SeatTurnout[] {
  const bySeat = new Map<number, CandidateResult[]>();
  for (const r of rows) (bySeat.get(r.acNo) ?? bySeat.set(r.acNo, []).get(r.acNo)!).push(r);
  const hasNota = rows.some(isNota);
  return [...bySeat.values()].map(list => {
    const cands = list.filter(r => !isNota(r));
    const ranked = [...cands].sort((a, b) => b.votes - a.votes || (a.position || 99) - (b.position || 99));
    const w = ranked[0], ru = ranked[1];
    const valid = list[0].validVotes || list.reduce((s, c) => s + c.votes, 0);
    const electors = list.find(r => (r.electors ?? 0) > 0)?.electors ?? null;
    const src = list.find(r => typeof r.turnoutPct === "number")?.turnoutPct;
    const turnout = electors && valid > 0 ? r2((valid / electors) * 100) : null;
    const nota = list.filter(isNota).reduce((s, r) => s + r.votes, 0);
    const margin = w ? Math.max(0, w.votes - (ru?.votes ?? 0)) : 0;
    const sexKnown = cands.some(c => c.sex);
    const g = geo?.(list[0].acNo);
    return {
      acNo: list[0].acNo, acName: list[0].acName,
      ...(g?.district ? { district: g.district } : list[0].district ? { district: list[0].district } : {}), ...(g?.acNameTe ? { acNameTe: g.acNameTe } : {}),
      electors, validVotes: valid,
      turnoutPct: src !== undefined && turnout !== null ? r2(src) : turnout,
      turnoutBasis: (turnout === null ? null : src !== undefined ? "source" : "computed") as SeatTurnout["turnoutBasis"],
      notaVotes: hasNota ? nota : null, notaSharePct: hasNota && valid > 0 ? r2((nota / valid) * 100) : null,
      candidates: cands.length, womenCandidates: sexKnown ? cands.filter(c => c.sex === "F").length : null,
      winnerSex: w?.sex ?? null, margin, marginPct: valid > 0 ? r2((margin / valid) * 100) : 0,
    };
  }).sort((a, b) => a.acNo - b.acNo);
}

export function totalsOf(seats: SeatTurnout[]): TurnoutTotals {
  const withE = seats.filter(s => s.electors && s.validVotes > 0);
  const electors = withE.reduce((s, x) => s + (x.electors ?? 0), 0);
  const valid = withE.reduce((s, x) => s + x.validVotes, 0);
  const notaSeats = seats.filter(s => s.notaVotes !== null);
  const nota = notaSeats.reduce((s, x) => s + (x.notaVotes ?? 0), 0);
  const notaValid = notaSeats.reduce((s, x) => s + x.validVotes, 0);
  return {
    seats: seats.length, seatsWithElectors: withE.length, electors, validVotes: valid,
    turnoutPct: electors > 0 ? r2((valid / electors) * 100) : null,
    notaVotes: notaSeats.length ? nota : null, notaSharePct: notaSeats.length && notaValid > 0 ? r2((nota / notaValid) * 100) : null,
  };
}

export function districtTurnouts(seats: SeatTurnout[]): DistrictTurnout[] {
  const by = new Map<string, SeatTurnout[]>();
  for (const s of seats) if (s.district) (by.get(s.district) ?? by.set(s.district, []).get(s.district)!).push(s);
  return [...by].map(([district, list]) => ({ district, ...totalsOf(list) })).sort((a, b) => a.district.localeCompare(b.district));
}

export function sexSummary(rows: CandidateResult[], seats: SeatTurnout[]): SexSummary {
  const cands = rows.filter(r => !isNota(r));
  const known = cands.filter(r => r.sex);
  const coveragePct = cands.length ? r2((known.length / cands.length) * 100) : 0;
  const available = coveragePct >= 90;
  const women = known.filter(r => r.sex === "F").length;
  const winners = rows.filter(r => r.position === 1 && !isNota(r));
  const wWin = winners.filter(r => r.sex === "F");
  return {
    coveragePct, available, candidates: cands.length, women,
    womenSharePct: available && known.length ? r2((women / known.length) * 100) : null,
    womenWinners: available ? wWin.length : null,
    seatsWithWomenWinner: available ? new Set(wWin.map(r => r.acNo)).size : null,
    seats: seats.length,
  };
}

export function turnoutReport(rows: CandidateResult[], state: StateCode, year: number, type: ElectionType, geo?: SeatGeoFn): TurnoutReport {
  const seats = seatTurnouts(rows, geo);
  const hasNota = rows.some(isNota);
  const pre = rows.some(r => r.comparability === "pre-bifurcation");
  const caveats = [
    "Turnout here is valid votes divided by registered electors (the TCPD definition). It differs slightly from the headline turnout the Election Commission announces, which counts all votes polled.",
    "Electors are as recorded for that election; they are not today's roll.",
  ];
  if (!hasNota) caveats.push("NOTA (None of the Above) was introduced in 2013, so there is no NOTA figure for this election.");
  if (pre) caveats.push("Pre-bifurcation election: held in undivided Andhra Pradesh and split onto today's AP and TG seats by the 2008 delimitation order. Not like-for-like with later elections.");
  if (type === "ls") caveats.push("Lok Sabha figures are per parliamentary constituency; 'district' is the district holding most of its assembly segments.");
  return {
    state, year, type, statewide: totalsOf(seats), districts: districtTurnouts(seats), seats, sex: sexSummary(rows, seats),
    genderTurnout: { available: false, reason: GENDER_TURNOUT_NA }, notaAvailable: hasNota, ...(pre ? { comparability: "pre-bifurcation" as const } : {}), caveats,
  };
}
