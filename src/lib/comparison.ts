import type { CandidateResult } from "./elections";
import { seatResults, voteShare } from "./elections";
import type { StateCode } from "./states";

/**
 * Assembly vs Lok Sabha comparison, incumbency analytics and per-candidate cross-election views (S-117). Pure functions.
 *
 * What is and is not compared:
 *  - The dataset has Lok Sabha results per PARLIAMENTARY constituency, not per assembly segment. So a "by constituency" comparison is
 *    PC vote share (Lok Sabha) against the SUM of its assembly segments' votes (assembly), same state and year.
 *  - Elections held together (2014, 2019, 2024) share an electorate; 2009 is comparable only through the 2008-delimitation mapping.
 *  - Party names and alliances change between elections; a party that did not contest counts as 0%.
 *  - Candidates are linked across elections only by name inside the SAME seat, with an explicit confidence. No label is derived from
 *    a person's party history; TCPD's own party-switch column is never read here.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PartyCompareRow { party: string; assemblyShare: number; lsShare: number; diffPp: number; assemblySeats: number; lsSeats: number }

/** State-level party vote share, assembly vs Lok Sabha of the same year. `segments` is not needed here. */
export function partyShareCompare(assembly: CandidateResult[], ls: CandidateResult[]): PartyCompareRow[] {
  const a = voteShare(assembly), l = voteShare(ls);
  const aw = wins(assembly), lw = wins(ls);
  return [...new Set([...Object.keys(a), ...Object.keys(l)])]
    .filter(p => p !== "NOTA")
    .map(party => ({
      party, assemblyShare: r2(a[party] ?? 0), lsShare: r2(l[party] ?? 0), diffPp: r2((l[party] ?? 0) - (a[party] ?? 0)),
      assemblySeats: aw[party] ?? 0, lsSeats: lw[party] ?? 0,
    }))
    .filter(r => r.assemblyShare >= 1 || r.lsShare >= 1 || r.assemblySeats + r.lsSeats > 0)
    .sort((x, y) => Math.max(y.assemblyShare, y.lsShare) - Math.max(x.assemblyShare, x.lsShare));
}

function wins(rows: CandidateResult[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const s of seatResults(rows)) t[s.winnerParty] = (t[s.winnerParty] ?? 0) + 1;
  return t;
}

export interface PcCompareRow {
  pcNo: number; pcName: string; segments: number; segmentsWithData: number;
  lsWinnerParty: string; lsWinnerShare: number;
  /** assembly vote share of the Lok Sabha winner's party across the PC's segments (same state/year) */
  assemblyShareOfLsWinner: number; diffPp: number;
  assemblyWinnersBySegment: Record<string, number>;
  /** segments where the assembly winner's party differs from the Lok Sabha winner's party */
  splitSegments: number[];
}

/** Per-PC comparison. `acToPc` maps assembly constituency number -> PC number for the state (data/generated/lsmap/segments.json). */
export function constituencyCompare(assembly: CandidateResult[], ls: CandidateResult[], acToPc: Record<string, number>): PcCompareRow[] {
  const lsSeats = seatResults(ls);
  const asmSeats = seatResults(assembly);
  const acsByPc = new Map<number, number[]>();
  for (const [ac, pc] of Object.entries(acToPc)) (acsByPc.get(pc) ?? acsByPc.set(pc, []).get(pc)!).push(Number(ac));
  const out: PcCompareRow[] = [];
  for (const pc of lsSeats) {
    const acs = acsByPc.get(pc.acNo) ?? [];
    const asmRows = assembly.filter(r => acs.includes(r.acNo));
    const total = asmRows.reduce((s, r) => s + r.votes, 0);
    const partyVotes = asmRows.filter(r => r.party === pc.winnerParty).reduce((s, r) => s + r.votes, 0);
    const lsRows = ls.filter(r => r.acNo === pc.acNo);
    const lsTotal = lsRows.reduce((s, r) => s + r.votes, 0);
    const lsShare = lsTotal ? (lsRows.filter(r => r.party === pc.winnerParty).reduce((s, r) => s + r.votes, 0) / lsTotal) * 100 : 0;
    const asmShare = total ? (partyVotes / total) * 100 : 0;
    const segSeats = asmSeats.filter(s => acs.includes(s.acNo));
    const by: Record<string, number> = {};
    for (const s of segSeats) by[s.winnerParty] = (by[s.winnerParty] ?? 0) + 1;
    out.push({
      pcNo: pc.acNo, pcName: pc.acName, segments: acs.length, segmentsWithData: segSeats.length,
      lsWinnerParty: pc.winnerParty, lsWinnerShare: r2(lsShare), assemblyShareOfLsWinner: r2(asmShare), diffPp: r2(lsShare - asmShare),
      assemblyWinnersBySegment: by, splitSegments: segSeats.filter(s => s.winnerParty !== pc.winnerParty).map(s => s.acNo).sort((a, b) => a - b),
    });
  }
  return out.sort((a, b) => a.pcNo - b.pcNo);
}

