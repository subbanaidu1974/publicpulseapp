import type { CandidateResult } from "../../src/lib/elections";
import type { ElectionType, StateCode } from "../../src/lib/states";
import { canonicalParty as canon, parseCsv } from "../normalize";

/** Older TCPD files use these party strings; mapped here rather than in the shared normaliser. */
const LOCAL_ALIAS: Record<string, string> = { TD: "TDP", "Y.S.R. (CP)": "YSRCP", "YSR(CP)": "YSRCP" };
const canonicalParty = (p: string) => LOCAL_ALIAS[(p ?? "").trim()] ?? canon(p);

/**
 * By-election and re-poll records (S-115), schema data/reference/history/byelections.json.
 * Built from TCPD / ECI (in-rolls) rows whose Poll_No is not 0. Only post-bifurcation polls (2014 onward) are kept: earlier
 * ones belong to undivided Andhra Pradesh and have no clean AP/TG seat. The seat is resolved by NAME against the general-election
 * seat list (source numbering is inconsistent between files), and the source number is kept as `sourceNo`.
 */
export interface ByElectionRecord {
  id: string;
  state: StateCode;
  type: ElectionType;
  acNo: number;
  seat: string;
  /** YYYY-MM when the source gives the month, otherwise YYYY. Poll and count dates are not in the sources. */
  date: string;
  kind: "by-election" | "re-poll";
  /** Why the seat fell vacant. null = not stated by the sources we read (never guessed). */
  cause: string | null;
  winner: string;
  party: string;
  margin: number;
  marginPct: number | null;
  validVotes: number;
  electors: number | null;
  turnoutPct: number | null;
  candidates: number;
  sourceNo: number;
  /** Only one candidate stood: no poll was held and the vote count is zero in the source. */
  uncontested?: boolean;
  sources: string[];
  /** true only when the result was cross-checked against a second independent source (see `crossCheck`). */
  verified: boolean;
  crossCheck?: string;
}

const nm = (s: string) => s.toUpperCase().replace(/\(.*?\)/g, "").replace(/[^A-Z]/g, "");
const num = (v: string | undefined) => { const n = Number((v ?? "").replace(/,/g, "").trim()); return (v ?? "").trim() !== "" && Number.isFinite(n) ? n : NaN; };

export interface SeatIndex { get(state: StateCode, type: ElectionType): { acNo: number; key: string }[] }

/** One entry per (seat, spelling): LS names differ between years (THIRUPATHI / TIRUPATI), so every spelling seen is indexed. */
export function seatIndexFrom(rows: Pick<CandidateResult, "state" | "type" | "acNo" | "acName">[]): SeatIndex {
  const m = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const k = `${r.state}|${r.type}`;
    (m.get(k) ?? m.set(k, new Map()).get(k)!).set(`${r.acNo}|${nm(r.acName)}`, r.acNo);
  }
  return { get: (state, type) => [...(m.get(`${state}|${type}`) ?? [])].map(([k, acNo]) => ({ acNo, key: k.split("|")[1] })) };
}

/** Resolve a (state, seat name) from a source row; both states are tried because TCPD files AP and TG polls together after 2014. */
export function resolveSeat(idx: SeatIndex, type: ElectionType, name: string): { state: StateCode; acNo: number; key: string } | null {
  const k = nm(name);
  if (k.length < 3) return null;
  const exact: { state: StateCode; acNo: number; key: string }[] = [];
  const near: { state: StateCode; acNo: number; key: string }[] = [];
  for (const state of ["AP", "TG"] as const) {
    for (const s of idx.get(state, type)) {
      if (s.key === k) exact.push({ state, ...s });
      // spelling variants (SECUNDRABAD / SECUNDERABAD, NAGARJUNA SAGAR / NAGARJUNASAGAR, CANTT. / CANTONMENT): shared 8-letter prefix
      else if (k.length >= 8 && s.key.length >= 8 && s.key.slice(0, 8) === k.slice(0, 8)) near.push({ state, ...s });
    }
  }
  const uniq = (l: typeof exact) => [...new Map(l.map(h => [`${h.state}${h.acNo}`, h])).values()];
  const hits = uniq(exact.length ? exact : near);
  return hits.length === 1 ? hits[0] : null; // ambiguous or unknown: never guess
}

const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

export function buildByElections(
  inputs: { csv: string; type: ElectionType; source: string }[], idx: SeatIndex, minYear = 2014,
): { records: ByElectionRecord[]; skipped: string[] } {
  const records: ByElectionRecord[] = [];
  const skipped: string[] = [];
  const seenRec = new Set<string>();
  for (const { csv, type, source } of inputs) {
    const groups = new Map<string, Record<string, string>[]>();
    const seenRow = new Set<string>();
    for (const r of parseCsv(csv)) {
      const sn = (r.State_Name ?? "").trim().toUpperCase().replace(/_/g, " ");
      if (sn !== "ANDHRA PRADESH" && sn !== "TELANGANA") continue;
      const poll = num(r.Poll_No);
      const year = num(r.Year);
      if (!(poll > 0) || !(year >= minYear)) continue;
      const rk = [sn, year, poll, r.Constituency_No, r.Position, r.Candidate].join("|");
      if (seenRow.has(rk)) continue; // the in-rolls by-election file repeats some rows
      seenRow.add(rk);
      const gk = [sn, year, poll, r.Constituency_No, r.Constituency_Name].join("|");
      (groups.get(gk) ?? groups.set(gk, []).get(gk)!).push(r);
    }
    for (const [gk, list] of groups) {
      const first = list[0];
      const year = num(first.Year), poll = num(first.Poll_No), sourceNo = num(first.Constituency_No);
      const seatName = (first.Constituency_Name ?? "").trim();
      const seat = resolveSeat(idx, type, seatName);
      if (!seat) { skipped.push(`${gk} (seat not resolved)`); continue; }
      const sorted = [...list].sort((a, b) => num(a.Position) - num(b.Position));
      const w = sorted[0];
      if (num(w.Position) !== 1) { skipped.push(`${gk} (no winner row)`); continue; }
      const valid = num(w.Valid_Votes), votes = num(w.Votes);
      const ru = sorted[1];
      const margin = ru ? Math.max(0, votes - num(ru.Votes)) : votes;
      const month = num(first.month);
      const date = month >= 1 && month <= 12 ? `${year}-${MONTHS[month - 1]}` : String(year);
      const id = `${seat.state}-${type}-${seat.acNo}-${date}${poll > 1 ? `-repoll${poll}` : ""}`;
      if (seenRec.has(id)) continue; // same poll present in two files
      seenRec.add(id);
      const electors = num(w.Electors), turn = num(w.Turnout_Percentage);
      records.push({
        id, state: seat.state, type, acNo: seat.acNo, seat: seatName.replace(/\s*\(.*?\)\s*$/, "").trim(),
        date, kind: poll > 1 ? "re-poll" : "by-election", cause: null,
        winner: (w.Candidate ?? "").trim(), party: canonicalParty(w.Party),
        margin, marginPct: valid > 0 ? Math.round((margin / valid) * 10000) / 100 : null, validVotes: Number.isNaN(valid) ? 0 : valid,
        electors: electors > 0 ? electors : null, turnoutPct: turn > 0 ? turn : null,
        candidates: sorted.filter(c => canonicalParty(c.Party) !== "NOTA").length, sourceNo, ...(sorted.length === 1 ? { uncontested: true } : {}), sources: [source], verified: false,
      });
    }
  }
  records.sort((a, b) => a.date.localeCompare(b.date) || a.state.localeCompare(b.state) || a.acNo - b.acNo);
  return { records, skipped };
}
