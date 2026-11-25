/** Typed client for /api/v1/civic/notify (government notifications, S-37..S-39). Shapes follow docs/NOTIFICATIONS.md. The session token comes from tokenStore only. */
import { CivicApiError, tokenStore } from "./civic";
import type { AssertionDto, AssertionOptionsDto, RegistrationCredentialDto, RegistrationOptionsDto } from "../lib/webauthn";

const BASE = "/api/v1/civic/notify";

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean; totp?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const tok = tokenStore.get();
  if (tok && init.auth !== false) headers.authorization = `Bearer ${tok}`;
  if (init.totp) headers["x-totp-code"] = init.totp;
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { method: init.method ?? "GET", headers, cache: "no-cache", body: init.body !== undefined ? JSON.stringify(init.body) : undefined }); } catch { throw new CivicApiError("network", 0, "network"); }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const b = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : typeof b.error === "string" ? b.error : "error";
    const ce = new CivicApiError(typeof b.error === "string" ? b.error : code, res.status, code);
    ce.body = b;
    throw ce;
  }
  return data as T;
}
const get = <T,>(p: string, auth = true) => call<T>(p, { auth });
const post = <T,>(p: string, body: unknown = {}, totp?: string) => call<T>(p, { method: "POST", body, totp });

export type Bi = { en: string; te: string };
export interface NotifyPolicy {
  categories: string[]; category_labels: Record<string, Bi>; caps: Record<string, { daily: number; weekly: number }>;
  quiet_hours_default: { start: string; end: string; timezone: string; bypass: string[] };
  declaration: { text_en: string; text_te: string; min_reason_chars: number };
  limits: { title_chars: number; text_chars: number; slot_chars: number; antiphish_min: number; antiphish_max: number; message_ttl_hours: number; max_audience: number };
  allowed_link_domains: string[]; org_kinds: Record<string, { categories: string[]; sender_roles: string[] }>;
}
export interface Template { id: string; category: string; text_en: string; text_te: string; slots: Record<string, { max: number }>; cleared: boolean; cleared_by: string | null; cleared_on: string | null; example?: boolean; source?: string }
export interface PublicOrg { id: string; name: string; kind: string }
export interface SentMessage { id: string; category: string; title_en: string; title_te: string; text_en: string; text_te: string; sent_at: string; signature: string; key_id: string; declaration: { accepted: boolean; reason: string } | null; mcc_window: string | null }
export interface SenderLog { org: { id: string; name: string; kind: string; status: string }; messages: SentMessage[] }
export interface BlockEntry { id: number; time_bucket: string; sender_org: string; category: string; reason_code: string }
export interface PublishedKey { key_id: string; version: number; alg: string; public_key: string; spki: string }
export interface Prefs { categories: Record<string, { opted_in: boolean; locked: boolean }>; quiet_hours: { start: string; end: string; default: boolean }; language: "te" | "en"; sms_ok: boolean; email_ok: boolean; has_email: boolean; push_blocked: boolean; antiphish_set: boolean }
export interface InboxItem { id: string; message_id: string; category: string; sender: { org_id: string; name: string }; title: string; text: string; title_en?: string; title_te?: string; text_en?: string; text_te?: string; sent_at: string; delivered_at?: string; read: boolean; antiphish_word: string | null; signature?: string; key_id?: string; signed_payload?: string; channels?: string[] }
export interface SenderMe { person_id: string; senders: { sender_id: string; role: string; status: string; org: { id: string; name: string; kind: string; status: string } }[]; credentials: { id: string; created_at: string; last_used_at: string | null; alg: number }[]; can_send: boolean }
export interface Target { state: string; district?: string | null; units?: string[]; all_in_state?: boolean }
export interface MessageDraft { org_id?: string; category: string; target: Target; text_en?: string; text_te?: string; title_en?: string; title_te?: string; template_id?: string; slots?: Record<string, string>; declaration?: { accepted: boolean; reason: string } }
export interface NotifyMessage {
  id: string; org_id: string; category: string; status: string; blocked_reason: string | null; target: Target; title_en: string; title_te: string; text_en: string; text_te: string; template_id: string | null; msg_hash: string;
  approvals_required: number; approvals: number; declaration: { accepted: boolean; reason: string } | null; mcc_window: string | null; created_by: string; created_at: string; sent_at: string | null; stats: Record<string, number> | null; signature: string | null; key_id: string | null;
}
export interface AdminOrg { id: string; name: string; kind: string; letter_ref: string; email_domain: string; contact: string; status: string; requested_by: string; created_at: string; decided_by: string | null }
export interface AdminSender { id: string; org_id: string; org_name: string; person_id: string; role: string; status: string; requested_by: string; credentials: number }
export interface KillRow { id: string; scope: "all" | "org"; org_id: string | null; reason: string; engaged_by: string; engaged_at: string; release_requested_by: string | null; released_at: string | null }
export interface NotifyStatus {
  kill: { engaged: boolean; scope: "all" | "org" | null; since: string | null; orgs_suspended: number; notice_en: string | null; notice_te: string | null };
  window: { state: string; status: "open" | "blackout" | "unknown"; notice_en: string; notice_te: string; declaration_needed: boolean; blocked_categories: string[] };
  as_of: string;
}
export interface LintFinding { rule: string; field: string; detail?: string }
export interface LintResult { clean: boolean; findings: LintFinding[]; rules: string[]; chars: { text_en: number; text_te: number; max: number }; mcc: { state: string; window: string } | null }
export interface Device { id: string; platform: string; label_en: string; label_te: string; created_at: string }
export interface PersonHit { person_id: string; phone_tail: string | null; tier: string; roles: { role: string; department: string | null; jurisdiction: string | null }[]; senders: { sender_id: string; org_name: string; role: string; status: string }[]; matched_by: "phone" | "name_hint" }
export interface SenderCredential { id: string; alg: number; created_at: string; last_used_at: string | null; revoked: boolean; revoked_at: string | null }
export interface WindowInfo { state: string; window: "open" | "blackout" | "unknown"; notificationsAllowed: boolean }

