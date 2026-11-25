import type { CandidateResult } from "./elections";
import { seatResults } from "./elections";
import { PARTIES, registryCode } from "./parties";
import type { ElectionType, StateCode } from "./states";

/**
 * Party-by-party results across the elections in the dataset (S-195). Pure function over the results already held: nothing is added from
 * outside, and nothing is said about a party beyond what its results and the reviewed party registry (data/reference/parties.json) show.
 * Raw party labels are merged through the registry's aliases, so a renamed or re-spelled label counts once. A party that did not stand in an
 * election has no row for it (not a zero). Shares are of all votes polled in that election, NOTA included, the same basis as the Elections page.
 */
export interface PartyElectionRow { year: number; type: ElectionType; seats: number; contested: number; votes: number; sharePct: number }
export interface PartyHistoryEntry {
  code: string;
  /** In the party registry (name, founding year, website are then shown); false for minor labels kept under their own code. */
  registered: boolean;
  name: { en: string; te: string | null };
  foundedYear: number | null;
  website: string | null;
  rows: PartyElectionRow[];
  totalSeats: number;
}
export interface PartyHistory {
  state: StateCode;
  elections: { year: number; type: ElectionType; seats: number; totalVotes: number }[];
  parties: PartyHistoryEntry[];
  /** Parties left out of the list: they won no seat and never reached MIN_SHARE_PCT of the vote. */
  omitted: number;
}

/** A party is listed when it won a seat, or took at least this share of the vote, in any election. */
export const MIN_SHARE_PCT = 1;
const r2 = (n: number) => Math.round(n * 100) / 100;
export const NOT_A_PARTY = new Set(["NOTA"]);

export function partyHistory(all: CandidateResult[], state: StateCode): PartyHistory {
  const rows = all.filter(r => r.state === state);
  const keys = [...new Set(rows.map(r => `${r.year}|${r.type}`))].map(k => { const [y, t] = k.split("|"); return { year: Number(y), type: t as ElectionType }; })
    .sort((a, b) => a.year - b.year || a.type.localeCompare(b.type));
  const canon = (raw: string) => registryCode(raw) ?? raw.trim();
  const by = new Map<string, PartyElectionRow[]>();
  const elections: PartyHistory["elections"] = [];
  for (const k of keys) {
    const er = rows.filter(r => r.year === k.year && r.type === k.type);
    const totalVotes = er.reduce((s, r) => s + r.votes, 0);
    const wins = new Map<string, number>();
    for (const s of seatResults(er)) { const c = canon(s.winnerParty); wins.set(c, (wins.get(c) ?? 0) + 1); }
    const votes = new Map<string, number>(), contested = new Map<string, number>();
    for (const r of er) { const c = canon(r.party); votes.set(c, (votes.get(c) ?? 0) + r.votes); contested.set(c, (contested.get(c) ?? 0) + 1); }
    elections.push({ year: k.year, type: k.type, seats: new Set(er.map(r => r.acNo)).size, totalVotes });
    for (const [c, v] of votes) {
      if (NOT_A_PARTY.has(c)) continue;
      const list = by.get(c) ?? by.set(c, []).get(c)!;
      list.push({ year: k.year, type: k.type, seats: wins.get(c) ?? 0, contested: contested.get(c) ?? 0, votes: v, sharePct: totalVotes ? r2((v / totalVotes) * 100) : 0 });
    }
  }
  const parties: PartyHistoryEntry[] = [];
  let omitted = 0;
  for (const [code, list] of by) {
    if (!list.some(r => r.seats > 0 || r.sharePct >= MIN_SHARE_PCT)) { omitted++; continue; }
    const reg = PARTIES[code];
    parties.push({
      code, registered: !!reg, name: reg ? { en: reg.name.en, te: reg.name.te } : { en: code, te: null },
      foundedYear: reg?.foundedYear ?? null, website: reg?.website ?? null,
      rows: list.sort((a, b) => a.year - b.year || a.type.localeCompare(b.type)), totalSeats: list.reduce((s, r) => s + r.seats, 0),
    });
  }
  parties.sort((a, b) => b.totalSeats - a.totalSeats || a.code.localeCompare(b.code));
  return { state, elections, parties, omitted };
}
