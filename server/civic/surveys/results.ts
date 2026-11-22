/**
 * Published survey figures (S-32, S-33; DESIGN_2028 3.3; docs/SURVEYS.md, docs/SURVEY_METHOD.md).
 *
 * One IMMUTABLE snapshot per survey, built once after close + delay by buildPublishedSnapshot()/publishDueSurveys() and stored with its
 * sha256 in the survey store (`survey_results`, update/delete blocked by triggers). The public routes only READ that snapshot:
 *   GET /:id/results          the snapshot (or one single dimension of it with ?by=), ETag = its sha256, 403 not_published before it exists
 *   GET /:id/results/method   quality components, weights used and skipped, suppression statistics (counts only, never hidden cells)
 * Nothing is computed per request, so differently sliced queries cannot be differenced to recover a suppressed cell.
 */
import type { Request, Response } from "express";
import { Router } from "express";
import { audit, getStore, registerMigration, runInStore } from "../core";
import { surveysAllowed } from "../../window";
import { registerJob } from "../jobs";
import { ancestors } from "../geo/service";
import { consumeBudget } from "./budget";
import {
  DISCLAIMER_EN, DISCLAIMER_TE, LEVELS, METHOD_URL, accumulate, findBannedWording, isPoliticalTopic, partitionLevels, policyFromEnv, publishGate, publishTree,
  sha256Hex, stableStringify, type Level, type PathStep, type PublishPolicy, type PublishedTree,
} from "./publish";
import { qualityScore, samplingNote } from "./quality";
import { getSurveyForResponse } from "./source";
import { registryNow } from "./types";
import { WEIGHT_CAP, categoryOf, designEffect, effectiveN, loadMarginals, rake, selectTargets, type MarginalsFile } from "./weights";

export const METHOD_VERSION = "pulse-survey-method/1.0.0";
export const codeVersion = (env: NodeJS.ProcessEnv = process.env): string => `${METHOD_VERSION}+${(env.SURVEY_CODE_VERSION || "dev").slice(0, 12)}`;

registerMigration("survey-results-001", `
CREATE TABLE IF NOT EXISTS survey_results (
  survey_id TEXT PRIMARY KEY, topic_class TEXT NOT NULL, state TEXT NOT NULL,
  snapshot TEXT NOT NULL, method TEXT NOT NULL, sha256 TEXT NOT NULL, method_sha256 TEXT NOT NULL,
  code_version TEXT NOT NULL, published_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS survey_results_no_update BEFORE UPDATE ON survey_results BEGIN SELECT RAISE(ABORT, 'published survey figures are immutable'); END;
CREATE TRIGGER IF NOT EXISTS survey_results_no_delete BEFORE DELETE ON survey_results BEGIN SELECT RAISE(ABORT, 'published survey figures are immutable'); END;
`, "survey");

// ---------------------------------------------------------------------------------------------
// input shapes (the seam to the registry and the response tables)
// ---------------------------------------------------------------------------------------------

export interface FigureQuestion {
  id: string; kind: "single" | "multi" | "scale5"; text_en?: string | null; text_te?: string | null;
  options: { id: string; label_en?: string | null; label_te?: string | null }[];
}
export interface FigureSurvey {
  id: string; state: string; topic_class: string; election_choice: boolean; status: string; closes_at: string; closed_at?: string | null;
  title_en?: string | null; title_te?: string | null;
  /** Finest level named by the survey scope (state when it has no unit list). */
  scope_level: Level;
  scope_name_en?: string | null;
  partition_finest?: Level;
  census_district_code?: string | null;
  questions: FigureQuestion[];
}
export interface FigureResponse {
  answers: Record<string, unknown>;
  strata: { age_band?: string | null; gender?: string | null; tier?: string | null; mandal?: string | null; village?: string | null };
  channel: "app" | "assisted";
  /** "high" for responses the number-intelligence check flagged (the stored quality flag "low"); null when unknown. */
  risk?: string | null;
}
export interface FigureSource {
  surveyIds(): string[];
  survey(id: string): FigureSurvey | null;
  responses(id: string): FigureResponse[];
}

// ---------------------------------------------------------------------------------------------
// building one snapshot (pure given its inputs)
// ---------------------------------------------------------------------------------------------

