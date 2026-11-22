/**
 * S-95: Lok Sabha -> assembly segment mapping. Each AC belongs to exactly one PC (2008 delimitation, in force for every
 * AP/TG election in the dataset). Derived from the geo layer: ac-link.json rows and the ac-AP/TG.geojson `pcNo` property;
 * disagreements between the two are reported, never silently resolved.
 */
import fs from "node:fs";
import path from "node:path";
import type { StateCode } from "../../src/lib/states";

export interface SegmentsFile {
  schema: 1;
  asOf: string;
  delimitation: "2008";
  source: string;
  note: string;
  /** state -> acNo -> pcNo */
  segments: Record<StateCode, Record<string, number>>;
  /** state -> pcNo -> acNos (ascending) */
  pcs: Record<StateCode, Record<string, number[]>>;
  issues: string[];
}

interface LinkRow { state: StateCode; acNo: number; pcNo: number | null }
interface GeoLike { features: { properties: { state?: string; acNo?: number; pcNo?: number | null } }[] }

export function deriveSegments(link: LinkRow[], geo: Partial<Record<StateCode, GeoLike>>, asOf: string): SegmentsFile {
  const segments = { AP: {}, TG: {} } as SegmentsFile["segments"];
  const pcs = { AP: {}, TG: {} } as SegmentsFile["pcs"];
  const issues: string[] = [];
  const fromGeo = new Map<string, number>();
  for (const [st, g] of Object.entries(geo) as [StateCode, GeoLike][]) {
    for (const f of g?.features ?? []) if (f.properties.acNo != null && f.properties.pcNo != null) fromGeo.set(`${st}|${f.properties.acNo}`, f.properties.pcNo);
  }
  for (const r of [...link].sort((a, b) => a.state.localeCompare(b.state) || a.acNo - b.acNo)) {
    const g = fromGeo.get(`${r.state}|${r.acNo}`);
    let pc = r.pcNo;
    if (pc == null && g != null) pc = g;
    if (pc == null) { issues.push(`${r.state} AC ${r.acNo}: no PC in ac-link or boundaries; left unmapped`); continue; }
    if (g != null && g !== pc) issues.push(`${r.state} AC ${r.acNo}: ac-link says PC ${pc}, boundaries say PC ${g}; ac-link used`);
    segments[r.state][String(r.acNo)] = pc;
    (pcs[r.state][String(pc)] ??= []).push(r.acNo);
  }
  for (const st of ["AP", "TG"] as const) for (const k of Object.keys(pcs[st])) pcs[st][k].sort((a, b) => a - b);
  return {
    schema: 1, asOf, delimitation: "2008",
    source: "Derived from data/generated/geo/ac-link.json (LGD/ECI 2008 delimitation table) cross-checked with ac-AP/TG.geojson pcNo",
    note: "Valid for every AP/TG election in the dataset (2014 to 2024): the 2008 delimitation order has not been revised for these states.",
    segments, pcs, issues,
  };
}

const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

export function buildSegmentsFromDisk(baseDir = process.cwd()): SegmentsFile {
  const dir = path.join(baseDir, "data", "generated", "geo");
  const link = read(path.join(dir, "ac-link.json"));
  const geo: Partial<Record<StateCode, GeoLike>> = {};
  for (const st of ["AP", "TG"] as const) { const f = path.join(dir, `ac-${st}.geojson`); if (fs.existsSync(f)) geo[st] = read(f); }
  return deriveSegments(link.rows, geo, link.asOf);
}

/** Committed segments.json when present, else derived on the fly from the geo layer; null when neither exists. */
export function loadSegments(baseDir = process.cwd()): SegmentsFile | null {
  try {
    const f = path.join(baseDir, "data", "generated", "lsmap", "segments.json");
    if (fs.existsSync(f)) return read(f) as SegmentsFile;
    return buildSegmentsFromDisk(baseDir);
  } catch { return null; }
}
