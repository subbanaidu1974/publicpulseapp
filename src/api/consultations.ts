/**
 * Typed client for the bill-consultation routes (/api/v1/civic/consultations), see docs/CONSULTATIONS.md.
 * Error shape from the server: `{ error, code, ...extras }`. Authenticated calls use the civic session token (sessionStorage).
 * Reads are public; only feedback, the caller's own feedback list and the department/panel routes send the token.
 */
import { CivicApiError, tokenStore } from "./civic";

const BASE = "/api/v1/civic/consultations";

export type ConsStatus = "draft" | "in_review" | "approved" | "open" | "closed" | "completed";
export type AudioStatus = "placeholder" | "recorded" | "reviewed";
export type StanceId = "support" | "support_changes" | "oppose" | "unclear" | "prefer_not";
export interface Scope { state: string; units: Record<string, string[] | undefined> }
export interface AudioRef { group: string; file_id: string | null; duration_s: number; status: AudioStatus }
export interface Clause { n: number; original_text: string | null; original_ref: string | null; summary_en: string; summary_te: string; audio: AudioRef[] }
export interface ClosingState { status: "published" | "pending" | "not_due"; due_at: string | null; overdue: boolean }
export interface ConsSummary {
  id: string; status: ConsStatus; department: string; title_en: string; title_te: string | null; bill_ref: string; source_url: string; scope: Scope;
  opens_at: string; closes_at: string; registered_at: string | null; approved_at: string | null; published_at: string | null; closed_at: string | null; completed_at: string | null;
  version: number; content_hash: string; closing_report: ClosingState; disclaimer_en: string; disclaimer_te: string;
  /** Present on list items (GET /consultations) so a card needs no detail fetch; the detail carries `affected_groups` and `clauses` itself. */
  affected_groups?: string[]; clause_count?: number;
}
export interface VersionRow { version: number; content_hash: string; note_en: string | null; note_te: string | null; created_at: string }
export interface PanelDecision { version: number; content_hash: string; decision: "approve" | "reject"; notes: string | null; at: string; current: boolean }
export interface PanelSummary { required_approvals: number; approvals: number; rejections: number; decisions: PanelDecision[] }
export interface Finding { code: string; severity: "block" | "warn"; where: string; text: string }
export interface StanceDef { id: StanceId; en: string; te: string }
export interface ConsDetail extends ConsSummary { affected_groups: string[]; clauses: Clause[]; versions: VersionRow[]; panel: PanelSummary; stances: StanceDef[]; findings?: Finding[] }
export interface LogEntry { seq: number; kind: string; at: string; detail: Record<string, unknown> }

export interface MineFeedback { clause: number; stance: StanceId; comment: string | null; public_ok: boolean; comment_status: "none" | "ok" | "held"; created_at: string; updated_at: string; edits: number }
export interface Mine { consultation_id: string; editable_until: string; eligible: boolean; ineligible: { code: string; message: string } | null; feedback: MineFeedback[] }
export interface FeedbackSaved { clause: number; stance: StanceId; edited: boolean; comment_status: "none" | "ok" | "held"; comment_public: boolean }

export interface FigStance { id: string; count: number; share: number }
export interface FigClause { clause: number; published: boolean; participants: number | null; stances: FigStance[]; other: { count: number; share: number } | null; suppressed_reason: string | null }
export interface Participation { participants: number | null; suppressed: string | null; by_tier: { tier: string; participants: number }[] | null; by_tier_suppressed: string | null; min_cell: number; rounded_to: number }
export interface Figures {
  published: true; consultation_id: string; version: number; content_hash: string; participation: Participation; clauses: FigClause[];
  weighted: { applied: boolean; reason: string }; counting_rule: string; method_note: string; disclaimer_en: string; disclaimer_te: string;
}
export interface PublicComment { ref: string; clause: number; stance: string; comment: string; location: { level: string; name_en: string | null; name_te: string | null } | null; flag: "near_duplicate" | null; cluster_size: number | null }