/* ---------------- incumbency ---------------- */

export interface IncumbencySummary {
  state: StateCode; year: number; type: "assembly" | "ls";
  /** share of candidate rows with the incumbent flag set to true or false */
  flagCoveragePct: number; available: boolean; reason?: string;
  incumbentsContesting: number; incumbentsWon: number; winRatePct: number | null;
  nonIncumbentWinRatePct: number | null;
  byParty: { party: string; contesting: number; won: number; winRatePct: number }[];
  /** seats where the party that won the previous election in that seat won again (needs no incumbent flag) */
  seatRetention: { previousYear: number; seats: number; retained: number; retainedPct: number } | null;
  /** matched same-seat, same-name incumbents: change in vote share vs their own previous contest, percentage points */
  swingVsIncumbent: { matched: number; meanPp: number | null; medianPp: number | null; previousYear: number } | null;
}

const NOTA = "NOTA";
const nameKey = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean).join(" ");
const tokenKey = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(t => t.length > 1).sort().join(" ");

function shareMap(rows: CandidateResult[]): Map<string, number> {
  const valid = new Map<number, number>();
  for (const r of rows) valid.set(r.acNo, r.validVotes || (valid.get(r.acNo) ?? 0) + r.votes);
  const out = new Map<string, number>();
  for (const r of rows) if (r.party !== NOTA) out.set(`${r.acNo}|${nameKey(r.candidate)}`, valid.get(r.acNo) ? (r.votes / valid.get(r.acNo)!) * 100 : 0);
  return out;
}

export function incumbencySummary(all: CandidateResult[], state: StateCode, year: number, type: "assembly" | "ls"): IncumbencySummary | null {
  const rows = all.filter(r => r.state === state && r.year === year && r.type === type && r.party !== NOTA);
  if (!rows.length) return null;
  const flagged = rows.filter(r => r.incumbent !== undefined);
  const coverage = r2((flagged.length / rows.length) * 100);
  const available = coverage >= 90;
  const inc = flagged.filter(r => r.incumbent === true), non = flagged.filter(r => r.incumbent === false);
  const years = [...new Set(all.filter(r => r.state === state && r.type === type && r.year < year).map(r => r.year))].sort((a, b) => b - a);
  const prevYear = years[0];
  let seatRetention: IncumbencySummary["seatRetention"] = null;
  let swingVs: IncumbencySummary["swingVsIncumbent"] = null;
  if (prevYear !== undefined) {
    const prev = all.filter(r => r.state === state && r.year === prevYear && r.type === type);
    const prevWinner = new Map(seatResults(prev).map(s => [s.acNo, s.winnerParty]));
    const cur = seatResults(all.filter(r => r.state === state && r.year === year && r.type === type));
    const both = cur.filter(s => prevWinner.has(s.acNo));
    const kept = both.filter(s => prevWinner.get(s.acNo) === s.winnerParty).length;
    seatRetention = { previousYear: prevYear, seats: both.length, retained: kept, retainedPct: both.length ? r2((kept / both.length) * 100) : 0 };
    if (available) {
      const before = shareMap(prev), now = shareMap(rows);
      const deltas: number[] = [];
      for (const r of inc) {
        const k = `${r.acNo}|${nameKey(r.candidate)}`;
        if (before.has(k) && now.has(k)) deltas.push(now.get(k)! - before.get(k)!);
      }
      deltas.sort((a, b) => a - b);
      const mid = deltas.length ? (deltas.length % 2 ? deltas[(deltas.length - 1) / 2] : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2) : null;
      swingVs = { matched: deltas.length, meanPp: deltas.length ? r2(deltas.reduce((s, d) => s + d, 0) / deltas.length) : null, medianPp: mid === null ? null : r2(mid), previousYear: prevYear };
    }
  }
  const byPartyMap = new Map<string, { c: number; w: number }>();
  for (const r of inc) { const o = byPartyMap.get(r.party) ?? byPartyMap.set(r.party, { c: 0, w: 0 }).get(r.party)!; o.c++; if (r.position === 1) o.w++; }
  const won = inc.filter(r => r.position === 1).length;
  return {
    state, year, type, flagCoveragePct: coverage, available,
    ...(available ? {} : { reason: `The source file for this election does not carry an incumbent flag for ${coverage}% of its candidates, so re-contest win rates are not shown. Seat retention (needs no flag) is still shown.` }),
    incumbentsContesting: available ? inc.length : 0, incumbentsWon: available ? won : 0,
    winRatePct: available && inc.length ? r2((won / inc.length) * 100) : null,
    nonIncumbentWinRatePct: available && non.length ? r2((non.filter(r => r.position === 1).length / non.length) * 100) : null,
    byParty: available ? [...byPartyMap].map(([party, o]) => ({ party, contesting: o.c, won: o.w, winRatePct: r2((o.w / o.c) * 100) })).sort((a, b) => b.contesting - a.contesting || a.party.localeCompare(b.party)) : [],
    seatRetention, swingVsIncumbent: swingVs,
  };
}

