/**
 * S-92: versioned boundary sets (one set per delimitation order) with effective dates, checksums and a dry-run validator
 * for a future delimitation. A set is selected explicitly (`version`) or by date (`asOf`); asking for both with a mismatch is an
 * error, and every link row belongs to exactly one set, so a lookup can never silently mix versions.
 * Registry: data/generated/geo/versions.json. Procedure: docs/BOUNDARY_VERSIONS.md.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Same normalisation as pipeline/manifest sha256Of (CRLF -> LF), kept local so the server bundle does not pull in the pipeline IO layer. */
export function sha256Of(file: string): string {
  const text = fs.readFileSync(file).toString("latin1").replace(/\r\n/g, "\n");
  return createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex");
}

export const CURRENT_SET_ID = "delimitation-2008";
export const DELIMITATION_2008_ORDER = "Delimitation of Parliamentary and Assembly Constituencies Order, 2008 (ECI/Delimitation Commission)";

export interface BoundarySet {
  id: string;
  label: string;
  /** inclusive, ISO date */
  valid_from: string;
  /** exclusive, ISO date; null = open ended (the current set) */
  valid_to: string | null;
  source: string;
  datesInferred?: boolean;
  /** fixture sets that must never be installed or served */
  testOnly?: boolean;
  /** seat counts the set must satisfy per state */
  seats: Record<string, { assembly: number; ls: number }>;
  /** kind -> state -> path relative to data/generated/geo */
  files: Record<string, Record<string, string>>;
  /** path (as in files) -> sha256 (CRLF-normalised, see pipeline/manifest sha256Of) */
  checksums: Record<string, string>;
}
export interface VersionRegistry { schema: 1; asOf: string; note: string; sets: BoundarySet[] }