export interface Theme { label_en: string; label_te: string | null; source: "human" | "reviewer"; by: string }
export interface Coverage { comments_total: number; reviewed_by_human: number; machine_summarised: number; unreviewed: number; machine_assisted: boolean; method: string; human_reviewer_roles: { role: string; comments_read: number }[]; machine_methods: { method: string; comments_summarised: number }[] }
export interface Astroturf {
  clusters: { clause: number; size: number; flagged: boolean; first_at: string; last_at: string; span_seconds: number }[]; flagged_clusters: number;
  bursts: { minute: string; feedback_in_minute: number }[]; burst_threshold_per_minute: number; peak_per_minute: number; rate_limited_requests: number;
  cluster_similarity_threshold: number; cluster_flag_min: number; counting_rule: string;
}
export interface DeptResponse { kind: "response" | "no_change"; text_en: string; text_te: string | null; at: string }
export interface ReportClause { n: number; summary_en: string; summary_te: string; figures: FigClause | null; themes: Theme[]; department_response: DeptResponse | null }
export interface ReportSnapshot {
  consultation: { id: string; department: string; title_en: string; title_te: string | null; bill_ref: string; source_url: string; version: number; content_hash: string; opens_at: string; closes_at: string; closed_at: string | null };
  built_at: string; participation: Participation | null; clauses: ReportClause[]; themes: Theme[]; anti_astroturf: Astroturf; review_coverage: Coverage; method_note: string | null; signal_not_referendum: boolean;
}
export interface ClosingReport { report: ReportSnapshot; snapshot_hash: string; published_at: string; hash_algorithm: string; disclaimer_en: string; disclaimer_te: string }
export interface Missing { code: string; clauses?: number[] }
export interface Analyst {
  consultation_id: string; flags: Astroturf; clusters: { clause: number; size: number; flagged: boolean; first_at: string; last_at: string; span_seconds: number; representative: { feedback_id: string; text: string | null } }[];
  coverage: Coverage; suggested_sample: { representatives: string[]; random: string[]; target: number };
  themes: { id: string; clause_n: number | null; label_en: string; label_te: string | null; source: string; author_role: string }[];
}
export interface ClauseDiff { clause: number; field: "original_text" | "original_ref" | "summary_en" | "summary_te" | "audio"; before: unknown; after: unknown }
export interface CorrectionRow { id: string; from_version: number; to_version: number; content_hash: string; status: "pending" | "applied" | "rejected"; reason_en: string; reason_te: string | null; created_at: string; decided_at: string | null; approvals: number; rejections: number; diff: ClauseDiff[] }
export interface HeldComment { feedback_id: string; clause: number; stance: string; comment: string; reasons: string[]; public_ok: boolean; created_at: string; updated_at: string }
export type ModerationDecision = "release" | "reject" | "keep_held";
export interface ReportPreview { snapshot: ReportSnapshot; missing: Missing[]; closing_report: ClosingState }

export interface ClauseInput { original_text?: string; original_ref?: string; summary_en: string; summary_te: string; audio?: { group: string; file_id?: string | null; duration_s: number; status: "placeholder" | "recorded" }[] }
export interface DraftInput { title_en: string; title_te: string; department?: string; bill_ref: string; source_url: string; scope: Scope; opens_at: string; closes_at: string; affected_groups: string[]; clauses: ClauseInput[] }
export interface DraftSaved { id: string; status: string; version: number; content_hash: string; findings: Finding[]; department?: string }

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const tok = tokenStore.get();
  if (tok && init.auth !== false) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { method: init.method ?? "GET", headers, cache: "no-cache", body: init.body !== undefined ? JSON.stringify(init.body) : undefined }); }
  catch { throw new CivicApiError("network", 0, "network"); }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const b = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : typeof b.error === "string" ? b.error : "error";
    const e = new CivicApiError(code, res.status, code);
    e.body = b;
    const ra = res.headers.get("retry-after");
    if (ra) e.body.retry_after = Number(ra);
    throw e;
  }
  return data as T;
}

export const errorCode = (e: unknown): string => (e instanceof CivicApiError ? (typeof e.body.code === "string" ? e.body.code : e.code) : "");
export const errStatus = (e: unknown): number => (e instanceof CivicApiError ? e.status : -1);
export const errBody = (e: unknown): Record<string, unknown> => (e instanceof CivicApiError ? e.body : {});

export interface ListParams { status?: string; department?: string; state?: string; q?: string; overdue?: string; cursor?: string; limit?: number }
const id_ = encodeURIComponent;

