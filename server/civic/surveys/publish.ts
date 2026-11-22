/**
 * Pulse Survey publishing rules (S-32, DESIGN_2028 3.3). PURE functions: no database, no clock, no globals except the explicit
 * `policy` / `env` arguments, so every rule is unit- and property-tested without storage.
 *
 *  1. Fixed geographic partition chosen at creation (state > district > mandal > village, only levels inside the survey scope).
 *  2. Minimum cell size k (default 30): a smaller cell is suppressed and rolled up into its parent (the parent figures include it).
 *  3. Complementary suppression: a hidden cell must never be derivable as "parent minus published siblings". Per parent the hidden
 *     children are padded (smallest published sibling first) until they are at least two cells whose total is at least k. A hidden
 *     cell hides its whole subtree. Property-tested on random trees.
 *  4. Minority-option rule: options below a minimum count or share are merged into "other" for that cell (never a single option alone).
 *  5. No live counts: figures exist only after close + delay (or at a fixed daily publishing hour); see publishGate.
 *  6. Election-choice / political surveys are blocked in blackout and unknown windows (server/window.ts, fail closed).
 *  7. Counts are rounded (default step 5); shares are derived from the rounded counts.
 */
import crypto from "node:crypto";
import { surveysAllowed, type Calendar } from "../../window";

export type Level = "state" | "district" | "mandal" | "village";
export const LEVELS: Level[] = ["state", "district", "mandal", "village"];

export const DISCLAIMER_EN = "Opinion survey, not an election and not a forecast.";
export const DISCLAIMER_TE = "అభిప్రాయ సర్వే మాత్రమే. ఇది ఎన్నిక కాదు, ముందస్తు అంచనా కాదు.";
export const METHOD_URL = "/methodology#surveys";
/** Words the Pulse copy must not use (DESIGN_2028 3.3 / B1). */
export const BANNED_WORDING = /\b(vot(?:e|es|ed|ing|er|ers)|ballots?|results?)\b/i;

export interface PublishPolicy {
  /** Minimum cell size k. */
  k: number;
  /** An option with fewer respondents than this in a cell is merged into "other". */
  minOptionCount: number;
  /** ...or with a smaller share than this (0 disables). */
  minOptionShare: number;
  /** Published counts are rounded to a multiple of this. */
  roundTo: number;
  /** Delay after close before figures may be published. */
  delayMs: number;
  /** When set (0-23, India time), publication waits for the next daily window at that hour. */
  windowHourIst: number | null;
}

