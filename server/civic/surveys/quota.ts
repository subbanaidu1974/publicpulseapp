/**
 * Equal-access creation quotas (DESIGN_2028 3.3, decision A2). Counted when a survey is first SUBMITTED to review, over a rolling
 * window, per organisation key: every party has the same limit under the same rule, so one party at its limit never affects another.
 */
import { getStore } from "../core";
import { surveyPolicy } from "./types";
import type { OrgKind, TopicClass } from "./types";

export interface QuotaStatus { allowed: boolean; limit: number | null; used: number; remaining: number | null; resets_at: string | null; key: string; quota_class: string; reason?: string }

export const quotaClassOf = (topic: TopicClass): string => surveyPolicy().quota.count_as[topic] ?? topic;

export function quotaKey(kind: OrgKind, orgCode: string | null, department: string | null, creatorPseudonym: string): string {
  const per = surveyPolicy().quota.kinds[kind]?.per ?? "creator";
  if (per === "org_code") return (orgCode ?? "").toUpperCase();
  if (per === "department") return (department ?? "").toLowerCase();
  return creatorPseudonym;
}

export function quotaStatus(kind: OrgKind, key: string, topic: TopicClass, now: Date): QuotaStatus {
  const p = surveyPolicy();
  const rule = p.quota.kinds[kind];
  const cls = quotaClassOf(topic);
  const base = { key, quota_class: cls, used: 0, remaining: null as number | null, resets_at: null as string | null, limit: null as number | null };
  if (!rule || !rule.allowed.includes(topic)) return { ...base, allowed: false, reason: "topic_not_allowed_for_org" };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(rule.limits, k);
  const useTotal = !has(cls) && has("*");
  const limit = has(cls) ? rule.limits[cls] : has("*") ? rule.limits["*"] : null;
  if (limit === null || limit === undefined) return { ...base, allowed: true };
  const since = new Date(now.getTime() - p.quota.window_days * 86_400_000).toISOString();
  const rows = (useTotal
    ? getStore("survey").prepare("SELECT at FROM survey_quota_events WHERE org_kind = ? AND quota_key = ? AND at > ? ORDER BY at ASC").all(kind, key, since)
    : getStore("survey").prepare("SELECT at FROM survey_quota_events WHERE org_kind = ? AND quota_key = ? AND quota_class = ? AND at > ? ORDER BY at ASC").all(kind, key, cls, since)) as unknown as { at: string }[];
  const used = rows.length;
  const resets = rows.length ? new Date(new Date(rows[0].at).getTime() + p.quota.window_days * 86_400_000).toISOString() : null;
  return { ...base, limit, used, remaining: Math.max(0, limit - used), resets_at: used >= limit ? resets : null, allowed: used < limit };
}

/** Record the consumption (idempotent per survey: a survey returned to draft and resubmitted is not counted twice). */
export function consumeQuota(surveyId: string, kind: OrgKind, key: string, topic: TopicClass, now: Date): void {
  getStore("survey").prepare("INSERT OR IGNORE INTO survey_quota_events (survey_id, org_kind, quota_key, quota_class, at) VALUES (?,?,?,?,?)")
    .run(surveyId, kind, key, quotaClassOf(topic), now.toISOString());
}

export const hasConsumed = (surveyId: string): boolean => !!getStore("survey").prepare("SELECT 1 AS x FROM survey_quota_events WHERE survey_id = ?").get(surveyId);
