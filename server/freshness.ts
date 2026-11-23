/**
 * Data freshness (S-76). Pure and dependency-light so server/obs.ts can import it: reads data/generated/manifest.json and reports,
 * per dataset, the as-of date, age in days, the staleness threshold and a status (fresh | stale | unknown).
 * Thresholds reflect how often each source can change (LGD is refreshed daily upstream; the 2008 boundaries and Census 2011
 * only change with a new delimitation or census), and can be overridden with DATA_FRESHNESS_THRESHOLDS="id=days,id=days".
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type FreshnessStatus = "fresh" | "stale" | "unknown";
export interface DatasetFreshness {
  id: string; path: string; asOf: string | null; ageDays: number | null; thresholdDays: number; status: FreshnessStatus; demo: boolean;
}
export interface FreshnessReport {
  generatedAt: string; manifestPresent: boolean; manifestChecksum: string | null;
  summary: { fresh: number; stale: number; unknown: number };
  datasets: DatasetFreshness[];
}
export interface FreshnessAlert { raised: boolean; staleCount: number; unknownCount: number; stale: string[]; checkedAt: string }

const DAY = 86_400_000;
/** First matching rule wins. */
const DEFAULT_RULES: { match: RegExp; days: number }[] = [
  { match: /^elections$/, days: 2000 },
  { match: /^census-/, days: 7300 },
  { match: /^geo-(ac|pc|district)-(AP|TG)$|^geo-(ac-units|ac-link|district-crosswalk)$|^lsmap-/, days: 3650 },
  { match: /^geo-mandal/, days: 1095 },
  { match: /^geo-(lgd|names-te|boundaries-report|review)/, days: 365 },
  { match: /^(parties|alliances)$/, days: 730 },
];
export const FALLBACK_THRESHOLD_DAYS = 365;

export function parseThresholdOverrides(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw ?? "").split(",")) {
    const m = /^\s*([A-Za-z0-9._-]+)\s*=\s*(\d{1,5})\s*$/.exec(part);
    if (m && Number(m[2]) > 0) out[m[1]] = Number(m[2]);
  }
  return out;
}
export function thresholdFor(id: string, overrides: Record<string, number> = {}): number {
  return overrides[id] ?? DEFAULT_RULES.find(r => r.match.test(id))?.days ?? FALLBACK_THRESHOLD_DAYS;
}

/** ISO date ("2026-11-22") or a bare year at the start ("2024 (latest election in file)" -> end of that year). */
export function parseAsOf(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) { const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])); return Number.isNaN(d.getTime()) ? null : d; }
  const yr = /^(\d{4})\b/.exec(s);
  return yr ? new Date(Date.UTC(+yr[1], 11, 31)) : null;
}

export function manifestPath(baseDir: string): string { return path.join(baseDir, "data", "generated", "manifest.json"); }
export function manifestChecksum(baseDir: string): string | null {
  try { return crypto_sha(fs.readFileSync(manifestPath(baseDir))); } catch { return null; }
}
const crypto_sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

export function computeFreshness(baseDir: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): FreshnessReport {
  const overrides = parseThresholdOverrides(env.DATA_FRESHNESS_THRESHOLDS);
  let datasets: DatasetFreshness[] = [];
  let present = false;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(baseDir), "utf8")) as { datasets?: { id: string; path: string; asOf: string | null; demo?: boolean }[] };
    present = true;
    datasets = (m.datasets ?? []).map(d => {
      const t = thresholdFor(d.id, overrides);
      const asOf = parseAsOf(d.asOf);
      const ageDays = asOf ? Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / DAY)) : null;
      const status: FreshnessStatus = ageDays === null ? "unknown" : ageDays > t ? "stale" : "fresh";
      return { id: d.id, path: d.path, asOf: d.asOf ?? null, ageDays, thresholdDays: t, status, demo: !!d.demo };
    });
  } catch { /* no manifest: everything unknown */ }
  const count = (s: FreshnessStatus) => datasets.filter(d => d.status === s).length;
  return {
    generatedAt: now.toISOString(), manifestPresent: present, manifestChecksum: manifestChecksum(baseDir),
    summary: { fresh: count("fresh"), stale: count("stale"), unknown: count("unknown") }, datasets,
  };
}

/* ---------- alert flag (set by the freshness job, read lazily for /readyz) ---------- */
let current: FreshnessAlert | null = null;
let lastCheckMs = 0;
export function alertFrom(r: FreshnessReport): FreshnessAlert {
  const stale = r.datasets.filter(d => d.status === "stale").map(d => d.id);
  return { raised: stale.length > 0 || !r.manifestPresent, staleCount: stale.length, unknownCount: r.summary.unknown, stale, checkedAt: r.generatedAt };
}
export function setFreshnessAlert(a: FreshnessAlert | null): void { current = a; lastCheckMs = a ? Date.now() : 0; }
/** Cached for 60 s so /readyz stays cheap; the scheduled job refreshes it explicitly. */
export function freshnessAlert(baseDir: string = process.cwd()): FreshnessAlert {
  if (!current || Date.now() - lastCheckMs > 60_000) setFreshnessAlert(alertFrom(computeFreshness(baseDir)));
  return current!;
}