const num = (v: string | undefined, d: number, min = 0) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= min ? n : d; };

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PublishPolicy {
  const hr = env.SURVEY_PUBLISH_WINDOW_HOUR_IST;
  const hour = hr !== undefined && hr !== "" && Number.isInteger(Number(hr)) && Number(hr) >= 0 && Number(hr) <= 23 ? Number(hr) : null;
  return {
    k: Math.max(2, Math.floor(num(env.SURVEY_MIN_CELL, 30, 2))),
    minOptionCount: Math.floor(num(env.SURVEY_MIN_OPTION_COUNT, 5, 1)),
    minOptionShare: Math.min(0.5, num(env.SURVEY_MIN_OPTION_SHARE, 0.02)),
    roundTo: Math.max(1, Math.floor(num(env.SURVEY_ROUND_TO, 5, 1))),
    delayMs: num(env.SURVEY_PUBLISH_DELAY_HOURS, 24) * 3_600_000,
    windowHourIst: hour,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. partition
// ---------------------------------------------------------------------------------------------

/**
 * The fixed partition levels of a survey: from its scope level down to `finest` (default: one level below the scope, or the scope itself
 * for a village survey). Throws when `finest` is above the scope. Chosen once at creation and never changed.
 */
export function partitionLevels(scope: Level, finest?: Level): Level[] {
  const a = LEVELS.indexOf(scope);
  if (a < 0) throw new Error(`unknown scope level ${String(scope)}`);
  const b = finest === undefined ? Math.min(a + 1, LEVELS.length - 1) : LEVELS.indexOf(finest);
  if (b < 0) throw new Error(`unknown level ${String(finest)}`);
  if (b < a) throw new Error("the finest partition level cannot be above the survey scope");
  return LEVELS.slice(a, b + 1);
}

// ---------------------------------------------------------------------------------------------
// 2-3. suppression
// ---------------------------------------------------------------------------------------------

export interface SizedNode { id: string; parent: string | null; n: number }
export interface Suppression {
  /** Every hidden node id (small cells, complementary picks, and all descendants of any hidden node). */
  hidden: Set<string>;
  small: Set<string>;
  complementary: Set<string>;
  /** False when the root itself is below k: nothing at all may be published. */
  rootPublishable: boolean;
}

/**
 * Suppress small cells and pad with complementary suppression. `nodes` must form ONE tree (exactly one node with parent null) where a
 * parent's n equals the sum of its children (cumulative counts; the builder adds an "unassigned" child so this always holds). Guarantee, for every published node P with hidden children H:
 * H is empty, or |H| >= 2 and sum(n of H) >= k, so no hidden cell is derivable as P minus its published siblings.
 */
export function suppressTree(nodes: SizedNode[], k: number): Suppression {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const kids = new Map<string, SizedNode[]>();
  let root: SizedNode | undefined;
  for (const x of nodes) {
    if (x.parent === null) { if (root) throw new Error("suppressTree: more than one root"); root = x; continue; }
    if (!byId.has(x.parent)) throw new Error(`suppressTree: node ${x.id} has an unknown parent`);
    (kids.get(x.parent) ?? kids.set(x.parent, []).get(x.parent)!).push(x);
  }
  const small = new Set<string>(), complementary = new Set<string>(), hidden = new Set<string>();
  if (!root) return { hidden, small, complementary, rootPublishable: false };
  const depth = new Map<string, number>();
  const dep = (x: SizedNode): number => { let d = depth.get(x.id); if (d === undefined) { d = x.parent === null ? 0 : dep(byId.get(x.parent)!) + 1; depth.set(x.id, d); } return d; };
  for (const x of nodes) if (x.n < k) small.add(x.id);
  // bottom-up (deepest parents first): pad each parent's hidden-children set until it is not derivable
  const parents = nodes.filter((x) => kids.has(x.id)).sort((a, b) => dep(b) - dep(a));
  for (const p of parents) {
    const ch = kids.get(p.id)!;
    const isHidden = (c: SizedNode) => small.has(c.id) || complementary.has(c.id);
    const H = ch.filter(isHidden);
    if (!H.length) continue;
    const pool = ch.filter((c) => !isHidden(c)).sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
    let sum = H.reduce((s, c) => s + c.n, 0);
    while ((H.length < 2 || sum < k) && pool.length) {
      const c = pool.shift()!;
      complementary.add(c.id); H.push(c); sum += c.n;
    }
  }
  // a hidden node hides its whole subtree
  const mark = (x: SizedNode) => { hidden.add(x.id); for (const c of kids.get(x.id) ?? []) mark(c); };
  for (const id of [...small, ...complementary]) mark(byId.get(id)!);
  return { hidden, small, complementary, rootPublishable: root.n >= k };
}

/** Independent audit used by tests and the method note: returns the problems (empty = every hidden cell is non-derivable). */
export function derivabilityProblems(nodes: SizedNode[], hidden: Set<string>, k: number): string[] {
  const out: string[] = [];
  const kids = new Map<string, SizedNode[]>();
  for (const x of nodes) if (x.parent !== null) (kids.get(x.parent) ?? kids.set(x.parent, []).get(x.parent)!).push(x);
  const byId = new Map(nodes.map((x) => [x.id, x]));
  for (const x of nodes) {
    if (hidden.has(x.id)) {
      for (const c of kids.get(x.id) ?? []) if (!hidden.has(c.id)) out.push(`${c.id} is published under hidden ${x.id}`);
      continue;
    }
    const ch = kids.get(x.id) ?? [];
    const H = ch.filter((c) => hidden.has(c.id));
    if (!H.length) continue;
    const sum = H.reduce((s, c) => s + c.n, 0);
    if (H.length === 1) out.push(`${H[0].id} is derivable from ${x.id} minus its published siblings`);
    else if (sum < k) out.push(`hidden children of ${x.id} total ${sum} < k`);
  }
  for (const x of nodes) if (!hidden.has(x.id) && x.n < k) out.push(`${x.id} is published with n ${x.n} < k`);
  void byId;
  return out;
}

// ---------------------------------------------------------------------------------------------
// 4. minority-option merge and rounding
// ---------------------------------------------------------------------------------------------

export const roundTo = (n: number, step: number): number => Math.round(n / step) * step;
const pct1 = (x: number) => Math.round(x * 1000) / 10;

export interface MergedOptions { kept: string[]; merged: string[] }
/**
 * Options below the minimum count/share (zero-count options included) go to "other". If exactly one option with respondents would
 * sit alone in "other", the next-smallest option joins it, so "other" never equals one identifiable option.
 */
export function mergeMinority(counts: Record<string, number>, order: string[], n: number, policy: Pick<PublishPolicy, "minOptionCount" | "minOptionShare">): MergedOptions {
  const merged: string[] = [];
  const keep: string[] = [];
  for (const id of order) {
    const c = counts[id] ?? 0;
    if (c < policy.minOptionCount || (policy.minOptionShare > 0 && n > 0 && c / n < policy.minOptionShare)) merged.push(id); else keep.push(id);
  }
  if (merged.filter((id) => (counts[id] ?? 0) > 0).length === 1 && keep.length > 0) {
    keep.sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0) || (a < b ? -1 : 1));
    merged.push(keep.shift()!);
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  keep.sort((a, b) => rank.get(a)! - rank.get(b)!);
  return { kept: keep, merged };
}

export interface TreeNode {
  id: string; parent: string | null; level: string;
  label_en?: string | null; label_te?: string | null;
  /** Respondents (answering this question) in this cell and below. */
  n: number; counts: Record<string, number>;
  /** Weight sums (same shape). */
  wn: number; wcounts: Record<string, number>;
}
export interface PathStep { id: string; level: string; label_en?: string | null; label_te?: string | null }
export interface AnswerRecord { path: PathStep[]; options: string[]; w: number }

/** Accumulate respondents into a tree: each record counts once at every step of its path (cumulative cells). */
export function accumulate(records: AnswerRecord[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const r of records) {
    let prev: string | null = null, key = "";
    for (const s of r.path) {
      key = key ? `${key}/${s.id}` : s.id;
      let node = map.get(key);
      if (!node) { node = { id: key, parent: prev, level: s.level, label_en: s.label_en ?? null, label_te: s.label_te ?? null, n: 0, counts: {}, wn: 0, wcounts: {} }; map.set(key, node); }
      node.n += 1; node.wn += r.w;
      for (const o of new Set(r.options)) { node.counts[o] = (node.counts[o] ?? 0) + 1; node.wcounts[o] = (node.wcounts[o] ?? 0) + r.w; }
      prev = key;
    }
  }
  return [...map.values()];
}

export interface PublishedOption { id: string; count: number; share: number }
export interface PublishedCell {
  id: string; level: string; parent: string | null; label_en: string | null; label_te: string | null;
  /** Respondents, rounded. */
  n: number;
  /** Children hidden and rolled up into this cell (their count only; which ones is never published). */
  hidden_children: number;
  unweighted: { options: PublishedOption[]; other?: { count: number; share: number } };
  weighted: { options: { id: string; share: number }[]; other?: { share: number } };
}
export interface TreeStats { cells: number; published: number; hidden_small: number; hidden_complementary: number; hidden_descendants: number; merged_cells: number }
export interface PublishedTree { published: boolean; cells: PublishedCell[]; stats: TreeStats }

/** Apply suppression, minority merge and rounding to one tree (one question, one channel stratum, one dimension). */
export function publishTree(nodes: TreeNode[], optionOrder: string[], policy: PublishPolicy): PublishedTree {
  const sup = suppressTree(nodes, policy.k);
  const stats: TreeStats = { cells: nodes.length, published: 0, hidden_small: sup.small.size, hidden_complementary: sup.complementary.size, hidden_descendants: 0, merged_cells: 0 };
  stats.hidden_descendants = sup.hidden.size - new Set([...sup.small, ...sup.complementary]).size;
  if (!sup.rootPublishable) return { published: false, cells: [], stats };
  const hiddenKids = new Map<string, number>();
  for (const x of nodes) if (x.parent !== null && sup.hidden.has(x.id) && !sup.hidden.has(x.parent)) hiddenKids.set(x.parent, (hiddenKids.get(x.parent) ?? 0) + 1);
  const cells: PublishedCell[] = [];
  for (const x of nodes) {
    if (sup.hidden.has(x.id)) continue;
    const m = mergeMinority(x.counts, optionOrder, x.n, policy);
    if (m.merged.length) stats.merged_cells++;
    const rn = roundTo(x.n, policy.roundTo);
    const opts: PublishedOption[] = m.kept.map((id) => { const c = roundTo(x.counts[id] ?? 0, policy.roundTo); return { id, count: c, share: rn > 0 ? pct1(c / rn) : 0 }; });
    const wopts = m.kept.map((id) => ({ id, share: x.wn > 0 ? pct1((x.wcounts[id] ?? 0) / x.wn) : 0 }));
    const cell: PublishedCell = {
      id: x.id, level: x.level, parent: x.parent, label_en: x.label_en ?? null, label_te: x.label_te ?? null, n: rn,
      hidden_children: hiddenKids.get(x.id) ?? 0, unweighted: { options: opts }, weighted: { options: wopts },
    };
    if (m.merged.length) {
      const oc = roundTo(m.merged.reduce((s, id) => s + (x.counts[id] ?? 0), 0), policy.roundTo);
      cell.unweighted.other = { count: oc, share: rn > 0 ? pct1(oc / rn) : 0 };
      const ow = m.merged.reduce((s, id) => s + (x.wcounts[id] ?? 0), 0);
      cell.weighted.other = { share: x.wn > 0 ? pct1(ow / x.wn) : 0 };
    }
    cells.push(cell);
    stats.published++;
  }
  return { published: true, cells, stats };
}

// ---------------------------------------------------------------------------------------------
// 5-6. when may figures exist
// ---------------------------------------------------------------------------------------------

const IST_MS = 5.5 * 3_600_000;
/** Earliest instant figures may be published: close + delay, then (if configured) the next daily window hour in India time. */
export function publishDueAt(closeAtMs: number, policy: Pick<PublishPolicy, "delayMs" | "windowHourIst">): number {
  const t = closeAtMs + policy.delayMs;
  if (policy.windowHourIst === null) return t;
  const local = t + IST_MS;
  const dayStart = Math.floor(local / 86_400_000) * 86_400_000;
  let w = dayStart + policy.windowHourIst * 3_600_000;
  if (w < local) w += 86_400_000;
  return w - IST_MS;
}

export const POLITICAL_TOPICS = ["election_choice", "political", "party", "candidate"];
export const isPoliticalTopic = (topic: string | null | undefined): boolean => POLITICAL_TOPICS.includes(String(topic ?? "").toLowerCase());

export type GateReason = "not_closed" | "cancelled" | "too_early" | "election_window";
export interface GateInput { status: string; closeAt: string | number; topic?: string | null; state: string; now: Date }
export interface GateOpts { policy?: PublishPolicy; env?: NodeJS.ProcessEnv; calendar?: Calendar | null }
export type Gate = { ok: true } | { ok: false; reason: GateReason; dueAt?: string };

/** May figures for this survey exist now? Never before close + delay; political topics only when the state's window is open (fail closed). */
export function publishGate(s: GateInput, o: GateOpts = {}): Gate {
  const policy = o.policy ?? policyFromEnv(o.env);
  if (s.status === "cancelled") return { ok: false, reason: "cancelled" };
  const close = typeof s.closeAt === "number" ? s.closeAt : Date.parse(s.closeAt);
  if (s.status !== "closed" || !Number.isFinite(close) || close > s.now.getTime()) return { ok: false, reason: "not_closed" };
  const due = publishDueAt(close, policy);
  if (s.now.getTime() < due) return { ok: false, reason: "too_early", dueAt: new Date(due).toISOString() };
  if (isPoliticalTopic(s.topic) && !surveysAllowed(s.state, s.now, { env: o.env, ...(o.calendar !== undefined ? { calendar: o.calendar } : {}) })) return { ok: false, reason: "election_window" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// helpers shared with the snapshot builder
// ---------------------------------------------------------------------------------------------

/** Deterministic JSON (sorted keys) for hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}
export const sha256Hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** Banned words found in the platform-written strings of a payload (creator-supplied question/option text is skipped by key). */
export function findBannedWording(v: unknown, skipKeys: string[] = ["text_en", "text_te", "label_en", "label_te", "name_en", "name_te"], path = "$"): string[] {
  if (typeof v === "string") return BANNED_WORDING.test(v) ? [`${path}: ${v.slice(0, 60)}`] : [];
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(v)) v.forEach((x, i) => out.push(...findBannedWording(x, skipKeys, `${path}[${i}]`)));
  else for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (BANNED_WORDING.test(k)) out.push(`${path}.${k}: (key)`);
    if (!skipKeys.includes(k)) out.push(...findBannedWording(x, skipKeys, `${path}.${k}`));
  }
  return out;
}
