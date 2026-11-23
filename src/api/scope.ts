/**
 * Client for the scoped dashboards, /api/v1/civic/scope (S-40, E2E-49; docs/ROLES.md). Every route is GET and read-only.
 * The server is the only authority on who may see what: this client never filters or widens a response.
 */
import { tokenStore } from "./civic";
import { reportShed, shedFrom, type ShedInfo } from "../lib/degraded";

const BASE = "/api/v1/civic/scope";

export interface ScopeUnit { lgd: string; level: string; name_en: string; name_te?: string | null }
export interface ScopeRole { role: string; jurisdiction: string | null; department: string | null; unit: ScopeUnit | null; scope: "unit" | "state" | "none" }
export interface ScopeCan { issues_summary: boolean; surveys_summary: boolean; audit_summary: boolean; export: boolean }
export interface ScopeMe { roles: ScopeRole[]; can: ScopeCan; read_only: boolean; early_access: boolean; individual_data: boolean; min_cell: number; notice_en: string; notice_te: string }
export interface IssueCell { department: string; total: number; open: number; resolved: number; by_status: Record<string, number>; resolution_rate: number }
export interface IssuesSummary { role: string; unit: ScopeUnit | null; department: string | null; min_cell: number; cells: IssueCell[]; masked: { department: string; reason: string }[]; total_shown: number; truncated: boolean }
export interface PublishedSurvey { survey_id: string; topic_class: string; state: string; snapshot_sha256: string; published_at: string; results_url: string; method_url: string }
export interface SurveysSummary { published: PublishedSurvey[]; early_access: boolean; note_en: string; note_te: string }
export interface AuditSummary {
  head: { seq: number; hash: string; ts: string; count: number } | null;
  anchors: { sink: string | null; last_anchor: unknown; anchor_matches_chain: boolean | null; unanchored_entries: number; chain_ok: boolean };
  jobs: { started: boolean; alarm: { kind: string; at: string } | null; jobs: { name: string; runs: number; failures: number; lastOk: boolean | null; lastRunAt: string | null }[] };
  block_log: { total: number; by_action: { action: string; n: number }[] };
  read_only: boolean;
}
export type ScopeErrorCode = "outside_scope" | "department_mismatch" | "role_required" | "read_only" | "unknown_unit" | "rate_limit" | "degraded" | "unauthenticated" | "network" | "error";

export class ScopeError extends Error {
  status: number; code: ScopeErrorCode; retryAfter?: number; shed?: ShedInfo;
  constructor(status: number, code: ScopeErrorCode, retryAfter?: number) { super(code); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

function classify(status: number, body: Record<string, unknown> | null): ScopeErrorCode {
  const code = typeof body?.code === "string" ? body.code : "";
  const err = typeof body?.error === "string" ? body.error : "";
  if (status === 401) return "unauthenticated";
  if (status === 405) return "read_only";
  if (status === 429) return "rate_limit";
  if (status === 503 && (err === "degraded" || body?.degraded === true)) return "degraded";
  if (code === "outside_scope" || code === "department_mismatch" || code === "role_required") return code;
  if (err === "unknown_unit") return "unknown_unit";
  return "error";
}

async function raw(path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const tok = tokenStore.get();
  if (tok) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { headers, cache: "no-store" }); } catch { throw new ScopeError(0, "network"); }
  if (res.ok) return res;
  let body: Record<string, unknown> | null = null;
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  const e = new ScopeError(res.status, classify(res.status, body), Number(res.headers.get("retry-after")) || Number(body?.retry_after_seconds) || undefined);
  const sh = shedFrom(res.status, body, res.headers.get("retry-after"));
  if (sh) { e.shed = sh; reportShed(sh); }
  throw e;
}
const json = async <T,>(path: string): Promise<T> => (await raw(path)).json() as Promise<T>;

export const scopeApi = {
  me: () => json<ScopeMe>("/me"),
  issues: (unit?: string, department?: string) => {
    const q = new URLSearchParams();
    if (unit) q.set("unit", unit);
    if (department) q.set("department", department);
    const s = q.toString();
    return json<IssuesSummary>(`/issues/summary${s ? `?${s}` : ""}`);
  },
  surveys: () => json<SurveysSummary>("/surveys/summary"),
  audit: () => json<AuditSummary>("/audit/summary"),
  /** One export part as a Blob (identical bytes to the public export). `nextCursor` is null on the last part. */
  exportPart: async (format: "ndjson" | "csv", cursor?: string): Promise<{ blob: Blob; nextCursor: string | null; filename: string }> => {
    const q = new URLSearchParams({ format });
    if (cursor) q.set("cursor", cursor);
    const res = await raw(`/export?${q.toString()}`);
    return { blob: await res.blob(), nextCursor: res.headers.get("x-next-cursor"), filename: `issues.${format}` };
  },
  /** Village search for the unit picker (public geo route). The server decides whether the picked unit is inside the caller's scope. */
  searchUnits: async (q: string): Promise<{ lgd: string; nameEn: string; nameTe?: string; path: string[] }[]> => {
    const res = await fetch(`/api/v1/civic/geo/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { results?: { village: { lgd: string; name_en: string; name_te: string | null }; path: string[] }[] };
    return (j.results ?? []).map((h) => ({ lgd: h.village.lgd, nameEn: h.village.name_en, nameTe: h.village.name_te ?? undefined, path: h.path }));
  },
};
