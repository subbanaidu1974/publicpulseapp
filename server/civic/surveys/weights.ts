/**
 * Post-stratification weights by raking (iterative proportional fitting) to the published marginals that EXIST (S-33).
 *
 * Marginals live in data/reference/survey-marginals.json (override: SURVEY_MARGINALS_FILE). Every figure carries `source`, `asOf` and
 * `provenance`; `provenance: "placeholder"`, a missing area or malformed shares mean the dimension is NOT used and the method note
 * lists it as skipped, with the reason. Nothing is ever invented: with no usable marginal, weights are all 1 and the weighted view
 * equals the unweighted view (and says so).
 *
 * Weights are trimmed at WEIGHT_CAP (5) times the mean weight and re-normalised to mean 1 (documented in docs/SURVEY_METHOD.md).
 * Kish design effect deff = n * sum(w^2) / (sum w)^2 and effective sample size n_eff = n / deff.
 */
import fs from "node:fs";
import path from "node:path";

export const WEIGHT_CAP = 5;
export const VERIFIED_PROVENANCE = ["census-2011", "electoral-roll", "verified-other"];

export interface MarginalArea { shares: Record<string, number> | null; source?: string; asOf?: string; provenance?: string; universe?: string; label?: string }
export interface MarginalDimension { of: string[]; categories?: string[] | null; provenance?: string; status?: string; note?: string; areas: Record<string, MarginalArea> }
export interface MarginalsFile { schema: number; dimensions: Record<string, MarginalDimension> }

export const marginalsPath = (): string => process.env.SURVEY_MARGINALS_FILE || path.join(process.cwd(), "data", "reference", "survey-marginals.json");

/** Read the marginals file; null when missing or unreadable (then no dimension is weighted). */
export function loadMarginals(file: string = marginalsPath()): MarginalsFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.dimensions !== "object" || raw.dimensions === null) return null;
    return { schema: Number(raw.schema) || 1, dimensions: raw.dimensions as Record<string, MarginalDimension> };
  } catch { return null; }
}

export interface UsedDimension { dimension: string; of: string[]; area: string; shares: Record<string, number>; source: string; asOf: string; provenance: string }
export interface SkippedDimension { dimension: string; reason: "file_missing" | "placeholder" | "no_figures_for_area" | "invalid_shares" | "unverified_provenance" }
export interface TargetSelection { used: UsedDimension[]; skipped: SkippedDimension[] }

const sumOf = (o: Record<string, number>) => Object.values(o).reduce((s, x) => s + x, 0);

/**
 * Pick the usable marginals for a survey. `areaKeys` is the preference order, finest first (e.g. ["district:542", "state:AP"]).
 * A dimension is used only when it is not a placeholder, its provenance is verified, and its shares are valid (non-negative, sum 1 +- 0.01).
 */
export function selectTargets(file: MarginalsFile | null, areaKeys: string[]): TargetSelection {
  if (!file) return { used: [], skipped: [{ dimension: "all", reason: "file_missing" }] };
  const used: UsedDimension[] = [], skipped: SkippedDimension[] = [];
  for (const [name, dim] of Object.entries(file.dimensions)) {
    if (dim.provenance === "placeholder" || dim.status === "missing") { skipped.push({ dimension: name, reason: "placeholder" }); continue; }
    const key = areaKeys.find((k) => dim.areas && dim.areas[k]);
    if (!key) { skipped.push({ dimension: name, reason: "no_figures_for_area" }); continue; }
    const a = dim.areas[key];
    const prov = a.provenance ?? dim.provenance ?? "";
    if (prov === "placeholder") { skipped.push({ dimension: name, reason: "placeholder" }); continue; }
    if (!VERIFIED_PROVENANCE.includes(prov)) { skipped.push({ dimension: name, reason: "unverified_provenance" }); continue; }
    const sh = a.shares;
    if (!sh || Object.values(sh).some((x) => !Number.isFinite(x) || x < 0) || Math.abs(sumOf(sh) - 1) > 0.01) { skipped.push({ dimension: name, reason: "invalid_shares" }); continue; }
    used.push({ dimension: name, of: dim.of, area: key, shares: { ...sh }, source: a.source ?? "", asOf: a.asOf ?? "", provenance: prov });
  }
  return { used, skipped };
}

/** Category of a respondent on a dimension (joint dimensions join their parts with "|"); null when any part is missing. */
export function categoryOf(strata: Record<string, string | null | undefined>, of: string[]): string | null {
  const parts = of.map((f) => strata[f]);
  return parts.every((p) => typeof p === "string" && p !== "") ? (parts as string[]).join("|") : null;
}

export interface RakeUnit { cats: Record<string, string | null> }
export interface DimensionFit { dimension: string; categories_in_target: number; empty_categories: string[]; covered: number; max_gap_pp: number }
export interface RakeResult {
  weights: number[];
  dimensions: string[];
  iterations: number;
  converged: boolean;
  trimmed: number;
  max_weight: number;
  fits: DimensionFit[];
}

const mean = (w: number[]) => (w.length ? w.reduce((s, x) => s + x, 0) / w.length : 0);