const normGender = (g: string | null | undefined): string | null => {
  const s = String(g ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "m" || s === "male" || s === "man") return "M";
  if (s === "f" || s === "female" || s === "woman") return "F";
  if (s === "ns") return "NS";
  return "O";
};
const unknownCat = (v: string | null | undefined) => (v && String(v).trim() ? String(v) : "unknown");

export interface BuildContext {
  now: Date;
  policy: PublishPolicy;
  marginals: MarginalsFile | null;
  /** Path of cells for one response, root first (see geoPathFor). */
  geoPath: (r: FigureResponse, survey: FigureSurvey, levels: Level[]) => PathStep[];
  code?: string;
}

const DIMENSIONS = ["age_band", "gender", "tier"] as const;

/** Ids of the options a response chose for a question (single, multi and scale5 answers). */
function chosen(q: FigureQuestion, v: unknown): string[] {
  const allowed = new Set(q.options.map((o) => o.id));
  const raw = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out = raw.map((x) => String(x)).filter((x) => allowed.has(x));
  return q.kind === "single" || q.kind === "scale5" ? out.slice(0, 1) : [...new Set(out)];
}

export function buildSnapshotData(survey: FigureSurvey, all: FigureResponse[], ctx: BuildContext): { snapshot: Record<string, unknown>; method: Record<string, unknown> } {
  const { policy } = ctx;
  const levels = partitionLevels(survey.scope_level, survey.partition_finest);
  const political = isPoliticalTopic(survey.topic_class) || survey.election_choice;
  const strataOut: unknown[] = [], methodStrata: unknown[] = [];
  const areaKeys = [...(survey.census_district_code ? [`district:${survey.census_district_code}`] : []), `state:${survey.state}`];
  const selection = selectTargets(ctx.marginals, areaKeys);

  for (const channel of ["app", "assisted"] as const) {
    const rs = all.filter((r) => r.channel === channel);
    if (!rs.length) continue;
    if (channel === "assisted" && political) { strataOut.push({ channel, published: false, reason: "not_permitted_for_topic" }); continue; }
    if (rs.length < policy.k) { strataOut.push({ channel, published: false, reason: "below_minimum_cell_size" }); continue; }

    // ---- weights
    const cats = rs.map((r) => {
      const base = { age_band: r.strata.age_band ?? null, gender: normGender(r.strata.gender), tier: r.strata.tier ?? null } as Record<string, string | null>;
      const out: Record<string, string | null> = {};
      for (const d of selection.used) out[d.dimension] = categoryOf(base, d.of);
      return out;
    });
    const targets = Object.fromEntries(selection.used.map((d) => [d.dimension, d.shares]));
    const rk = rake(cats.map((c) => ({ cats: c })), targets, { cap: WEIGHT_CAP });
    const w = rk.weights;
    const deff = designEffect(w), neff = effectiveN(w);
    const weighted = rk.dimensions.length > 0;
    const q = qualityScore({ n: rs.length, tiers: rs.map((r) => r.strata.tier), risks: rs.map((r) => r.risk ?? null), cats, used: selection.used.filter((d) => rk.dimensions.includes(d.dimension)) });

    // ---- per question figures
    const questions = survey.questions.map((qu) => {
      const order = qu.options.map((o) => o.id);
      const rec = rs.map((r, i) => ({ r, i, opts: chosen(qu, r.answers[qu.id]) })).filter((x) => x.opts.length > 0);
      const geo = publishTree(accumulate(rec.map((x) => ({ path: ctx.geoPath(x.r, survey, levels), options: x.opts, w: w[x.i] }))), order, policy);
      const dims: Record<string, PublishedTree> = {};
      for (const d of DIMENSIONS) {
        dims[d] = publishTree(accumulate(rec.map((x) => {
          const v = d === "gender" ? normGender(x.r.strata.gender) : (x.r.strata[d] ?? null);
          return { path: [{ id: "all", level: "all" }, { id: unknownCat(v), level: d, label_en: unknownCat(v) }], options: x.opts, w: w[x.i] };
        })), order, policy);
      }
      return { qu, geo, dims };
    });

    const statsOf = (t: PublishedTree) => ({ cells: t.stats.cells, published: t.stats.published, suppressed_small: t.stats.hidden_small, suppressed_complementary: t.stats.hidden_complementary, suppressed_rolled_up_descendants: t.stats.hidden_descendants, merged_cells: t.stats.merged_cells });
    const nRounded = Math.round(rs.length / policy.roundTo) * policy.roundTo;
    strataOut.push({
      channel, published: true, platform_linkable: channel === "assisted",
      label_en: channel === "assisted" ? "Assisted responses (phone or volunteer; the platform can link these to the person, reported separately and never merged with app responses)" : "App responses (anonymous credential)",
      n: nRounded,
      sampling: samplingNote(nRounded, Math.round(neff), deff, weighted),
      weighting: { applied: weighted, dimensions: rk.dimensions, cap: WEIGHT_CAP, note_en: weighted ? `Weighted to ${rk.dimensions.join(", ")}; see the method note.` : "No verified reference figures were available, so no weighting was applied: weighted and unweighted figures are identical." },
      quality: { score: q.score, partial: q.partial, components: q.components.map((c) => ({ key: c.key, weight: c.weight, value: c.value, available: c.available })), skew_index: q.skew_index },
      questions: questions.map(({ qu, geo, dims }) => ({
        id: qu.id, kind: qu.kind, text_en: qu.text_en ?? null, text_te: qu.text_te ?? null,
        options: qu.options.map((o) => ({ id: o.id, label_en: o.label_en ?? null, label_te: o.label_te ?? null })),
        breakdowns: { geo: geo.published ? geo.cells : [], ...Object.fromEntries(DIMENSIONS.map((d) => [d, dims[d].published ? dims[d].cells : []])) },
      })),
    });
    methodStrata.push({
      channel,
      quality: { score: q.score, partial: q.partial, formula: q.formula, components: q.components },
      weights: { applied: weighted, dimensions_used: selection.used.map((d) => ({ dimension: d.dimension, area: d.area, source: d.source, as_of: d.asOf, provenance: d.provenance, weighted: rk.dimensions.includes(d.dimension) })), dimensions_skipped: selection.skipped, cap: WEIGHT_CAP, trimmed_weights: rk.trimmed, max_weight: Math.round(rk.max_weight * 100) / 100, iterations: rk.iterations, converged: rk.converged, residual_gap_pp: rk.fits.map((f) => ({ dimension: f.dimension, max_gap_pp: f.max_gap_pp, empty_categories: f.empty_categories })), design_effect: Math.round(deff * 100) / 100, effective_n: Math.round(neff * 10) / 10 },
      suppression: { k: policy.k, geo: questions.map(({ qu, geo }) => ({ question: qu.id, ...statsOf(geo) })), dimensions: questions.map(({ qu, dims }) => ({ question: qu.id, ...Object.fromEntries(DIMENSIONS.map((d) => [d, statsOf(dims[d])])) })) },
    });
  }

  const published = strataOut.some((s) => (s as { published: boolean }).published);
  const snapshot = {
    schema: 1, kind: "pulse_survey_figures",
    survey: { id: survey.id, title_en: survey.title_en ?? null, title_te: survey.title_te ?? null, topic_class: survey.topic_class, state: survey.state, scope_level: survey.scope_level, closes_at: survey.closed_at ?? survey.closes_at },
    published_at: ctx.now.toISOString(),
    disclaimer_en: DISCLAIMER_EN, disclaimer_te: DISCLAIMER_TE,
    method_url: METHOD_URL, code_version: ctx.code ?? codeVersion(),
    partition: { levels, minimum_cell_size: policy.k, counts_rounded_to: policy.roundTo, hidden_cells_rolled_up_into_parent: true },
    one_dimension_only: true,
    has_published_figures: published,
    strata: strataOut,
  };
  const method = {
    schema: 1, survey_id: survey.id, method_url: METHOD_URL, code_version: ctx.code ?? codeVersion(), published_at: ctx.now.toISOString(),
    disclaimer_en: DISCLAIMER_EN, disclaimer_te: DISCLAIMER_TE,
    policy: { minimum_cell_size: policy.k, minimum_option_count: policy.minOptionCount, minimum_option_share: policy.minOptionShare, counts_rounded_to: policy.roundTo, delay_hours: policy.delayMs / 3_600_000, publishing_window_hour_ist: policy.windowHourIst },
    marginals_file_loaded: ctx.marginals !== null,
    strata: methodStrata,
  };
  // developer guard: platform-written copy must not use the banned words (creator text is excluded by key)
  const bad = [...findBannedWording(snapshot), ...findBannedWording(method)];
  if (bad.length) throw new Error("survey figures copy uses banned wording: " + bad.slice(0, 3).join("; "));
  return { snapshot, method };
}

