import { filterElection, seatResults, splitVoting as splitSeats, voteShare } from "./elections";
import type { CandidateResult, SeatResult } from "./elections";
import type { StateCode } from "./states";

/** Largest gap (years) between an assembly election and the Lok Sabha election it is compared with. */
export const MAX_PAIR_GAP = 2;
export const PAIRING_RULE = "Each assembly election is compared with the Lok Sabha election of the same year; when there is none, the nearest Lok Sabha year within 2 years is used (ties go to the earlier year). The year used is always stated.";

/** Nearest Lok Sabha year to an assembly year; null when none lies within `maxGap`. */
export function nearestLsYear(assemblyYear: number, lsYears: number[], maxGap = MAX_PAIR_GAP): { lsYear: number; gap: number } | null {
  let best: { lsYear: number; gap: number } | null = null;
  for (const y of [...new Set(lsYears)].sort((a, b) => a - b)) {
    const gap = Math.abs(y - assemblyYear);
    if (!best || gap < best.gap) best = { lsYear: y, gap };
  }
  return best && best.gap <= maxGap ? best : null;
}

export interface SplitSeat {
  acNo: number; acName: string; pcNo: number | null; assemblyWinner: string; assemblyParty: string;
  lsWinner: string | null; lsParty: string | null; split: boolean | null;
}
export interface SplitPc {
  pcNo: number; pcName: string | null; lsParty: string; segments: number; aligned: number; split: number;
  /** assembly seats won by party inside the PC */
  assemblyWins: Record<string, number>;
  /** percentage points: assembly vote share in the PC's segments minus the PC's Lok Sabha vote share, per party */
  voteShareDiff: Record<string, number>;
}
export interface SplitReport {
  state: StateCode; assemblyYear: number; lsYear: number; gapYears: number; sameCycle: boolean; rule: string; caveat: string | null;
  totalSeats: number; aligned: number; split: number; unmapped: number;
  seats: SplitSeat[]; pcs: SplitPc[];
  /** statewide percentage points, party -> assembly share, Lok Sabha share, difference */
  voteShareDiff: Record<string, { assembly: number; ls: number; diff: number }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function diffShares(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) o[p] = r2((a[p] ?? 0) - (b[p] ?? 0));
  return o;
}

/**
 * Per-AC assembly winner vs the Lok Sabha winner of the PC that AC belongs to. `segments` maps acNo -> pcNo
 * (pipeline/lsmap). Lok Sabha rows carry the PC number in `acNo`. Returns null when either election is missing.
 */
export function splitVotingReport(
  rows: CandidateResult[], state: StateCode, assemblyYear: number, segments: Record<string, number>, lsYearOverride?: number,
): SplitReport | null {
  const asm = filterElection(rows, state, assemblyYear, "assembly");
  if (!asm.length) return null;
  const lsYears = rows.filter(r => r.state === state && r.type === "ls").map(r => r.year);
  const pair = lsYearOverride !== undefined
    ? (lsYears.includes(lsYearOverride) ? { lsYear: lsYearOverride, gap: Math.abs(lsYearOverride - assemblyYear) } : null)
    : nearestLsYear(assemblyYear, lsYears);
  if (!pair) return null;
  const ls = filterElection(rows, state, pair.lsYear, "ls");
  const asmSeats = seatResults(asm);
  const lsSeats = seatResults(ls);
  const lsByPc = new Map<number, SeatResult>(lsSeats.map(s => [s.acNo, s]));

  const lsPartyByAc: Record<number, string> = {};
  const seats: SplitSeat[] = asmSeats.map(s => {
    const pcNo = segments[String(s.acNo)] ?? null;
    const l = pcNo != null ? lsByPc.get(pcNo) : undefined;
    if (l) lsPartyByAc[s.acNo] = l.winnerParty;
    return {
      acNo: s.acNo, acName: s.acName, pcNo, assemblyWinner: s.winner, assemblyParty: s.winnerParty,
      lsWinner: l?.winner ?? null, lsParty: l?.winnerParty ?? null, split: l ? l.winnerParty !== s.winnerParty : null,
    };
  });
  // The shared analytics helper decides which seats are split; the per-seat flag above must agree with it.
  const splitSet = new Set(splitSeats(asmSeats, lsPartyByAc).map(s => s.acNo));
  for (const s of seats) if (s.split !== null) s.split = splitSet.has(s.acNo);

  const mapped = seats.filter(s => s.split !== null);
  const pcNos = [...new Set(mapped.map(s => s.pcNo!))].sort((a, b) => a - b);
  const pcs: SplitPc[] = pcNos.map(pcNo => {
    const segs = mapped.filter(s => s.pcNo === pcNo);
    const acSet = new Set(segs.map(s => s.acNo));
    const wins: Record<string, number> = {};
    for (const s of segs) wins[s.assemblyParty] = (wins[s.assemblyParty] ?? 0) + 1;
    const lsRows = ls.filter(r => r.acNo === pcNo);
    return {
      pcNo, pcName: lsByPc.get(pcNo)?.acName ?? null, lsParty: lsByPc.get(pcNo)!.winnerParty, segments: segs.length,
      aligned: segs.filter(s => !s.split).length, split: segs.filter(s => s.split).length, assemblyWins: wins,
      voteShareDiff: diffShares(voteShare(asm.filter(r => acSet.has(r.acNo))), voteShare(lsRows)),
    };
  });

  const va = voteShare(asm), vl = voteShare(ls);
  const voteShareDiff: SplitReport["voteShareDiff"] = {};
  for (const p of [...new Set([...Object.keys(va), ...Object.keys(vl)])].sort()) {
    voteShareDiff[p] = { assembly: r2(va[p] ?? 0), ls: r2(vl[p] ?? 0), diff: r2((va[p] ?? 0) - (vl[p] ?? 0)) };
  }
  return {
    state, assemblyYear, lsYear: pair.lsYear, gapYears: pair.gap, sameCycle: pair.gap === 0, rule: PAIRING_RULE,
    caveat: pair.gap === 0 ? null : `The Lok Sabha election (${pair.lsYear}) was held ${pair.gap} year(s) ${pair.lsYear > assemblyYear ? "after" : "before"} the assembly election (${assemblyYear}); differences mix real split voting with change over time.`,
    totalSeats: seats.length, aligned: mapped.filter(s => !s.split).length, split: mapped.filter(s => s.split).length,
    unmapped: seats.length - mapped.length, seats, pcs, voteShareDiff,
  };
}