/**
 * Rake `units` to `targets` (dimension -> shares). Respondents whose category is missing or not in a target are left unadjusted on that
 * dimension (the covered mass is preserved). Categories with no respondents cannot be fitted: they are dropped and the rest renormalised,
 * and listed in `fits[].empty_categories`. Returns weights with mean 1, trimmed at `cap` x mean.
 */
export function rake(units: RakeUnit[], targets: Record<string, Record<string, number>>, opts: { cap?: number; maxIter?: number; tol?: number; rounds?: number } = {}): RakeResult {
  const cap = opts.cap ?? WEIGHT_CAP, maxIter = opts.maxIter ?? 200, tol = opts.tol ?? 1e-7, rounds = opts.rounds ?? 6;
  const n = units.length;
  const w = new Array<number>(n).fill(1);
  const dims = Object.keys(targets);
  const fits: DimensionFit[] = [];
  const adj = new Map<string, Record<string, number>>();
  for (const d of dims) {
    const present = new Set(units.map((u) => u.cats[d]).filter((c): c is string => typeof c === "string" && c in targets[d]));
    const t: Record<string, number> = {};
    let s = 0;
    for (const c of Object.keys(targets[d])) if (present.has(c)) { t[c] = targets[d][c]; s += targets[d][c]; }
    if (s > 0) for (const c of Object.keys(t)) t[c] /= s;
    adj.set(d, t);
    fits.push({ dimension: d, categories_in_target: Object.keys(targets[d]).length, empty_categories: Object.keys(targets[d]).filter((c) => !present.has(c)), covered: units.filter((u) => typeof u.cats[d] === "string" && u.cats[d]! in t).length, max_gap_pp: 0 });
  }
  const active = dims.filter((d) => Object.keys(adj.get(d)!).length > 0);
  let iterations = 0, converged = active.length === 0, trimmed = 0;
  if (n > 0 && active.length) {
    for (let round = 0; round < rounds; round++) {
      converged = false;
      for (let it = 0; it < maxIter; it++) {
        iterations++;
        let gap = 0;
        for (const d of active) {
          const t = adj.get(d)!;
          const tot: Record<string, number> = {};
          let covered = 0;
          units.forEach((u, i) => { const c = u.cats[d]; if (typeof c === "string" && c in t) { tot[c] = (tot[c] ?? 0) + w[i]; covered += w[i]; } });
          for (const c of Object.keys(t)) gap = Math.max(gap, Math.abs((tot[c] ?? 0) / covered - t[c]));
          units.forEach((u, i) => { const c = u.cats[d]; if (typeof c === "string" && c in t && tot[c] > 0) w[i] *= (t[c] * covered) / tot[c]; });
        }
        if (gap < tol) { converged = true; break; }
      }
      // trim at cap x mean and renormalise; stop when nothing exceeds the cap any more
      const m = mean(w);
      let over = 0;
      for (let i = 0; i < n; i++) if (w[i] > cap * m) { w[i] = cap * m; over++; }
      const m2 = mean(w);
      for (let i = 0; i < n; i++) w[i] /= m2;
      trimmed = Math.max(trimmed, over);
      if (!over) break;
    }
  }
  // final trim to a fixed point: after renormalising, no weight exceeds cap x mean
  for (let i = 0; i < 500 && n > 0; i++) {
    const mm = mean(w);
    let over = 0;
    for (let j = 0; j < n; j++) if (w[j] > cap * mm * (1 + 1e-12)) { w[j] = cap * mm; over++; }
    if (!over) break;
    trimmed = Math.max(trimmed, over);
    const m3 = mean(w);
    for (let j = 0; j < n; j++) w[j] /= m3;
  }
  const m = mean(w) || 1;
  const out = w.map((x) => x / m);
  // residual gaps against the (possibly trimmed) final weights
  for (const f of fits) {
    const t = adj.get(f.dimension)!;
    const tot: Record<string, number> = {};
    let covered = 0;
    units.forEach((u, i) => { const c = u.cats[f.dimension]; if (typeof c === "string" && c in t) { tot[c] = (tot[c] ?? 0) + out[i]; covered += out[i]; } });
    let gap = 0;
    if (covered > 0) for (const c of Object.keys(t)) gap = Math.max(gap, Math.abs((tot[c] ?? 0) / covered - t[c]));
    f.max_gap_pp = Math.round(gap * 1000) / 10;
  }
  return { weights: out, dimensions: active, iterations, converged, trimmed, max_weight: out.length ? Math.max(...out) : 0, fits };
}

/** Kish design effect from weights (1 when n is 0 or all weights equal). */
export function designEffect(w: number[]): number {
  if (!w.length) return 1;
  const s = w.reduce((a, b) => a + b, 0), s2 = w.reduce((a, b) => a + b * b, 0);
  return s > 0 ? (w.length * s2) / (s * s) : 1;
}
/** Effective sample size (sum w)^2 / sum w^2 = n / deff. */
export function effectiveN(w: number[]): number {
  if (!w.length) return 0;
  const s = w.reduce((a, b) => a + b, 0), s2 = w.reduce((a, b) => a + b * b, 0);
  return s2 > 0 ? (s * s) / s2 : 0;
}