/** Geo path of one response: [root, ...partition levels below it], with "_unassigned" cells where the place is unknown. */
export function geoPathFor(r: FigureResponse, s: FigureSurvey, levels: Level[], resolve: (id: string, level: Level) => { id: string; name_en: string | null; name_te: string | null } | null): PathStep[] {
  const root: PathStep = s.scope_level === "state" ? { id: `state:${s.state}`, level: "state", label_en: s.state } : { id: "scope", level: "area", label_en: s.scope_name_en ?? "Survey area" };
  const steps: PathStep[] = [root];
  for (const lv of levels) {
    if (lv === "state") continue;
    const place = lv === "village" ? (r.strata.village ? resolve(r.strata.village, "village") : null) : r.strata.mandal ? resolve(r.strata.mandal, lv) : null;
    steps.push(place ? { id: `${lv}:${place.id}`, level: lv, label_en: place.name_en, label_te: place.name_te } : { id: `_unassigned:${lv}`, level: lv, label_en: "Unassigned" });
  }
  return steps;
}

const geoCache = new Map<string, Map<string, { id: string; name_en: string | null; name_te: string | null } | null>>();
/** Default resolver: the unit of `level` that contains `unitId` (itself included), from the LGD geography. */
export function lgdResolve(unitId: string, level: Level) {
  let m = geoCache.get(unitId);
  if (!m) {
    m = new Map();
    try { for (const u of ancestors(unitId)) m.set(u.level, { id: u.lgd, name_en: u.name_en, name_te: u.name_te }); } catch { /* geography not loaded */ }
    geoCache.set(unitId, m);
  }
  return m.get(level) ?? null;
}
export const clearGeoCache = (): void => geoCache.clear();