export class VersionError extends Error {
  constructor(public code: "invalid_version" | "invalid_asof" | "unknown_version" | "no_set_for_date" | "version_mismatch", message: string) { super(message); }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (s: string) => ISO.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
export const today = () => new Date().toISOString().slice(0, 10);
const covers = (s: BoundarySet, d: string) => s.valid_from <= d && (s.valid_to === null || d < s.valid_to);

export function loadRegistry(geoDir: string): VersionRegistry | null {
  try { return JSON.parse(fs.readFileSync(path.join(geoDir, "versions.json"), "utf8")) as VersionRegistry; } catch { return null; }
}

/** The set served when nothing is asked for: the one covering today (live sets only). */
export function currentSet(reg: VersionRegistry, now: string = today()): BoundarySet | null {
  return reg.sets.find(s => !s.testOnly && covers(s, now)) ?? null;
}

/** Pick a set by explicit id and/or date. Both given must agree. Neither given = current. */
export function selectSet(reg: VersionRegistry, sel: { asOf?: string; version?: string } = {}, now: string = today()): BoundarySet {
  const { asOf, version } = sel;
  if (version !== undefined && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(version)) throw new VersionError("invalid_version", "version must be a set id such as delimitation-2008");
  if (asOf !== undefined && !isIso(asOf)) throw new VersionError("invalid_asof", "asOf must be an ISO date (YYYY-MM-DD)");
  let byId: BoundarySet | undefined, byDate: BoundarySet | undefined;
  if (version !== undefined) {
    byId = reg.sets.find(s => s.id === version && !s.testOnly);
    if (!byId) throw new VersionError("unknown_version", `No boundary set '${version}'. Known: ${reg.sets.filter(s => !s.testOnly).map(s => s.id).join(", ")}`);
  }
  if (asOf !== undefined) {
    byDate = reg.sets.find(s => !s.testOnly && covers(s, asOf));
    if (!byDate) throw new VersionError("no_set_for_date", `No boundary set is valid on ${asOf}`);
  }
  if (byId && byDate && byId.id !== byDate.id) throw new VersionError("version_mismatch", `version ${byId.id} is not valid on ${asOf} (that date belongs to ${byDate.id}); pass only one of them`);
  const hit = byId ?? byDate ?? currentSet(reg, now);
  if (!hit) throw new VersionError("no_set_for_date", `No boundary set is valid on ${now}`);
  return hit;
}

/** Structural checks on a registry. Returns error strings ([] = ok). `geoDir` also verifies files and checksums. */
export function validateRegistry(reg: VersionRegistry, geoDir?: string, now: string = today()): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const s of reg.sets) {
    if (ids.has(s.id)) errs.push(`duplicate set id ${s.id}`);
    ids.add(s.id);
    if (!/^delimitation-\d{4}(-[a-z0-9]+)?$/.test(s.id)) errs.push(`${s.id}: id must look like delimitation-YYYY`);
    if (!isIso(s.valid_from)) errs.push(`${s.id}: valid_from is not an ISO date`);
    if (s.valid_to !== null && !isIso(s.valid_to)) errs.push(`${s.id}: valid_to is not an ISO date or null`);
    if (s.valid_to !== null && s.valid_to <= s.valid_from) errs.push(`${s.id}: valid_to must be after valid_from`);
    if (!s.source) errs.push(`${s.id}: source is missing`);
    if (s.testOnly) errs.push(`${s.id}: testOnly sets must not be in the live registry`);
    for (const [st, c] of Object.entries(s.seats ?? {})) if (!(c.assembly > 0 && c.ls > 0)) errs.push(`${s.id}: ${st} seat counts invalid`);
  }
  const live = reg.sets.filter(s => !s.testOnly).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  for (let i = 0; i < live.length - 1; i++) {
    const a = live[i], b = live[i + 1];
    if (a.valid_to === null) errs.push(`${a.id} is open ended but ${b.id} starts later`);
    else if (a.valid_to > b.valid_from) errs.push(`${a.id} and ${b.id} overlap (${a.valid_to} > ${b.valid_from})`);
    else if (a.valid_to < b.valid_from) errs.push(`gap between ${a.id} (to ${a.valid_to}) and ${b.id} (from ${b.valid_from})`);
  }
  if (live.length && live[live.length - 1].valid_to !== null) errs.push(`the latest set ${live[live.length - 1].id} must be open ended (valid_to null)`);
  if (!currentSet(reg, now)) errs.push(`no live set covers ${now}`);
  if (geoDir) {
    for (const s of reg.sets) for (const [kind, byState] of Object.entries(s.files ?? {})) for (const [st, rel] of Object.entries(byState)) {
      const f = path.join(geoDir, rel);
      if (!fs.existsSync(f)) { errs.push(`${s.id}: ${kind}/${st} file ${rel} is missing`); continue; }
      const want = s.checksums?.[rel];
      if (!want) errs.push(`${s.id}: no checksum recorded for ${rel}`);
      else if (sha256Of(f) !== want) errs.push(`${s.id}: checksum mismatch for ${rel} (files changed without a new set; see docs/BOUNDARY_VERSIONS.md)`);
    }
  }
  return errs;
}

/** Build the registry entry for the delimitation now in force from the files on disk. */
export function buildCurrentRegistry(geoDir: string, asOf: string = today()): VersionRegistry {
  const files: BoundarySet["files"] = {}, checksums: Record<string, string> = {};
  for (const kind of ["ac", "pc", "district", "mandal"]) {
    for (const st of ["AP", "TG"]) {
      const rel = `${kind}-${st}.geojson`;
      if (!fs.existsSync(path.join(geoDir, rel))) continue;
      (files[kind] ??= {})[st] = rel;
      checksums[rel] = sha256Of(path.join(geoDir, rel));
    }
  }
  return {
    schema: 1, asOf,
    note: "One entry per delimitation. Mandal polygons are LGD administrative units, not delimitation units; they are listed under the set in force when they were built.",
    sets: [{
      id: CURRENT_SET_ID, label: "2008 delimitation (in force for AP/TG elections 2009-2024)", valid_from: "2008-02-19", valid_to: null,
      source: DELIMITATION_2008_ORDER, datesInferred: true,
      seats: { AP: { assembly: 175, ls: 25 }, TG: { assembly: 119, ls: 17 } }, files, checksums,
    }],
  };
}