export const consApi = {
  list: (p: ListParams = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return call<{ consultations: ConsSummary[]; next_cursor: string | null; disclaimer_en: string; disclaimer_te: string }>(`?${qs}`, { auth: false });
  },
  get: (id: string) => call<ConsDetail>(`/${id_(id)}`, { auth: false }),
  log: (id: string) => call<{ entries: LogEntry[]; next_after: number | null }>(`/${id_(id)}/log?limit=200`, { auth: false }),
  version: (id: string, n: number) => call<{ version: number; content_hash: string; created_at: string; note_en: string | null; note_te: string | null; hash_algorithm: string; content: { clauses: Clause[]; title_en: string } }>(`/${id_(id)}/versions/${n}`, { auth: false }),

  // participant
  mine: (id: string) => call<Mine>(`/${id_(id)}/mine`),
  feedback: (id: string, body: { clause: number; stance: StanceId; comment?: string; public_ok?: boolean }) => call<FeedbackSaved>(`/${id_(id)}/feedback`, { method: "POST", body }),
  figures: (id: string) => call<Figures>(`/${id_(id)}/figures`, { auth: false }),
  comments: (id: string, clause?: number) => call<{ comments: PublicComment[]; total: number; next_offset: number | null; note: string }>(`/${id_(id)}/comments?limit=100${clause ? `&clause=${clause}` : ""}`, { auth: false }),
  closingReport: (id: string) => call<ClosingReport>(`/${id_(id)}/closing-report`, { auth: false }),

  // department
  mineDept: () => call<{ consultations: ConsDetail[] }>("/mine"),
  create: (d: DraftInput) => call<DraftSaved>("", { method: "POST", body: d }),
  update: (id: string, d: DraftInput) => call<DraftSaved>(`/${id_(id)}`, { method: "PATCH", body: d }),
  submit: (id: string) => call<{ id: string; status: string; warnings: Finding[] }>(`/${id_(id)}/submit`, { method: "POST", body: {} }),
  publish: (id: string) => call<{ id: string; status: string }>(`/${id_(id)}/publish`, { method: "POST", body: {} }),
  close: (id: string) => call<{ id: string; status: string }>(`/${id_(id)}/close`, { method: "POST", body: {} }),
  complete: (id: string) => call<{ id: string; status: string }>(`/${id_(id)}/complete`, { method: "POST", body: {} }),
  correct: (id: string, body: { reason_en: string; reason_te?: string; clauses: { n: number; summary_en?: string; summary_te?: string }[] }) =>
    call<{ id: string; to_version: number; content_hash: string; status: string; findings: Finding[] }>(`/${id_(id)}/corrections`, { method: "POST", body }),

  // panel
  review: (id: string, decision: "approve" | "reject", notes: string, correction_id?: string) =>
    call<{ id: string; result: string; panel: PanelSummary }>(`/${id_(id)}/panel/review`, { method: "POST", body: { decision, notes, ...(correction_id ? { correction_id } : {}) } }),
  reviewAudio: (id: string, clause: number, group: string) => call<{ ok: boolean }>(`/${id_(id)}/audio/review`, { method: "POST", body: { clause, group } }),

  /** Pending (default) or all corrections of one consultation with ids and per-clause diffs; staff of the consultation only. */
  corrections: (id: string, status?: "pending" | "applied" | "rejected") => call<{ consultation_id: string; current_version: number; corrections: CorrectionRow[] }>(`/${id_(id)}/corrections${status ? `?status=${status}` : ""}`),
  /** Raw audio body (the server sniffs the type). The recording must already be on the clause (group + file id). */
  uploadAudio: async (id: string, clause: number, group: string, file: Blob): Promise<{ ok: boolean; mime: string; bytes: number; sha256: string }> => {
    const headers: Record<string, string> = { "content-type": file.type || "application/octet-stream" };
    const tok = tokenStore.get();
    if (tok) headers.authorization = `Bearer ${tok}`;
    let res: Response;
    try { res = await fetch(`${BASE}/${id_(id)}/audio/upload?clause=${clause}&group=${encodeURIComponent(group)}`, { method: "POST", headers, body: file }); }
    catch { throw new CivicApiError("network", 0, "network"); }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) { const code = typeof data.code === "string" ? data.code : "error"; const e = new CivicApiError(code, res.status, code); e.body = data; throw e; }
    return data as { ok: boolean; mime: string; bytes: number; sha256: string };
  },

  // moderation
  held: (id: string, status?: "rejected") => call<{ consultation_id: string; status: string; comments: HeldComment[] }>(`/${id_(id)}/comments/held${status ? `?status=${status}` : ""}`),
  moderate: (id: string, feedbackId: string, decision: ModerationDecision) => call<{ ok: boolean; decision: string }>(`/${id_(id)}/comments/${id_(feedbackId)}/moderate`, { method: "POST", body: { decision } }),

  // closing
  analyst: (id: string) => call<Analyst>(`/${id_(id)}/analyst`),
  readComments: (id: string, ids: string[]) => call<{ recorded: number; coverage: Coverage }>(`/${id_(id)}/review/comments`, { method: "POST", body: { feedback_ids: ids } }),
  runReviewer: (id: string) => call<{ reviewer: string; kind: string; summarised: number; themes: number; note?: string; coverage: Coverage }>(`/${id_(id)}/review/run`, { method: "POST", body: {} }),
  addTheme: (id: string, body: { label_en: string; label_te?: string; clause?: number }) => call<{ id: string }>(`/${id_(id)}/themes`, { method: "POST", body }),
  preview: (id: string) => call<ReportPreview>(`/${id_(id)}/closing-report/preview`),
  respond: (id: string, body: { clause: number; kind: "response" | "no_change"; text_en: string; text_te?: string }) => call<{ ok: boolean }>(`/${id_(id)}/closing-report/responses`, { method: "POST", body }),
  publishReport: (id: string) => call<{ id: string; published: boolean; snapshot_hash: string }>(`/${id_(id)}/closing-report/publish`, { method: "POST", body: {} }),
};