// ---------------------------------------------------------------------------------------------
// default source (survey store tables) and the test seam
// ---------------------------------------------------------------------------------------------

const sdb = () => getStore("survey");
let sourceOverride: FigureSource | null = null;
/** Tests install a fake source; null restores the default (survey store). */
export function setFigureSource(s: FigureSource | null): void { sourceOverride = s; }

function levelOfScope(units: Record<string, string[] | undefined>): Level {
  if (units.village?.length) return "village";
  if (units.mandal?.length) return "mandal";
  if (units.district?.length || units.constituency?.length || units.ac_no?.length) return "district";
  return "state";
}

const dbSource: FigureSource = {
  surveyIds() {
    try { return (sdb().prepare("SELECT id FROM surveys WHERE status IN ('open','closed') ORDER BY closes_at").all() as { id: string }[]).map((r) => r.id); } catch { return []; }
  },
  survey(id) {
    const s = getSurveyForResponse(id);
    if (!s) return null;
    let title: { title_en?: string; title_te?: string | null; closed_at?: string | null; election_choice?: number } = {};
    try { title = (sdb().prepare("SELECT title_en, title_te, closed_at, election_choice FROM surveys WHERE id = ?").get(id) as typeof title) ?? {}; } catch { /* registry table not present */ }
    const labels = new Map<string, { label_en: string | null; label_te: string | null }>();
    const qtext = new Map<string, { text_en: string | null; text_te: string | null }>();
    try {
      for (const o of sdb().prepare("SELECT o.* FROM survey_options o JOIN survey_questions q ON q.id = o.question_id WHERE q.survey_id = ?").all(id) as Record<string, unknown>[]) labels.set(String(o.id), { label_en: (o.label_en as string) ?? null, label_te: (o.label_te as string) ?? null });
      for (const q of sdb().prepare("SELECT * FROM survey_questions WHERE survey_id = ?").all(id) as Record<string, unknown>[]) qtext.set(String(q.id), { text_en: (q.text_en as string) ?? null, text_te: (q.text_te as string) ?? null });
    } catch { /* optional */ }
    const units = s.scope.units as Record<string, string[] | undefined>;
    const effective = s.status === "open" && s.closes_at <= registryNow().toISOString() ? "closed" : s.status;
    return {
      id: s.id, state: s.scope.state, topic_class: s.topic_class, election_choice: !!title.election_choice || s.topic_class === "election_choice", status: effective,
      closes_at: s.closes_at, closed_at: title.closed_at ?? null, title_en: title.title_en ?? null, title_te: title.title_te ?? null,
      scope_level: levelOfScope(units),
      questions: s.questions.map((q) => ({
        id: q.id, kind: q.kind, ...(qtext.get(q.id) ?? {}),
        options: (q.kind === "scale5" ? ["1", "2", "3", "4", "5", ...q.options] : q.options).map((oid) => ({ id: oid, ...(labels.get(oid) ?? {}) })),
      })),
    };
  },
  responses(id) {
    const out: FigureResponse[] = [];
    for (const [table, channel] of [["survey_response", "app"], ["survey_response_assisted", "assisted"]] as const) {
      for (const r of sdb().prepare(`SELECT answers, age_band, gender, tier, quality, mandal FROM ${table} WHERE survey_id = ?`).all(id) as Record<string, string>[]) {
        let answers: Record<string, unknown> = {};
        try { answers = JSON.parse(r.answers); } catch { /* skip malformed */ }
        out.push({ answers, channel, strata: { age_band: r.age_band, gender: r.gender, tier: r.tier, mandal: r.mandal }, risk: r.quality === "low" ? "high" : r.quality === "normal" ? "low" : null });
      }
    }
    return out;
  },
};
const source = (): FigureSource => sourceOverride ?? dbSource;

