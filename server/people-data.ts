/**
 * People data layer (S-104..S-114): pure builders over elections.json + the hand-kept reference files.
 * Every public shape is FIXED (same keys for every candidate / party) so no page can rank or single anyone out (MCC neutrality).
 * Nothing here reads the takedown table: the router passes a `hidden(kind,key)` predicate so takedowns apply immediately.
 */
import fs from "node:fs";
import path from "node:path";
import type { CandidateResult } from "../src/lib/elections";
import { filterElection, seatResults, seatTally, voteShare } from "../src/lib/elections";
import { ALLIANCE_RECORDS } from "../src/lib/states";
import type { ElectionType, StateCode } from "../src/lib/states";
import { OTHERS, PARTIES, registryAsOf, resolveParty } from "../src/lib/parties";

export type Hidden = (kind: "photo" | "field" | "office-holder", key: string) => boolean;
const never: Hidden = () => false;

function readJson<T>(baseDir: string, rel: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path.join(baseDir, rel), "utf8")) as T; } catch { return fallback; }
}

export interface OfficeHolder {
  id: string; state: StateCode; role: string; person: string; party: string; start: string;
  sources: string[]; wikidata: string | null; asOf: string; confidence: "high" | "medium" | "low" | "unverified";
}
export interface OverlayRecord {
  id: string; state: StateCode; type: ElectionType; acNo: number; kind: "vacancy" | "by-election" | "defection"; status: "confirmed" | "reported";
  date: string; member: { name: string; party: string } | null; previous?: { name: string; party: string }; note: string; sources: string[];
}
interface PhotoEntry { name: string; party: string; path?: string; author: string; licence: string; licenceUrl: string | null; source: string; file: string; wikidata: string; attributionRequired: boolean }
interface PartyMediaEntry {
  code: string; kind: "flag" | "symbol"; path: string; sha256: string; author: string; licence: string; licenceUrl: string | null; source: string;
  use: "decorative" | "identification-only"; restrictions: string | null; verified: string;
}

export interface PeopleStore {
  officeHolders: OfficeHolder[];
  overlay: OverlayRecord[];
  photos: Record<string, PhotoEntry>;
  partyMedia: Record<string, PartyMediaEntry>;
  asOf: { officeHolders: string; overlay: string; photos: string | null };
}

export function loadPeopleStore(baseDir: string = process.cwd()): PeopleStore {
  const oh = readJson<{ asOf: string; records: OfficeHolder[] }>(baseDir, "data/reference/people/office-holders.json", { asOf: "", records: [] });
  const ov = readJson<{ asOf: string; records: OverlayRecord[] }>(baseDir, "data/reference/people/members-overlay.json", { asOf: "", records: [] });
  const ph = readJson<{ asOf: string | null; entries: Record<string, PhotoEntry> }>(baseDir, "data/reference/people/photos.json", { asOf: null, entries: {} });
  const pm = readJson<{ entries: Record<string, PartyMediaEntry> }>(baseDir, "data/reference/people/party-media.json", { entries: {} });
  return {
    officeHolders: oh.records, overlay: ov.records, photos: ph.entries, partyMedia: pm.entries,
    asOf: { officeHolders: oh.asOf, overlay: ov.asOf, photos: ph.asOf },
  };
}

/* ---------------- shared small shapes ---------------- */

export interface PartyRef { code: string; name: string; nameTe: string | null; color: string }
export function partyRef(raw: string): PartyRef {
  const p = resolveParty(raw);
  if (p === OTHERS) return { code: raw || "OTH", name: raw || OTHERS.name.en, nameTe: null, color: OTHERS.color };
  return { code: p.code, name: p.name.en, nameTe: p.name.te, color: p.color };
}

export const initials = (name: string) => name.replace(/[^A-Za-z\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a, b) => a + b.toUpperCase()) : s);
export const displayName = (s: string) => titleCase(s);

export function latestYear(rows: CandidateResult[], state: StateCode, type: ElectionType): number | undefined {
  const ys = rows.filter(r => r.state === state && r.type === type).map(r => r.year);
  return ys.length ? Math.max(...ys) : undefined;
}

/* ---------------- photo with takedown ---------------- */

