/**
 * Typed client for the Pulse Survey routes (/api/v1/civic/surveys): registry, credential, response, published figures, creator and panel.
 * Error shape from the server: `{ error, code, ...extras }`. Authenticated calls use the civic session token (sessionStorage).
 *
 * The respond call (`respondAnonymously`) is deliberately separate: no Authorization header and credentials "omit", so the request
 * carries nothing that identifies the person (a test asserts this).
 */
import { CivicApiError, tokenStore } from "./civic";

const BASE = "/api/v1/civic/surveys";

export type SurveyStatus = "draft" | "in_review" | "approved" | "open" | "closed" | "cancelled";
export type TopicClass = "issue_service" | "bill" | "political" | "election_choice";
export interface Scope { state: string; units: Record<string, string[] | undefined> }
export interface Creator { org_kind: string; org_code: string | null; department: string | null }
export interface Cancellation { reason_code: string; reason_text: string; at: string }
export interface SurveySummary {
  id: string; status: SurveyStatus; topic_class: TopicClass; election_choice: boolean; title_en: string; title_te: string | null;
  creator: Creator; scope: Scope; opens_at: string; closes_at: string; registered_at: string | null; approved_at: string | null; opened_at: string | null; closed_at: string | null;
  version: number; wording_hash: string; hidden_reason: "election_window" | null; cancellation: Cancellation | null; disclaimer_en: string; disclaimer_te: string;
}
export interface OptionDto { id: string; ord: number; label_en: string; label_te: string | null; prefer_not: boolean }
export interface QuestionDto { id: string; ord: number; kind: "single" | "multi" | "scale5"; max_select: number | null; text_en: string; text_te: string | null; options: OptionDto[] }
export interface PanelDecision { version: number; wording_hash: string; decision: "approve" | "reject"; notes: string | null; at: string; current: boolean }
export interface PanelSummary { required_approvals: number; approvals: number; rejections: number; decisions: PanelDecision[] }
export interface Finding { code: string; severity: "block" | "warn"; where: string; text: string }
export interface SurveyDetail extends SurveySummary {
  questions: QuestionDto[]; versions: { version: number; wording_hash: string; registered_at: string }[]; panel: PanelSummary; findings?: Finding[];
}
export interface LogEntry { seq: number; survey_id: string; kind: string; at: string; detail: Record<string, unknown> }
export interface QuotaState { org_kind: string; org_code: string | null; department: string | null; window_days: number; allowed: boolean; limit: number | null; used: number; remaining: number | null; resets_at: string | null; reason?: string }
/** Flat on purpose (the project compiles without strictNullChecks, where a boolean-discriminated union does not narrow). */
export interface Eligibility { eligible: boolean; key_class?: string; tier?: string; quality?: string; mandal?: string | null; channel?: string; secrecy?: string; code?: string; message?: string; eligible_from?: string }
export interface DraftInput {
  topic_class: TopicClass; title_en: string; title_te: string; scope: Scope; opens_at: string; closes_at: string; asks_party_preference?: boolean;
  org_kind?: string; org_code?: string;
  questions: { kind: "single" | "multi" | "scale5"; text_en: string; text_te: string; max_select?: number | null; options: { label_en: string; label_te: string; prefer_not?: boolean }[] }[];
}
export interface DraftSaved { id: string; status: string; version: number; wording_hash: string; findings: Finding[] }

// ---- figures (published snapshot) ----
export interface FigOption { id: string; count: number; share: number }
export interface FigCell {
  id: string; level: string; parent: string | null; label_en: string | null; label_te: string | null; n: number; hidden_children: number;
  unweighted: { options: FigOption[]; other?: { count: number; share: number } };
  weighted: { options: { id: string; share: number }[]; other?: { share: number } };
}
export interface FigQuestion { id: string; kind: string; text_en: string | null; text_te: string | null; options: { id: string; label_en: string | null; label_te: string | null }[]; breakdowns: Record<string, FigCell[]> }
export interface FigStratum {
  channel: "app" | "assisted"; published: boolean; reason?: string; platform_linkable?: boolean; label_en?: string; n?: number;
  sampling?: { margin_of_error: number | null; effective_n: number; design_effect: number; coverage_warning_en?: string; coverage_warning_te?: string; note_en?: string; note_te?: string };
  weighting?: { applied: boolean; dimensions: string[]; cap: number; note_en?: string };
  quality?: { score: number; partial: boolean; components: { key: string; weight: number; value: number | null; available: boolean }[]; skew_index?: number | null };
  questions?: FigQuestion[];
}
export interface Figures {
  survey: { id: string; title_en: string | null; title_te: string | null; topic_class: string; state: string; closes_at: string }; published_at: string; disclaimer_en: string; disclaimer_te: string;
  method_url: string; code_version: string; partition: { levels: string[]; minimum_cell_size: number; counts_rounded_to: number }; one_dimension?: string; has_published_figures: boolean; snapshot_sha256: string; strata: FigStratum[];
}
export interface FigMethod {
  policy: Record<string, unknown>; marginals_file_loaded: boolean; code_version: string;
  strata: { channel: string; quality: { score: number; partial: boolean; formula?: string; components: { key: string; weight: number; value: number | null; available: boolean; note?: string }[] };
    weights: { applied: boolean; dimensions_used: { dimension: string; source?: string; as_of?: string; weighted?: boolean }[]; dimensions_skipped: { dimension: string; reason: string }[]; cap: number; residual_gap_pp?: number | null; design_effect?: number; effective_n?: number };
    suppression: { k: number } }[];
}

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const tok = tokenStore.get();
  if (tok && init.auth !== false) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { method: init.method ?? "GET", headers, cache: "no-cache", // the server allows 15 s of caching; revalidate so a status change shows at once
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined }); }
  catch { throw new CivicApiError("network", 0, "network"); }
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
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

