/**
 * Panchayat elections (S-203): the data format, its checks and the loader. No results are loaded yet: the file data/reference/panchayat/results-<ST>.json
 * does not exist until a source has been approved (see docs/PANCHAYAT_DATA.md). Until then the API answers loaded:false and the page says so.
 * Unit-level only: one row per panchayat or territorial constituency. We do not hold or accept electoral-roll or voter-level data.
 */
import type { StateCode } from "./states";

export const PANCHAYAT_LEVELS = ["gp", "mptc", "zptc"] as const;
export type PanchayatLevel = (typeof PANCHAYAT_LEVELS)[number];

export interface PanchayatUnit {
  lgdCode?: string; name: string; district: string; mandal?: string;
  posts: number; contested?: number; unopposed?: boolean; turnoutPct?: number;
  winner?: { name: string; partyBacked?: string };
}
export interface PanchayatElection {
  id: string; level: PanchayatLevel; year: number; phases: string[]; units: PanchayatUnit[]; note?: string;
}
export interface PanchayatFile {
  state: StateCode;
  source: { publisher: string; url: string; licence: string; terms: string; retrieved: string };
  elections: PanchayatElection[];
}
export interface PanchayatResponse {
  state: StateCode; loaded: boolean; levels: readonly PanchayatLevel[];
  elections: { id: string; level: PanchayatLevel; year: number; phases: string[]; units: number; posts: number; unopposed: number }[];
  source: PanchayatFile["source"] | null; problems: string[]; notes: string[];
}

/** Keys that would mean voter-level or electoral-roll data; any file containing one is refused. */
const FORBIDDEN_KEY = /voter|epic|elector|roll|aadhaar|phone|mobile|address/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!Array.isArray(f.elections) || f.elections.length === 0) { p.push("elections must be a non-empty list"); return p; }
  const ids = new Set<string>();
  for (const e of f.elections) {
    const at = `election ${e?.id ?? "?"}`;
    if (!e || !e.id) { p.push("an election has no id"); continue; }
    if (ids.has(e.id)) p.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (!PANCHAYAT_LEVELS.includes(e.level)) p.push(`${at}: level must be one of ${PANCHAYAT_LEVELS.join(", ")}`);
    if (!Number.isInteger(e.year) || e.year < 1990 || e.year > 2100) p.push(`${at}: bad year`);
    if (!Array.isArray(e.phases) || e.phases.length === 0 || e.phases.some((d) => !ISO.test(d))) p.push(`${at}: phases must be a list of YYYY-MM-DD dates`);
    if (!Array.isArray(e.units) || e.units.length === 0) { p.push(`${at}: no units`); continue; }
    e.units.forEach((u, i) => {
      if (!u.name || !u.district) p.push(`${at} unit ${i}: name and district are required`);
      if (!Number.isInteger(u.posts) || u.posts < 1) p.push(`${at} unit ${i}: posts must be a whole number of at least 1`);
      if (u.turnoutPct != null && (u.turnoutPct < 0 || u.turnoutPct > 100)) p.push(`${at} unit ${i}: turnoutPct outside 0 to 100`);
      if (u.contested != null && u.contested < 0) p.push(`${at} unit ${i}: contested is negative`);
    });
  }
  return p;
}

const NOTES = [
  "Results are shown only from a source whose terms allow reuse, with its credit. Until one is approved, nothing is shown.",
  "Gram panchayat elections are officially non-party. Where a party is named it is the party that backs the winner, as stated in the source, and is never inferred.",
  "No electoral-roll or voter-level data is requested or stored.",
];

export function panchayatResponse(state: StateCode, raw: unknown | null): PanchayatResponse {
  const base = { state, levels: PANCHAYAT_LEVELS, notes: NOTES };
  if (raw == null) return { ...base, loaded: false, elections: [], source: null, problems: [] };
  const problems = validatePanchayatFile(raw, state);
  if (problems.length) return { ...base, loaded: false, elections: [], source: null, problems };
  const f = raw as PanchayatFile;
  return {
    ...base, loaded: true, source: f.source, problems: [],
    elections: f.elections.map((e) => ({ id: e.id, level: e.level, year: e.year, phases: e.phases, units: e.units.length, posts: e.units.reduce((n, u) => n + u.posts, 0), unopposed: e.units.filter((u) => u.unopposed).length })),
  };
}