/* ---------- dry-run validation of a future delimitation ---------- */
export interface LinkRowV { set: string; state: string; acNo: number; pcNo: number | null; districtLgd: string | null; validFrom: string; validTo: string | null }
export interface CandidateBundle { set: BoundarySet; rows: LinkRowV[]; note?: string }

/**
 * Validate a candidate delimitation against the live registry without touching any file. Returns errors and the registry
 * change that installing it would make (the previous set closed the day before).
 */
export function dryRunCandidate(reg: VersionRegistry, cand: CandidateBundle, now: string = today()): { errors: string[]; warnings: string[]; plan: string[]; installable: boolean } {
  const errors: string[] = [], warnings: string[] = [], plan: string[] = [];
  const s = cand.set;
  if (!/^delimitation-\d{4}(-[a-z0-9]+)?$/.test(s.id)) errors.push(`id ${s.id} must look like delimitation-YYYY`);
  if (reg.sets.some(x => x.id === s.id)) errors.push(`set id ${s.id} already exists`);
  if (!isIso(s.valid_from)) errors.push("valid_from is not an ISO date");
  if (s.valid_to !== null) errors.push("a new set must be open ended (valid_to null)");
  if (!s.source) errors.push("source is missing");
  const live = [...reg.sets].filter(x => !x.testOnly).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  const prev = live[live.length - 1];
  if (prev && isIso(s.valid_from)) {
    if (s.valid_from <= prev.valid_from) errors.push(`valid_from ${s.valid_from} must be after ${prev.id} starts (${prev.valid_from})`);
    else plan.push(`close ${prev.id}: valid_to ${prev.valid_to ?? "null"} -> ${s.valid_from}`);
    if (s.valid_from <= now) warnings.push(`valid_from ${s.valid_from} is not in the future: installing it switches the default set immediately`);
  }
  plan.push(`add ${s.id} from ${s.valid_from}`);
  for (const [st, c] of Object.entries(s.seats ?? {})) {
    const rows = cand.rows.filter(r => r.state === st);
    const acs = new Set(rows.map(r => r.acNo));
    if (rows.length !== acs.size) errors.push(`${st}: duplicate acNo in link rows`);
    if (acs.size !== c.assembly) errors.push(`${st}: ${acs.size} assembly seats linked, set declares ${c.assembly}`);
    for (let n = 1; n <= c.assembly; n++) if (!acs.has(n)) { errors.push(`${st}: assembly seat ${n} missing (numbers must run 1..${c.assembly})`); break; }
    const pcs = new Set(rows.map(r => r.pcNo).filter((x): x is number => x != null));
    if (rows.some(r => r.pcNo == null)) errors.push(`${st}: some ACs have no parliamentary constituency`);
    if (pcs.size !== c.ls) errors.push(`${st}: ${pcs.size} parliamentary constituencies linked, set declares ${c.ls}`);
    for (const p of pcs) if (p < 1 || p > c.ls) { errors.push(`${st}: pcNo ${p} outside 1..${c.ls}`); break; }
    if (rows.some(r => !r.districtLgd)) errors.push(`${st}: some ACs have no district`);
  }
  for (const r of cand.rows) {
    if (r.set !== s.id) errors.push(`row ${r.state}/${r.acNo} belongs to set ${r.set}, not ${s.id}: mixed versions`);
    if (r.validFrom !== s.valid_from || r.validTo !== null) errors.push(`row ${r.state}/${r.acNo} dates differ from the set's validity`);
  }
  if (!s.files || !Object.keys(s.files).length) warnings.push("no boundary files listed: polygons must be added before the set is served");
  if (s.testOnly) warnings.push("TEST ONLY fixture: structure validated, but this set can never be installed");
  return { errors, warnings, plan, installable: !errors.length && !s.testOnly };
}
