/**
 * Panchayat elections (S-203, widened in S-219): the data format, its checks and the loader. Files live at data/reference/panchayat/results-<ST>.json.
 * An election carries either unit-level rows (`units`, from an approved commission source; none loaded yet) or party totals (`tallies`, from a
 * secondary source such as English Wikipedia, with the page and revision it was read from). We do not hold or accept electoral-roll or voter-level data.
 */
import type { StateCode } from "./states";

export const PANCHAYAT_LEVELS = ["gp", "mptc", "zptc"] as const;
export type PanchayatLevel = (typeof PANCHAYAT_LEVELS)[number];

export interface PanchayatUnit {
  lgdCode?: string; name: string; district: string; mandal?: string;
  posts: number; contested?: number; unopposed?: boolean; turnoutPct?: number;
  winner?: { name: string; partyBacked?: string };
}
export interface PanchayatTally { party: string; won: number; byPhase?: (number | null)[] }
export interface PanchayatPhase { date: string; gps?: number; turnoutPct?: number }
export interface PanchayatElection {
  id: string; level: PanchayatLevel; year: number;
  /** "YYYY" or "YYYY-MM" when exact dates are not in the source. */
  period: string;
  phases?: PanchayatPhase[];
  /** Region the figures cover when it is not the whole state, e.g. the Telangana districts of undivided Andhra Pradesh. */
  scope?: string;
  /** Posts (seats) up for election, as the source states it. */
  totalPosts?: number;
  tallies?: PanchayatTally[];
  units?: PanchayatUnit[];
  evidence?: { url: string; revision: string; cites: string };
  /** Plain-language limits of these figures: gaps, disagreements inside the source, what is not covered. */
  caveats?: string[];
}
export interface PanchayatSource { publisher: string; url: string; licence: string; terms: string; retrieved: string; quality: "commission" | "secondary" }
export interface PanchayatFile { state: StateCode; source: PanchayatSource; elections: PanchayatElection[] }
export interface PanchayatSummary {
  id: string; level: PanchayatLevel; year: number; period: string; scope: string | null;
  units: number | null; posts: number | null; tallies: PanchayatTally[]; phases: PanchayatPhase[]; evidence: PanchayatElection["evidence"] | null; caveats: string[];
}
export interface PanchayatResponse {
  state: StateCode; loaded: boolean; granularity: "none" | "totals" | "units"; levels: readonly PanchayatLevel[];
  elections: PanchayatSummary[]; source: PanchayatSource | null; problems: string[]; notes: string[];
}

/** Keys that would mean voter-level or electoral-roll data; any file containing one is refused. */
const FORBIDDEN_KEY = /voter|epic|elector|roll|aadhaar|phone|mobile|address/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}(-\d{2})?$/;

