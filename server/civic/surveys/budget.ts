/**
 * Query budget for published survey figures (S-32). Figures are served from ONE immutable precomputed snapshot per survey, identical
 * for every caller, and slices are never computed per request: so a caller cannot difference a suppressed cell out of differently
 * sliced queries by construction. The budget below only limits scraping and abuse of the endpoint: per caller (hashed IP bucket and,
 * when the request is authenticated, the person) and globally, per survey per UTC day. Counters hold hashes, never IPs or person ids.
 */
import crypto from "node:crypto";
import { getStore, registerMigration } from "../core";

registerMigration("survey-results-001-budget", `
CREATE TABLE IF NOT EXISTS survey_query_budget (
  day TEXT NOT NULL, survey_id TEXT NOT NULL, bucket TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, survey_id, bucket)
);
`, "survey");

export interface BudgetLimits { perCaller: number; global: number }
export const budgetLimits = (env: NodeJS.ProcessEnv = process.env): BudgetLimits => ({
  perCaller: Math.max(1, Number(env.SURVEY_RESULTS_PER_CALLER_DAY) || 120),
  global: Math.max(1, Number(env.SURVEY_RESULTS_GLOBAL_DAY) || 50_000),
});

export interface BudgetCaller { ip?: string | null; personId?: string | null }
export type BudgetDecision = { ok: true; remaining: number } | { ok: false; scope: "caller" | "global"; retryAfterSec: number };

const day = (now: Date) => now.toISOString().slice(0, 10);
const secsToMidnight = (now: Date) => Math.max(1, Math.ceil((Date.parse(day(now) + "T00:00:00Z") + 86_400_000 - now.getTime()) / 1000));
const hash = (kind: string, v: string, d: string) => `${kind}:` + crypto.createHash("sha256").update(`${kind}|${d}|${v}`).digest("hex").slice(0, 24);

/** Pure decision from current counters. */
export function evaluateBudget(counts: { global: number; callers: number[] }, limits: BudgetLimits): "ok" | "caller" | "global" {
  if (counts.global >= limits.global) return "global";
  if (counts.callers.some((c) => c >= limits.perCaller)) return "caller";
  return "ok";
}

/** Count one query for (survey, caller); refuses (without counting) when a budget is spent. Never throws on its own bookkeeping. */
export function consumeBudget(surveyId: string, caller: BudgetCaller, now: Date = new Date(), limits: BudgetLimits = budgetLimits()): BudgetDecision {
  const db = getStore("survey");
  const d = day(now);
  const buckets = ["global"];
  if (caller.ip) buckets.push(hash("ip", caller.ip, d));
  if (caller.personId) buckets.push(hash("person", caller.personId, d));
  const get = db.prepare("SELECT n FROM survey_query_budget WHERE day = ? AND survey_id = ? AND bucket = ?");
  const cur = buckets.map((b) => (get.get(d, surveyId, b) as { n: number } | undefined)?.n ?? 0);
  const verdict = evaluateBudget({ global: cur[0], callers: cur.slice(1) }, limits);
  if (verdict !== "ok") return { ok: false, scope: verdict, retryAfterSec: secsToMidnight(now) };
  const up = db.prepare("INSERT INTO survey_query_budget (day, survey_id, bucket, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, survey_id, bucket) DO UPDATE SET n = n + 1");
  for (const b of buckets) up.run(d, surveyId, b);
  db.prepare("DELETE FROM survey_query_budget WHERE day < ?").run(day(new Date(now.getTime() - 3 * 86_400_000)));
  return { ok: true, remaining: Math.max(0, limits.perCaller - Math.max(...cur.slice(1), 0) - 1) };
}