/* ---------------- per-candidate cross-election view ---------------- */

export type MatchConfidence = "high" | "medium";
export interface CandidateAppearance { year: number; type: "assembly" | "ls"; party: string; votes: number; sharePct: number; won: boolean; name: string; undivided?: boolean }
export interface CandidateTrail {
  state: StateCode; type: "assembly" | "ls"; acNo: number; acName: string;
  name: string; match: { confidence: MatchConfidence; basis: string };
  appearances: CandidateAppearance[];
}

export const TRAIL_NOTE = "Each trail links rows that share a constituency and a name. 'high' = identical name; 'medium' = same words in a different order or with different initials, which could be a different person. Party shown is the party at that election, as recorded. Nothing here is a judgement about a person.";

/**
 * Trails for candidates that appear in the same seat in two or more elections of the same type. Alphabetical, never ranked.
 * Pass `query` (case-insensitive, at least 2 letters) to restrict to names containing it.
 */
export function candidateTrails(all: CandidateResult[], state: StateCode, type: "assembly" | "ls", query?: string, limit = 200): CandidateTrail[] {
  const rows = all.filter(r => r.state === state && r.type === type && r.party !== NOTA);
  const q = query?.trim().toUpperCase();
  const validOf = new Map<string, number>();
  for (const r of rows) validOf.set(`${r.year}|${r.acNo}`, r.validVotes);
  const groups = new Map<string, CandidateResult[]>();
  for (const r of rows) {
    const k = `${r.acNo}|${tokenKey(r.candidate)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: CandidateTrail[] = [];
  for (const list of groups.values()) {
    const years = new Set(list.map(r => r.year));
    if (years.size < 2) continue;
    if (q && !list.some(r => r.candidate.toUpperCase().includes(q))) continue;
    // one row per year (a person cannot appear twice in a seat in the same election)
    const byYear = new Map<number, CandidateResult>();
    for (const r of list) if (!byYear.has(r.year)) byYear.set(r.year, r);
    const apps = [...byYear.values()].sort((a, b) => a.year - b.year);
    const exact = new Set(apps.map(r => nameKey(r.candidate))).size === 1;
    const first = apps[apps.length - 1];
    out.push({
      state, type, acNo: first.acNo, acName: first.acName, name: first.candidate,
      match: exact ? { confidence: "high", basis: "identical name in the same constituency" } : { confidence: "medium", basis: "same words in a different order or with different initials, same constituency" },
      appearances: apps.map(r => ({
        year: r.year, type, party: r.party, votes: r.votes, name: r.candidate, won: r.position === 1,
        sharePct: validOf.get(`${r.year}|${r.acNo}`) ? r2((r.votes / validOf.get(`${r.year}|${r.acNo}`)!) * 100) : 0,
        ...(r.comparability ? { undivided: true } : {}),
      })),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.acNo - b.acNo).slice(0, limit);
}