function scanKeys(v: unknown, trail: string, out: string[]): void {
  if (Array.isArray(v)) { v.forEach((x, i) => scanKeys(x, `${trail}[${i}]`, out)); return; }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${trail}.${k}: voter-level or personal field, not accepted`);
      scanKeys(x, `${trail}.${k}`, out);
    }
  }
}

/** Problems with a results file (empty = fit to show). Never throws. */
export function validatePanchayatFile(raw: unknown, state: StateCode): string[] {
  const p: string[] = [];
  if (!raw || typeof raw !== "object") return ["file is not an object"];
  const f = raw as Partial<PanchayatFile>;
  scanKeys(raw, "$", p);
  if (f.state !== state) p.push(`state is ${String(f.state)}, expected ${state}`);
  const s = f.source;
  if (!s || !s.publisher || !s.url || !s.licence || !s.terms || !s.retrieved) p.push("source needs publisher, url, licence, terms and retrieved");
  else if (!ISO.test(s.retrieved)) p.push("source.retrieved must be YYYY-MM-DD");
  if (!s || (s.quality !== "commission" && s.quality !== "secondary")) p.push("source.quality must be commission or secondary");
  if (!Array.isArray(f.elections) || f.elections.length === 0) { p.push("elections must be a non-empty list"); return p; }
  const ids = new Set<string>();
  for (const e of f.elections) {
    const at = `election ${e?.id ?? "?"}`;
    if (!e || !e.id) { p.push("an election has no id"); continue; }
    if (ids.has(e.id)) p.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (!PANCHAYAT_LEVELS.includes(e.level)) p.push(`${at}: level must be one of ${PANCHAYAT_LEVELS.join(", ")}`);
    if (!Number.isInteger(e.year) || e.year < 1990 || e.year > 2100) p.push(`${at}: bad year`);
    if (typeof e.period !== "string" || !PERIOD.test(e.period) || !e.period.startsWith(String(e.year))) p.push(`${at}: period must be YYYY or YYYY-MM and start with the year`);
    if (e.phases && e.phases.some((x) => !ISO.test(x.date) || (x.turnoutPct != null && (x.turnoutPct < 0 || x.turnoutPct > 100)))) p.push(`${at}: phases need YYYY-MM-DD dates and turnout between 0 and 100`);
    const hasUnits = Array.isArray(e.units) && e.units.length > 0;
    const hasTallies = Array.isArray(e.tallies) && e.tallies.length > 0;
    if (!hasUnits && !hasTallies) { p.push(`${at}: needs units or tallies`); continue; }
    if (hasTallies) {
      if (!e.evidence || !e.evidence.url || !e.evidence.revision || !e.evidence.cites) p.push(`${at}: totals need evidence (url, revision, cites)`);
      if (!Array.isArray(e.caveats) || e.caveats.length === 0) p.push(`${at}: totals need at least one stated caveat`);
      let sum = 0;
      for (const t of e.tallies!) {
        if (!t.party || !Number.isInteger(t.won) || t.won < 0) p.push(`${at}: tally needs a party and a whole number won`);
        sum += t.won;
        if (t.byPhase && t.byPhase.some((n) => n != null && (!Number.isInteger(n) || n < 0))) p.push(`${at}: ${t.party} byPhase has a bad number`);
      }
      if (e.totalPosts != null && sum > e.totalPosts) p.push(`${at}: tallies add up to ${sum}, more than totalPosts ${e.totalPosts}`);
    }
    if (hasUnits) {
      e.units!.forEach((u, i) => {
        if (!u.name || !u.district) p.push(`${at} unit ${i}: name and district are required`);
        if (!Number.isInteger(u.posts) || u.posts < 1) p.push(`${at} unit ${i}: posts must be a whole number of at least 1`);
        if (u.turnoutPct != null && (u.turnoutPct < 0 || u.turnoutPct > 100)) p.push(`${at} unit ${i}: turnoutPct outside 0 to 100`);
        if (u.contested != null && u.contested < 0) p.push(`${at} unit ${i}: contested is negative`);
      });
    }
  }
  return p;
}

const NOTES = [
  "Results are shown only from a source whose terms allow reuse, with its credit. Figures marked as totals come from a secondary source (English Wikipedia, CC BY-SA 4.0), which cites news reports; they are not commission data and are replaced when an official source is cleared.",
  "Gram panchayat elections are officially non-party. A party named here is the party the source says backs the winner, as reported, and is never inferred by us.",
  "No electoral-roll or voter-level data is requested or stored.",
];

export function panchayatResponse(state: StateCode, raw: unknown | null): PanchayatResponse {
  const base = { state, levels: PANCHAYAT_LEVELS, notes: NOTES };
  if (raw == null) return { ...base, loaded: false, granularity: "none", elections: [], source: null, problems: [] };
  const problems = validatePanchayatFile(raw, state);
  if (problems.length) return { ...base, loaded: false, granularity: "none", elections: [], source: null, problems };
  const f = raw as PanchayatFile;
  const elections: PanchayatSummary[] = f.elections
    .map((e) => ({
      id: e.id, level: e.level, year: e.year, period: e.period, scope: e.scope ?? null,
      units: e.units ? e.units.length : null,
      posts: e.units ? e.units.reduce((n, u) => n + u.posts, 0) : e.totalPosts ?? null,
      tallies: e.tallies ?? [], phases: e.phases ?? [], evidence: e.evidence ?? null, caveats: e.caveats ?? [],
    }))
    .sort((a, b) => b.year - a.year || a.level.localeCompare(b.level));
  return { ...base, loaded: true, granularity: f.elections.some((e) => e.units?.length) ? "units" : "totals", source: f.source, problems: [], elections };
}