export interface PhotoOut { src: string; author: string; licence: string; licenceUrl: string | null; source: string; attributionRequired: boolean }
export function photoFor(store: PeopleStore, state: StateCode, type: ElectionType, acNo: number, memberName: string, hidden: Hidden): PhotoOut | null {
  const key = `${state}-${type}-${acNo}`;
  const e = store.photos[key];
  if (!e || !e.path || hidden("photo", key)) return null;
  // the photo belongs to the person it was matched to; a changed member (by-election) never inherits it
  if (e.name.trim().toLowerCase() !== memberName.trim().toLowerCase()) return null;
  return { src: e.path, author: e.author, licence: e.licence, licenceUrl: e.licenceUrl, source: e.source, attributionRequired: e.attributionRequired };
}

/* ---------------- members (S-108) ---------------- */

export interface MemberNote { kind: string; status: "confirmed" | "reported"; date: string; note: string; sources: string[] }
export interface MemberRow {
  state: StateCode; type: ElectionType; acNo: number; acName: string; district: string | null;
  member: { name: string; party: PartyRef; initials: string; basis: "election" | "overlay"; electionYear: number; since: string | null } | null;
  vacant: boolean; photo: PhotoOut | null; notes: MemberNote[];
}

const ymd = (d: string) => (d.length === 4 ? d + "-01-01" : d.length === 7 ? d + "-01" : d);

export function buildMembers(rows: CandidateResult[], store: PeopleStore, state: StateCode, type: ElectionType, hidden: Hidden = never): { year: number; members: MemberRow[] } | null {
  const year = type === "assembly" ? latestYear(rows, state, "assembly") : latestYear(rows, state, "ls");
  if (year === undefined) return null;
  const el = filterElection(rows, state, year, type);
  if (!el.length) return null;
  const seats = seatResults(el).sort((a, b) => a.acNo - b.acNo);
  const winners = new Map(el.filter(r => r.position === 1).map(r => [r.acNo, r]));
  const members: MemberRow[] = seats.map(s => {
    const w = winners.get(s.acNo);
    let member: MemberRow["member"] = w ? {
      name: displayName(w.candidate), party: partyRef(w.party), initials: initials(w.candidate), basis: "election", electionYear: year, since: null,
    } : null;
    let vacant = false;
    const notes: MemberNote[] = [];
    const ov = store.overlay.filter(o => o.state === state && o.type === type && o.acNo === s.acNo).sort((a, b) => ymd(a.date).localeCompare(ymd(b.date)));
    for (const o of ov) {
      notes.push({ kind: o.kind, status: o.status, date: o.date, note: o.note, sources: o.sources });
      if (o.status !== "confirmed") continue; // reported changes are shown as notes, never applied
      if (o.member) { member = { name: displayName(o.member.name), party: partyRef(o.member.party), initials: initials(o.member.name), basis: "overlay", electionYear: year, since: o.date }; vacant = false; }
      else { member = null; vacant = true; }
    }
    return {
      state, type, acNo: s.acNo, acName: s.acName, district: w?.district ?? null, member, vacant, notes,
      photo: member ? photoFor(store, state, type, s.acNo, member.name, hidden) : null,
    };
  });
  return { year, members };
}

/* ---------------- contestants (S-109) ---------------- */