// ---------------------------------------------------------------------------------------------
// storing and publishing
// ---------------------------------------------------------------------------------------------

export interface StoredFigures { survey_id: string; topic_class: string; state: string; snapshot: string; method: string; sha256: string; method_sha256: string; code_version: string; published_at: string }
export const getStoredFigures = (id: string): StoredFigures | null => (sdb().prepare("SELECT * FROM survey_results WHERE survey_id = ?").get(id) as unknown as StoredFigures | undefined) ?? null;

export type BuildOutcome = { status: "published" | "already_published"; sha256: string } | { status: "blocked"; reason: string; dueAt?: string } | { status: "unknown_survey" };

/**
 * Build and store the immutable snapshot of one survey now (only if its gate is open: closed, delay passed, not in a blackout for a
 * political topic). Idempotent: an existing snapshot is never changed.
 */
export function buildPublishedSnapshot(surveyId: string, now: Date = registryNow(), opts: { policy?: PublishPolicy; marginals?: MarginalsFile | null; env?: NodeJS.ProcessEnv } = {}): BuildOutcome {
  const have = getStoredFigures(surveyId);
  if (have) return { status: "already_published", sha256: have.sha256 };
  const src = source();
  const survey = src.survey(surveyId);
  if (!survey) return { status: "unknown_survey" };
  const policy = opts.policy ?? policyFromEnv(opts.env);
  const gate = publishGate({ status: survey.status, closeAt: survey.closed_at ?? survey.closes_at, topic: survey.election_choice ? "election_choice" : survey.topic_class, state: survey.state, now }, { policy, env: opts.env });
  if (!gate.ok) { const g = gate as { reason: string; dueAt?: string }; return { status: "blocked", reason: g.reason, dueAt: g.dueAt }; }
  const marginals = opts.marginals === undefined ? loadMarginals() : opts.marginals;
  const { snapshot, method } = buildSnapshotData(survey, src.responses(surveyId), { now, policy, marginals, geoPath: (r, s, levels) => geoPathFor(r, s, levels, lgdResolve) });
  const snap = stableStringify(snapshot), meth = stableStringify(method);
  const sha = sha256Hex(snap);
  runInStore("survey", () => {
    sdb().prepare("INSERT OR IGNORE INTO survey_results (survey_id, topic_class, state, snapshot, method, sha256, method_sha256, code_version, published_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(surveyId, survey.election_choice ? "election_choice" : survey.topic_class, survey.state, snap, meth, sha, sha256Hex(meth), codeVersion(opts.env), now.toISOString());
  });
  try { audit("system", "survey.figures.publish", "survey:" + surveyId, { sha256: sha }); } catch { /* audit must not break publishing */ }
  return { status: "published", sha256: sha };
}

export interface PublishDueReport { published: string[]; blocked: { id: string; reason: string }[]; waiting: number }
/** Job body: publish every closed survey whose delay has passed (never partial or live figures). */
export function publishDueSurveys(now: Date = registryNow(), opts: { env?: NodeJS.ProcessEnv; policy?: PublishPolicy; marginals?: MarginalsFile | null } = {}): PublishDueReport {
  const rep: PublishDueReport = { published: [], blocked: [], waiting: 0 };
  for (const id of source().surveyIds()) {
    if (getStoredFigures(id)) continue;
    let r: BuildOutcome;
    try { r = buildPublishedSnapshot(id, now, opts); } catch (e) { rep.blocked.push({ id, reason: "error: " + String((e as Error).message).slice(0, 120) }); continue; }
    if (r.status === "published") rep.published.push(id);
    else if (r.status === "blocked") { if (r.reason === "election_window") rep.blocked.push({ id, reason: r.reason }); else rep.waiting++; }
  }
  return rep;
}
registerJob({ name: "publishDueSurveys", intervalMs: 15 * 60_000, run: (now) => publishDueSurveys(now) });

// ---------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------

export const resultsRouter = Router();

const refuse = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { res.status(status).json({ error, ...extra }); };
const ipOf = (req: Request) => String(req.ip ?? req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");

/** ?by=<dimension>: at most ONE of geo, age_band, gender, tier (comma lists, repeats and array syntax count as several). */
export function parseBy(q: Request["query"]): { ok: true; by: string | null } | { ok: false; error: "cross_tab_not_allowed" | "unknown_dimension" } {
  const parts: string[] = [];
  for (const key of ["by", "by[]", "dimension", "dimensions", "group_by", "cross"]) {
    const v = (q as Record<string, unknown>)[key];
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) for (const p of String(x).split(",")) if (p.trim()) parts.push(p.trim().toLowerCase());
  }
  const uniq = [...new Set(parts)];
  if (uniq.length > 1) return { ok: false, error: "cross_tab_not_allowed" };
  if (!uniq.length) return { ok: true, by: null };
  return ["geo", "age_band", "gender", "tier"].includes(uniq[0]) ? { ok: true, by: uniq[0] } : { ok: false, error: "unknown_dimension" };
}

function publicState(row: StoredFigures | null, now: Date): boolean {
  if (!row) return false;
  if (isPoliticalTopic(row.topic_class) && !surveysAllowed(row.state, now)) return false; // fail closed: blackout and unknown windows
  return true;
}

function serve(req: Request, res: Response, which: "snapshot" | "method") {
  const now = registryNow();
  const by = (which === "snapshot" ? parseBy(req.query) : { ok: true, by: null }) as { ok: boolean; by?: string | null; error?: string };
  if (!by.ok) return refuse(res, 400, by.error ?? "bad_request");
  const id = String(req.params.id ?? "").slice(0, 80);
  const row = getStoredFigures(id);
  if (!publicState(row, now)) return refuse(res, 403, "not_published", { disclaimer_en: DISCLAIMER_EN, disclaimer_te: DISCLAIMER_TE });
  const budget = consumeBudget(id, { ip: ipOf(req), personId: req.person?.id ?? null }, now);
  if (!budget.ok) { res.setHeader("Retry-After", String((budget as { retryAfterSec: number }).retryAfterSec)); return refuse(res, 429, "budget_exceeded"); }
  const etag = `"${(which === "snapshot" ? row!.sha256 : row!.method_sha256).slice(0, 40)}${by.by ? "-" + by.by : ""}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=300");
  if (req.headers["if-none-match"] === etag) return void res.status(304).end();
  let body = JSON.parse(which === "snapshot" ? row!.snapshot : row!.method) as Record<string, unknown>;
  if (which === "snapshot" && by.by) {
    const dim = by.by;
    body = { ...body, one_dimension: dim, strata: (body.strata as Record<string, unknown>[]).map((s) => s.published ? { ...s, questions: (s.questions as Record<string, unknown>[]).map((q) => ({ ...q, breakdowns: { [dim]: (q.breakdowns as Record<string, unknown>)[dim] } })) } : s) };
  }
  res.json({ ...body, snapshot_sha256: row!.sha256 });
}

// copy-lint-allow: route path, not copy
resultsRouter.get("/:id/results/method", (req, res) => serve(req, res, "method"));
// copy-lint-allow: route path, not copy
resultsRouter.get("/:id/results", (req, res) => serve(req, res, "snapshot"));

void LEVELS;