export const notifyApi = {
  // public
  policy: () => get<NotifyPolicy>("/policy", false),
  templates: async () => (await get<{ templates: Template[] }>("/templates", false)).templates,
  senders: async () => (await get<{ senders: PublicOrg[] }>("/senders", false)).senders,
  senderLog: (orgId: string) => get<SenderLog>(`/senders/${encodeURIComponent(orgId)}/log`, false),
  blockLog: async (limit = 200) => (await get<{ entries: BlockEntry[]; note?: string }>(`/block-log?limit=${limit}`, false)).entries,
  keys: async () => (await get<{ keys: PublishedKey[] }>("/keys", false)).keys,
  /** Election-window state per state from the existing public route (calendar-driven, fail closed). */
  window: async (state: string): Promise<WindowInfo> => {
    const r = await fetch(`/api/v1/election-window?state=${encodeURIComponent(state)}`, { cache: "no-cache" });
    if (!r.ok) throw new CivicApiError("window", r.status);
    const j = await r.json() as { window: WindowInfo["window"]; notificationsAllowed: boolean };
    return { state, window: j.window, notificationsAllowed: j.notificationsAllowed };
  },
  /** Public pre-flight: the kill switch (no reason) and what the election-window state means for senders. */
  status: (state: string, orgId?: string) => get<NotifyStatus>(`/status?state=${encodeURIComponent(state)}${orgId ? `&org_id=${encodeURIComponent(orgId)}` : ""}`, false),
  // recipient
  inbox: (limit = 50) => get<{ items: InboxItem[]; unread: number }>(`/inbox?limit=${limit}`),
  markRead: (id: string) => post<{ ok: true }>(`/inbox/${encodeURIComponent(id)}/read`),
  prefs: () => get<Prefs>("/prefs"),
  putPrefs: (b: Partial<{ categories: Record<string, boolean>; quiet_hours: { start: string; end: string }; language: "te" | "en"; sms_ok: boolean; email_ok: boolean; push_blocked: boolean }>) => call<Prefs>("/prefs", { method: "PUT", body: b }),
  unsubscribe: () => post<Prefs>("/unsubscribe"),
  antiphish: () => get<{ word: string | null }>("/antiphish"),
  setAntiphish: (word: string) => call<{ ok: true }>("/antiphish", { method: "PUT", body: { word } }),
  devices: () => get<{ devices: Device[]; count: number }>("/devices"),
  removeDevices: () => call<{ ok: true }>("/devices", { method: "DELETE" }),
  // sender
  me: () => get<SenderMe>("/sender/me"),
  registerOptions: () => post<RegistrationOptionsDto>("/webauthn/register/options"),
  registerVerify: (c: RegistrationCredentialDto) => post<{ credential_id: string; alg: number }>("/webauthn/register/verify", c),
  messages: async () => (await get<{ messages: NotifyMessage[] }>("/messages")).messages,
  message: (id: string) => get<NotifyMessage>(`/messages/${encodeURIComponent(id)}`),
  /** Content-linter findings for text being typed. Nothing is created or logged. */
  lint: (b: { text_en?: string; text_te?: string; title_en?: string; title_te?: string; slots?: Record<string, string>; state?: string }) => post<LintResult>("/messages/lint", b),
  create: (d: MessageDraft) => post<{ id: string; status: string; msg_hash: string; approvals_required: number; mcc_window: string }>("/messages", d),
  challenge: (id: string, purpose: "approve" | "send") => post<AssertionOptionsDto>(`/messages/${encodeURIComponent(id)}/challenge`, { purpose }),
  approve: (id: string, assertion: AssertionDto) => post<{ id: string; status: string; approvals: number; approvals_required: number }>(`/messages/${encodeURIComponent(id)}/approve`, { assertion }),
  send: (id: string, assertion: AssertionDto) => post<{ id: string; status: string; signature: string; key_id: string; stats: Record<string, number> }>(`/messages/${encodeURIComponent(id)}/send`, { assertion }),
  cancel: (id: string) => post<{ id: string; status: string }>(`/messages/${encodeURIComponent(id)}/cancel`),
  // admin (second factor on every change)
  adminOrgs: async () => (await get<{ orgs: AdminOrg[] }>("/admin/orgs")).orgs,
  requestOrg: (b: { name: string; kind: string; letter_ref: string; email_domain: string; contact: string }, totp: string) => post<{ id: string }>("/admin/orgs", b, totp),
  decideOrg: (id: string, verify: boolean, totp: string) => post<{ id: string; status: string }>(`/admin/orgs/${encodeURIComponent(id)}/${verify ? "verify" : "reject"}`, {}, totp),
  adminSenders: async () => (await get<{ senders: AdminSender[] }>("/admin/senders")).senders,
  requestSender: (b: { org_id: string; person_id: string; role: string }, totp: string) => post<{ id: string }>("/admin/senders", b, totp),
  decideSender: (id: string, action: "approve" | "reject" | "revoke", totp: string) => post<{ id: string; status: string }>(`/admin/senders/${encodeURIComponent(id)}/${action}`, {}, totp),
  adminPeople: (q: string) => get<{ people: PersonHit[]; note: string }>(`/admin/people?q=${encodeURIComponent(q)}`),
  adminCredentials: (sender: string) => get<{ sender: { id: string; org_name: string; role: string; status: string }; credentials: SenderCredential[] }>(`/admin/credentials?sender=${encodeURIComponent(sender)}`),
  revokeCredential: (id: string, totp: string) => post<{ ok: true }>(`/admin/credentials/${encodeURIComponent(id)}/revoke`, {}, totp),
  kills: async () => (await get<{ kills: KillRow[] }>("/admin/kill")).kills,
  engageKill: (b: { scope: "all" | "org"; org_id?: string; reason: string }, totp: string) => post<{ id: string }>("/admin/kill", b, totp),
  releaseRequest: (id: string, totp: string) => post<{ id: string }>(`/admin/kill/${encodeURIComponent(id)}/release-request`, {}, totp),
  releaseApprove: (id: string, totp: string) => post<{ id: string; released: boolean }>(`/admin/kill/${encodeURIComponent(id)}/release-approve`, {}, totp),
};

/** Machine code from an API error body (e.g. kill_switch, fido2_required, content_policy). */
export const notifyErrCode = (e: unknown): string => (e instanceof CivicApiError ? String((e.body as { code?: unknown }).code ?? e.code) : "");
export const notifyErrRules = (e: unknown): string[] => { const r = e instanceof CivicApiError ? (e.body as { rules?: unknown }).rules : null; return Array.isArray(r) ? r.map(String) : []; };