export const contestantId = (r: Pick<CandidateResult, "state" | "type" | "year" | "acNo" | "position">) => `${r.state}-${r.type}-${r.year}-${r.acNo}-${r.position}`;
export function parseContestantId(id: string): { state: StateCode; type: ElectionType; year: number; acNo: number; position: number } | null {
  const m = /^(AP|TG)-(assembly|ls)-(\d{4})-(\d{1,3})-(\d{1,3})$/.exec(id);
  return m ? { state: m[1] as StateCode, type: m[2] as ElectionType, year: Number(m[3]), acNo: Number(m[4]), position: Number(m[5]) } : null;
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Affidavit sources are LINK-ONLY: URL construction from the candidate name, nothing fetched or stored (docs/decisions/02-affidavit-link-outs.md).
 * Identical two links, same order, same wording for every candidate (MCC neutrality).
 */
export function affidavitLinks(name: string) {
  return [
    { label: "MyNeta (Association for Democratic Reforms): search by name", labelTe: "MyNeta (అసోసియేషన్ ఫర్ డెమోక్రటిక్ రిఫార్మ్స్): పేరుతో వెతకండి", url: `https://www.myneta.info/search_myneta.php?q=${encodeURIComponent(name)}`, verified: "2026-11-22", external: true as const },
    { label: "Election Commission of India: candidate affidavits portal", labelTe: "భారత ఎన్నికల సంఘం: అభ్యర్థుల అఫిడవిట్ల పోర్టల్", url: "https://affidavit.eci.gov.in/", verified: null, external: true as const },
  ];
}

export interface ContestantRecord {
  id: string; state: StateCode; type: ElectionType; year: number; acNo: number; acName: string; district: string | null;
  position: number; votes: number; voteSharePct: number | null; marginVotes: number | null; won: boolean;
}
export interface ContestantProfile {
  id: string; name: string; initials: string; party: PartyRef;
  record: ContestantRecord;
  attributes: { sex: "M" | "F" | "O" | null; age: number | null; incumbent: boolean | null };
  otherElections: ContestantRecord[];
  links: ReturnType<typeof affidavitLinks>;
  source: { provenance: string | null; attribution: string };
}

function record(row: CandidateResult, seatRows: CandidateResult[]): ContestantRecord {
  const sorted = [...seatRows].sort((a, b) => a.position - b.position);
  const winner = sorted[0], second = sorted[1];
  return {
    id: contestantId(row), state: row.state, type: row.type, year: row.year, acNo: row.acNo, acName: row.acName, district: row.district ?? null,
    position: row.position, votes: row.votes,
    voteSharePct: row.validVotes > 0 ? Math.round((row.votes / row.validVotes) * 10000) / 100 : null,
    // margin: winner's lead over the runner-up; for others, the votes behind the winner (negative). Same definition for everyone.
    marginVotes: row.position === 1 ? (second ? row.votes - second.votes : null) : winner ? row.votes - winner.votes : null,
    won: row.position === 1,
  };
}

export function buildContestant(rows: CandidateResult[], id: string, hidden: Hidden = never): ContestantProfile | null {
  const p = parseContestantId(id);
  if (!p) return null;
  const seat = rows.filter(r => r.state === p.state && r.type === p.type && r.year === p.year && r.acNo === p.acNo);
  const row = seat.find(r => r.position === p.position);
  if (!row) return null;
  const k = nameKey(row.candidate);
  // Other contests: same state/type, same seat number, same name. Name+seat match only; never claims identity beyond that.
  const others: ContestantRecord[] = [];
  for (const r of rows) {
    if (r === row || r.state !== p.state || r.type !== p.type || r.acNo !== p.acNo || nameKey(r.candidate) !== k) continue;
    others.push(record(r, rows.filter(x => x.state === r.state && x.type === r.type && x.year === r.year && x.acNo === r.acNo)));
  }
  others.sort((a, b) => a.year - b.year);
  const fieldOk = (f: string) => !hidden("field", `${id}#${f}`);
  return {
    id, name: displayName(row.candidate), initials: initials(row.candidate), party: partyRef(row.party),
    record: record(row, seat),
    attributes: {
      sex: fieldOk("sex") ? row.sex ?? null : null,
      age: fieldOk("age") ? row.age ?? null : null,
      incumbent: fieldOk("incumbent") ? row.incumbent ?? null : null,
    },
    otherElections: others,
    links: affidavitLinks(displayName(row.candidate)),
    source: { provenance: row.provenance ?? null, attribution: "Trivedi Centre for Political Data (TCPD), Ashoka University, Lok Dhaba; Election Commission of India." },
  };
}

export interface ContestantHit { id: string; name: string; party: PartyRef; state: StateCode; type: ElectionType; year: number; acNo: number; acName: string; position: number }
/** Name search: alphabetical by name then year (never by votes, wealth or cases). */
export function searchContestants(rows: CandidateResult[], q: string, filt: { state?: StateCode; type?: ElectionType; year?: number }, limit = 50): ContestantHit[] {
  const k = nameKey(q);
  if (k.length < 2) return [];
  const hits = rows.filter(r => (!filt.state || r.state === filt.state) && (!filt.type || r.type === filt.type) && (!filt.year || r.year === filt.year) && nameKey(r.candidate).includes(k));
  hits.sort((a, b) => a.candidate.localeCompare(b.candidate) || a.year - b.year || a.acNo - b.acNo);
  return hits.slice(0, limit).map(r => ({
    id: contestantId(r), name: displayName(r.candidate), party: partyRef(r.party), state: r.state, type: r.type, year: r.year, acNo: r.acNo, acName: r.acName, position: r.position,
  }));
}

/* ---------------- parties (S-106) ---------------- */

export interface PartyListItem { code: string; name: string; nameTe: string | null; color: string }
export function listParties(): PartyListItem[] {
  return Object.values(PARTIES).filter(p => p.code !== "IND" && p.code !== "NOTA").map(p => ({ code: p.code, name: p.name.en, nameTe: p.name.te, color: p.color })).sort((a, b) => a.code.localeCompare(b.code));
}

export interface PartyElectionRow {
  state: StateCode; type: ElectionType; year: number; contested: number; seatsWon: number; totalSeats: number; voteSharePct: number | null;
  alliances: { name: string; kind: "pre-poll" | "post-hoc"; confidence: string; kindLabel: string; sources: string[] }[];
}

export function buildPartyProfile(rows: CandidateResult[], store: PeopleStore, rawCode: string, hidden: Hidden = never) {
  const party = resolveParty(rawCode);
  if (party === OTHERS) return null;
  const code = party.code;
  const elections: PartyElectionRow[] = [];
  const keys = new Set(rows.map(r => `${r.state}|${r.type}|${r.year}`));
  for (const k of [...keys].sort()) {
    const [state, type, yearS] = k.split("|");
    const year = Number(yearS);
    const el = filterElection(rows, state as StateCode, year, type as ElectionType);
    if (!el.length) continue;
    const mine = el.filter(r => r.party === code);
    if (!mine.length) continue;
    const seats = seatResults(el);
    const tally = seatTally(seats);
    const share = voteShare(el)[code];
    const rec = ALLIANCE_RECORDS[`${state}-${year}-${type}`];
    const alliances = (rec?.groups ?? []).filter(g => g.parties.includes(code)).map(g => ({
      name: g.name, kind: g.kind, confidence: g.confidence, sources: g.sources,
      kindLabel: g.kind === "pre-poll" ? "announced before polling" : "grouped in hindsight (analysis, not an alliance at the time)",
    }));
    elections.push({
      state: state as StateCode, type: type as ElectionType, year, contested: new Set(mine.map(r => r.acNo)).size,
      seatsWon: tally[code] ?? 0, totalSeats: seats.length, voteSharePct: share === undefined ? null : Math.round(share * 100) / 100, alliances,
    });
  }
  const leaders = store.officeHolders.filter(o => o.party === code && !hidden("office-holder", o.id));
  const media = (kind: "flag" | "symbol") => store.partyMedia[`${code}-${kind}`] ?? null;
  const founded = party.history.find(h => h.event.toLowerCase().includes("found") || h.event.toLowerCase().includes("launch"));
  return {
    code, name: party.name, color: party.color, website: party.website,
    wikidata: party.wikidata ? { qid: party.wikidata, url: `https://www.wikidata.org/wiki/${party.wikidata}` } : null,
    founded: party.foundedYear === null ? null : { year: party.foundedYear, confidence: founded ? (founded.verified ? "verified" : "unverified") : "unverified", event: founded?.event ?? null },
    flag: media("flag"), symbol: media("symbol"),
    elections, leaders,
    sources: [
      { name: "TCPD Lok Dhaba / ECI results (elections.json)", url: "https://lokdhaba.ashoka.edu.in/" },
      { name: "Alliance records (English Wikipedia election pages)", url: "https://en.wikipedia.org/wiki/Elections_in_Andhra_Pradesh" },
      { name: "Party registry (hand-curated; Wikidata QIDs and labels)", url: party.wikidata ? `https://www.wikidata.org/wiki/${party.wikidata}` : "https://www.wikidata.org/" },
    ],
    registryAsOf, officeHoldersAsOf: store.asOf.officeHolders,
  };
}

/** Fixed section list for every candidate and party page: the neutrality test asserts these never vary. */
export const CANDIDATE_SECTIONS = ["identity", "record", "attributes", "otherElections", "links", "source"] as const;
export const PARTY_SECTIONS = ["identity", "media", "elections", "leaders", "sources"] as const;