export interface ListParams { include_hidden?: string; status?: string; topic?: string; state?: string; q?: string; cursor?: string; limit?: number }

export const surveysApi = {
  list: (p: ListParams = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return call<{ surveys: SurveySummary[]; next_cursor: string | null; disclaimer_en: string; disclaimer_te: string }>(`?${qs}`, { auth: false });
  },
  log: (after = 0, limit = 50) => call<{ entries: LogEntry[]; next_after: number | null; disclaimer_en: string; disclaimer_te: string }>(`/registry/log?after=${after}&limit=${limit}`, { auth: false }),
  get: (id: string) => call<SurveyDetail>(`/${encodeURIComponent(id)}`, { auth: false }),
  version: (id: string, n: number) => call<{ version: number; wording_hash: string; registered_at: string; wording: { title_en: string; title_te: string | null; questions: { kind: string; text_en: string; text_te: string | null; options: { label_en: string; label_te: string | null; prefer_not: boolean }[] }[] } }>(`/${encodeURIComponent(id)}/versions/${n}`, { auth: false }),

  // creator
  mine: () => call<{ surveys: SurveyDetail[] }>("/mine"),
  quota: (topic: TopicClass, org?: { org_kind?: string; org_code?: string }) => {
    const qs = new URLSearchParams({ topic_class: topic });
    if (org?.org_kind) qs.set("org_kind", org.org_kind);
    if (org?.org_code) qs.set("org_code", org.org_code);
    return call<QuotaState>(`/quota?${qs}`);
  },
  create: (d: DraftInput) => call<DraftSaved>("", { method: "POST", body: d }),
  update: (id: string, d: DraftInput) => call<DraftSaved>(`/${encodeURIComponent(id)}`, { method: "PATCH", body: d }),
  submit: (id: string) => call<{ id: string; status: string; warnings: Finding[] }>(`/${encodeURIComponent(id)}/submit`, { method: "POST", body: {} }),
  open: (id: string) => call<{ id: string; status: string }>(`/${encodeURIComponent(id)}/open`, { method: "POST", body: {} }),
  close: (id: string) => call<{ id: string; status: string }>(`/${encodeURIComponent(id)}/close`, { method: "POST", body: {} }),
  cancel: (id: string, reason_code: string, reason_text: string) => call<{ id: string; status: string }>(`/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason_code, reason_text } }),
  review: (id: string, decision: "approve" | "reject", notes: string) => call<{ id: string; status: string; panel: PanelSummary }>(`/${encodeURIComponent(id)}/panel/review`, { method: "POST", body: { decision, notes } }),

  // credential (authenticated)
  eligibility: (id: string) => call<Eligibility>(`/${encodeURIComponent(id)}/credential/eligibility`),
  credentialKey: (id: string, keyClass: string) => call<{ key_class: string; bits: number; key: { n: string; e: string }; wording_hash: string }>(`/${encodeURIComponent(id)}/credential/key?class=${encodeURIComponent(keyClass)}`, { auth: false }),
  requestCredential: (id: string, body: { blinded: string; nonce: string; key_class: string }) => call<{ blind_signature: string; key_class: string; replayed: boolean }>(`/${encodeURIComponent(id)}/credential/request`, { method: "POST", body }),

  /** Redeem the credential: NO bearer token, NO cookies. The server reads nothing about the caller on this route. */
  async respondAnonymously(id: string, body: { token: string; prefix: string; signature: string; answers: Record<string, string | string[] | number>; strata: { age_band: string; gender: string; mandal: string } }): Promise<{ ok: boolean }> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/${encodeURIComponent(id)}/respond`, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch { throw new CivicApiError("network", 0, "network"); }
    return parse<{ ok: boolean }>(res);
  },

  // published figures (public, one dimension at a time)
  figures: (id: string, by: "geo" | "age_band" | "gender" | "tier") => call<Figures>(`/${encodeURIComponent(id)}/results?by=${by}`, { auth: false }),
  figuresMethod: (id: string) => call<FigMethod>(`/${encodeURIComponent(id)}/results/method`, { auth: false }),
};
