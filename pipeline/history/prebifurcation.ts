import type { CandidateResult } from "../../src/lib/elections";
import type { ElectionType, StateCode } from "../../src/lib/states";
import { STATES } from "../../src/lib/states";
import { parseCsv, canonicalParty } from "../normalize";

/**
 * Pre-bifurcation history (S-116). Before 2 June 2014 Andhra Pradesh was one state. TCPD keeps those elections under
 * "Andhra_Pradesh" with the undivided numbering, which follows the 2008 delimitation order:
 *   assembly 2009: AC 1-119 are today's Telangana seats (same numbers), AC 120-294 are today's Andhra Pradesh seats (AP no = n - 119)
 *   Lok Sabha 2009 and 2014: PC 1-17 are today's Telangana seats (same numbers), PC 18-42 are Andhra Pradesh (AP no = n - 17)
 * The assembly 2014 rows are NOT rebuilt here: TCPD already publishes 2014 per successor state (and elections.json has them).
 * Mapped rows carry comparability "pre-bifurcation"; the party labels are as the source gives them (TRS shown as BRS, as elsewhere).
 */
export const UNDIVIDED_SPLIT: Record<ElectionType, { tgMax: number; apOffset: number; total: number }> = {
  assembly: { tgMax: 119, apOffset: 119, total: 294 },
  ls: { tgMax: 17, apOffset: 17, total: 42 },
};

export function splitUndivided(type: ElectionType, undividedNo: number): { state: StateCode; acNo: number } | null {
  const s = UNDIVIDED_SPLIT[type];
  if (!Number.isInteger(undividedNo) || undividedNo < 1 || undividedNo > s.total) return null;
  return undividedNo <= s.tgMax ? { state: "TG", acNo: undividedNo } : { state: "AP", acNo: undividedNo - s.apOffset };
}

const num = (v: string | undefined) => { const n = Number((v ?? "").replace(/,/g, "").trim()); return (v ?? "").trim() !== "" && Number.isFinite(n) ? n : NaN; };

/** Wanted pre-bifurcation elections (not already in elections.json). */
export const WANTED: { type: ElectionType; year: number }[] = [
  { type: "assembly", year: 2009 }, { type: "ls", year: 2009 }, { type: "ls", year: 2014 },
];

/** Normalise an undivided-AP TCPD file (AE or GE) into mapped rows for the wanted years. General round only (Poll_No 0). */
export function buildPreBifurcation(csv: string, type: ElectionType): CandidateResult[] {
  const out: CandidateResult[] = [];
  for (const r of parseCsv(csv)) {
    if ((r.State_Name ?? "").trim().toUpperCase().replace(/_/g, " ") !== "ANDHRA PRADESH") continue;
    const poll = (r.Poll_No ?? "").trim();
    if (poll !== "" && Number(poll) !== 0) continue;
    const year = num(r.Year);
    if (!WANTED.some(w => w.type === type && w.year === year)) continue;
    const und = num(r.Constituency_No), votes = num(r.Votes), position = num(r.Position), valid = num(r.Valid_Votes);
    const candidate = (r.Candidate ?? "").trim(), acName = (r.Constituency_Name ?? "").trim();
    if ([und, votes, position, valid].some(Number.isNaN) || !candidate || !acName || votes < 0 || position < 1 || valid < 0) continue;
    const m = splitUndivided(type, und);
    if (!m) continue;
    const row: CandidateResult = {
      state: m.state, year, type, acNo: m.acNo, acName, candidate, party: canonicalParty(r.Party),
      votes, position, validVotes: valid, provenance: "TCPD", comparability: "pre-bifurcation", undividedNo: und,
    };
    const electors = num(r.Electors); if (!Number.isNaN(electors) && electors > 0) row.electors = electors;
    const tp = num(r.Turnout_Percentage); if (!Number.isNaN(tp) && tp > 0 && tp <= 100) row.turnoutPct = tp;
    const sx = (r.Sex ?? "").trim().toUpperCase();
    if (sx === "M" || sx === "MALE") row.sex = "M"; else if (sx === "F" || sx === "FEMALE") row.sex = "F"; else if (sx === "O" || sx === "OTHER") row.sex = "O";
    const age = num(r.Age); if (!Number.isNaN(age) && age >= 18 && age <= 110) row.age = age;
    const inc = (r.Incumbent ?? "").trim().toUpperCase(); if (inc === "TRUE") row.incumbent = true; else if (inc === "FALSE") row.incumbent = false;
    // TCPD's own party-switch column is deliberately NOT carried (S-112: no derived turncoat labels).
    out.push(row);
  }
  return out;
}

/** Seat-count gate: every wanted election must hit the successor-state totals. Returns violations. */
export function validatePreBifurcation(rows: CandidateResult[]): string[] {
  const errs: string[] = [];
  const groups = new Map<string, Set<number>>();
  for (const r of rows) (groups.get(`${r.state}|${r.year}|${r.type}`) ?? groups.set(`${r.state}|${r.year}|${r.type}`, new Set()).get(`${r.state}|${r.year}|${r.type}`)!).add(r.acNo);
  for (const w of WANTED) for (const st of ["AP", "TG"] as const) {
    const exp = w.type === "ls" ? STATES[st].lsSeats : STATES[st].assemblySeats;
    const got = groups.get(`${st}|${w.year}|${w.type}`)?.size ?? 0;
    if (got !== exp) errs.push(`pre-bifurcation ${st} ${w.type} ${w.year}: expected ${exp} seats, got ${got}`);
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const id = `${r.state}|${r.year}|${r.type}|${r.acNo}|${r.position}|${r.candidate}`;
    if (seen.has(id)) errs.push(`duplicate: ${id}`); seen.add(id);
    if (r.votes > r.validVotes) errs.push(`votes exceed validVotes: ${id}`);
  }
  return errs;
}

/** Loose name key: first 4 letters of letters-only upper case; used only to sanity-check the numbering rule. */
export const nameKey = (s: string) => s.toUpperCase().replace(/\(.*?\)/g, "").replace(/[^A-Z]/g, "").slice(0, 4);
