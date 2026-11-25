/** Typed client for /api/v1/civic (identity, households, geo, issues). The session token is kept in sessionStorage only. */
import { reportShed, shedFrom, type ShedInfo } from "../lib/degraded";
const BASE = "/api/v1/civic";
const TOKEN_KEY = "civic-token";

export class CivicApiError extends Error {
  status: number;
  code: string;
  /** Parsed JSON error body (carries extras such as members, limited, locked, code). */
  body: Record<string, unknown> = {};
  /** Set when the server shed this call in degraded mode (503); see src/lib/degraded.ts. */
  shed?: ShedInfo;
  constructor(message: string, status: number, code = "error") { super(message); this.status = status; this.code = code; }
}

export interface Village { lgd: string; nameEn: string; nameTe?: string; mandal?: string; district?: string }
export interface Issue { id: string; category: string; text?: string; textTe?: string; status: string; villageLgd?: string; unit?: string; createdAt?: string; support?: number; hasPhoto?: boolean; units?: Unit[] }
export interface Session { token: string; personId?: string; tier?: string }
export interface OtpRequestResult { ok: boolean; devOtp?: string }

/** Tells the broadcast-poll gate (S-185) that the signed-in person changed, so it can look for a poll at once. */
const announceSession = (): void => { try { window.dispatchEvent(new Event("pp-session")); } catch { /* no window */ } };

export const tokenStore = {
  get(): string | null { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t: string) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* storage unavailable */ } announceSession(); },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } announceSession(); },
};

export async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean; fresh?: boolean; root?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const tok = tokenStore.get();
  if (tok && init.auth !== false) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try {
    res = await fetch(`${init.root ? "/api/v1" : BASE}${path}`, { method: init.method ?? "GET", headers, cache: init.fresh ? "no-cache" : undefined, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new CivicApiError("network", 0, "network");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (data as { error?: string | { code?: string; message?: string } } | null)?.error;
    const code = typeof e === "string" ? e : e?.code ?? "error";
    const ce = new CivicApiError(typeof e === "object" && e?.message ? e.message : code, res.status, code);
    if (data && typeof data === "object") ce.body = data as Record<string, unknown>;
    const sh = shedFrom(res.status, data, res.headers.get("retry-after"));
    if (sh) { ce.shed = sh; reportShed(sh); }
    throw ce;
  }
  return data as T;
}

const list = <T,>(d: unknown, ...keys: string[]): T[] => {
  if (Array.isArray(d)) return d as T[];
  for (const k of keys) { const v = (d as Record<string, unknown> | null)?.[k]; if (Array.isArray(v)) return v as T[]; }
  return [];
};

interface HitDto { village: { lgd: string; name_en: string; name_te: string | null }; hamlet: { name_en: string; name_te: string | null } | null; path: string[] }
interface EventDto { seq: number; issue_id: string; type: string; status: string | null; village_lgd: string; category: string }
const e164 = (p: string) => (p.startsWith("+") ? p : "+91" + p);

export const civicApi = {
  /** Identity: request an OTP. The dev OTP is returned only when the server runs with CIVIC_EXPOSE_DEV_OTP=1 outside production. */
  requestOtp: async (phone: string): Promise<OtpRequestResult> => {
    const r = await call<{ ok: boolean; dev_otp?: string }>("/identity/signup/request", { method: "POST", body: { phone: e164(phone) }, auth: false });
    return { ok: r.ok, devOtp: r.dev_otp };
  },
  signUp: (a: { phone: string; otp: string; pin: string; consentVersion: string }) =>
    call<Session>("/identity/signup/verify", { method: "POST", body: { phone: e164(a.phone), otp: a.otp, pin: a.pin, consent_version: a.consentVersion }, auth: false }),
  login: (a: { phone: string; pin: string }) => call<Session>("/identity/login", { method: "POST", body: { phone: e164(a.phone), pin: a.pin }, auth: false }),
  searchVillages: async (q: string): Promise<Village[]> => {
    const hits = list<HitDto>(await call<unknown>(`/geo/search?q=${encodeURIComponent(q)}`, { auth: false }), "results");
    return hits.map((h) => ({ lgd: h.village.lgd, nameEn: h.hamlet ? `${h.hamlet.name_en} (${h.village.name_en})` : h.village.name_en, nameTe: h.hamlet?.name_te ?? h.village.name_te ?? undefined, mandal: h.path[2] }));
  },
  /** Issues module needs a village LGD and a description (Telugu or English). */
  reportIssue: (a: { category: string; text: string; villageLgd: string; photoRef?: string; voiceRef?: string; lat?: number; lon?: number }) => {
    const te = /[ఀ-౿]/.test(a.text);
    return call<{ id: string; merged?: boolean; held?: boolean }>("/issues", { method: "POST", body: { category: a.category, village_lgd: a.villageLgd, [te ? "description_te" : "description_en"]: a.text.trim() || "Voice note", photo_ref: a.photoRef, voice_ref: a.voiceRef, lat: a.lat, lon: a.lon } });
  },
  /** Public feed: latest event per issue (no reporter identity, no free text). */
  listIssues: async (): Promise<Issue[]> => {
    const ev = list<EventDto>(await call<unknown>("/issues/feed?limit=200", { auth: false, fresh: true }), "events");
    const latest = new Map<string, Issue>();
    for (const e of ev) latest.set(e.issue_id, { id: e.issue_id, category: e.category, status: e.status ?? e.type, villageLgd: e.village_lgd });
    return [...latest.values()].reverse().slice(0, 50);
  },
};

// ---- Identity UI additions (login picker, PIN recovery, residence, attestation, invites, sessions) ----
export interface SimMember { personId: string; label: string; locked: boolean }
export interface MePerson { id: string; tier: "T0" | "T1" | "T2"; role?: string; roles?: string[]; label?: string; residence_declared?: boolean; flags?: string[]; survey_eligible?: boolean }
export interface EnrolmentRow { id: string; contextKind: string; label?: string; status: string; expiresAt?: string; createdAt?: string }
export interface GeoUnit { code: string; nameEn: string; nameTe?: string }
export interface SessionRow { id: string; createdAt?: string; lastSeen?: string; device?: string; current?: boolean }
export interface InviteNotice { status: string; expiresAt?: number; notice?: { version: string; title: { en: string; te: string }; text: { en: string; te: string } } }
const GEO = "/api/v1/geo";
export type GeoState = "AP" | "TG";

/** Machine code from the error body (e.g. phone_mismatch, wrong_pin, pin_locked, weak_pin, invite_cooldown, dependents_cap). */
export function errCode(e: unknown): string {
  if (!(e instanceof CivicApiError)) return "";
  return typeof e.body.code === "string" ? e.body.code : "";
}

/** S-164: true when an OTP request failed because the code could not be SENT (502 delivery: "failed"); the person may try again at once. */
export function smsFailed(e: unknown): boolean { return e instanceof CivicApiError && e.body.delivery === "failed"; }

/** Server error classification shared by the identity screens. */
export function errKind(e: unknown): "person_required" | "limited" | "locked" | "weak_pin" | "wrong" | "network" | "gone" | "forbidden" | "conflict" | "other" {
  if (!(e instanceof CivicApiError)) return "other";
  const b = e.body, bc = typeof b.code === "string" ? b.code : e.code;
  if (e.status === 0) return "network";
  if (bc === "person_required") return "person_required";
  if (bc === "weak_pin") return "weak_pin";
  if (e.status === 423 || b.locked) return "locked";
  if (e.status === 429 || b.limited) return "limited";
  if (e.status === 403) return "forbidden";
  if (e.status === 401) return "wrong";
  if (e.status === 404 || e.status === 410) return "gone";
  if (e.status === 409) return "conflict";
  return "other";
}

export interface DemoPersonaInfo { key: string; label: string; description: string; roles: string[] }
export const civicIdentityApi = {
  /** S-165: sign-up and sign-in with an email address, for people with no phone. The code goes by email; the dev code is echoed only in dev. */
  requestEmailCode: async (email: string, purpose: "signup" | "recovery" = "signup"): Promise<{ devOtp?: string; alreadySent: boolean }> => {
    const r = await call<{ ok: boolean; dev_otp?: string; already_sent?: boolean }>(purpose === "recovery" ? "/identity/pin/recover/email/request" : "/identity/signup/email/request", { method: "POST", body: { email }, auth: false });
    return { devOtp: r.dev_otp, alreadySent: !!r.already_sent };
  },
  signUpEmail: (a: { email: string; otp: string; pin: string; consentVersion: string }) =>
    call<Session>("/identity/signup/email/verify", { method: "POST", body: { email: a.email, otp: a.otp, pin: a.pin, consent_version: a.consentVersion }, auth: false }),
  loginEmail: (a: { email: string; pin: string }) => call<Session>("/identity/login/email", { method: "POST", body: { email: a.email, pin: a.pin }, auth: false }),
  recoverPinEmail: (a: { email: string; otp: string; newPin: string }) =>
    call<{ ok: boolean }>("/identity/pin/recover/email", { method: "POST", body: { email: a.email, otp: a.otp, new_pin: a.newPin }, auth: false }),
  /** S-167: an email-only account adds a phone. The code is requested with requestCode(phone) first. */
  addPhone: (a: { phone: string; otp: string }) => call<{ person: MePerson }>("/identity/phone/add", { method: "POST", body: { phone: e164(a.phone), otp: a.otp } }),
  /** S-166: demo personas exist only when the server runs with CIVIC_DEMO_PERSONAS=1 outside production; otherwise this is an empty list. */
  demoPersonas: async (): Promise<DemoPersonaInfo[]> => {
    try { return (await call<{ personas: DemoPersonaInfo[] }>("/demo/personas", { auth: false })).personas ?? []; } catch { return []; }
  },
  demoLogin: (persona: string) => call<Session & { roles: string[]; persona: string }>("/demo/login", { method: "POST", body: { persona }, auth: false }),
  /** Login for one adult on a shared SIM. person_id is sent only after the person was picked. */
  loginAs: (a: { phone: string; pin: string; personId?: string }) =>
    call<Session>("/identity/login", { method: "POST", body: { phone: e164(a.phone), pin: a.pin, ...(a.personId ? { person_id: a.personId } : {}) }, auth: false }),
  /** Adults on the SIM, from the person_required error body. Labels only, never PINs. Accepts members or sim_members, snake or camel case. */
  membersFrom: (e: unknown): SimMember[] => {
    const b = e instanceof CivicApiError ? e.body : {};
    const raw = (b.members ?? b.sim_members) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((m: Record<string, unknown>) => ({ personId: String(m.person_id ?? m.personId ?? m.id ?? ""), label: String(m.label ?? m.name ?? ""), locked: !!m.locked })).filter((m) => m.personId);
  },
  recoverPin: (a: { phone: string; otp: string; newPin: string; personId?: string }) =>
    call<{ ok: boolean }>("/identity/pin/recover", { method: "POST", body: { phone: e164(a.phone), otp: a.otp, new_pin: a.newPin, ...(a.personId ? { person_id: a.personId } : {}) }, auth: false }),
  me: async (): Promise<MePerson> => {
    const d = await call<{ person: MePerson; role?: string; roles?: string[] }>("/identity/me", { fresh: true });
    return { ...d.person, role: d.role ?? d.person.role, roles: d.roles };
  },
  /** One-time code. purpose recovery uses POST /identity/pin/recover/request. The server never re-sends while a code is still valid (alreadySent). */
  requestCode: async (phone: string, purpose: "signup" | "recovery" = "signup"): Promise<{ devOtp?: string; alreadySent: boolean; queued?: boolean; expectedDelayS?: number; delivery?: "sent" | "queued" | "failed" }> => {
    const r = await call<{ ok: boolean; dev_otp?: string; already_sent?: boolean; queued?: boolean; expected_delay_s?: number; delivery?: "sent" | "queued" | "failed" }>(purpose === "recovery" ? "/identity/pin/recover/request" : "/identity/signup/request", { method: "POST", body: { phone: e164(phone) }, auth: false });
    return { devOtp: r.dev_otp, alreadySent: !!r.already_sent, ...(r.delivery ? { delivery: r.delivery } : {}), ...(r.queued ? { queued: true, expectedDelayS: Math.max(0, Math.ceil(Number(r.expected_delay_s) || 0)) } : {}) };
  },
  /** S-158: change the PIN while signed in. Success signs out every other device and returns a fresh token for this one (the caller stores it). */
  changePin: (a: { oldPin: string; newPin: string }) => call<{ ok: boolean; token: string }>("/identity/pin/change", { method: "POST", body: { old_pin: a.oldPin, new_pin: a.newPin } }),
  declareResidence: async (a: { residence: string; unitId?: string }): Promise<MePerson> =>
    (await call<{ person: MePerson }>("/identity/residence", { method: "POST", body: { residence: a.residence, ...(a.unitId ? { unit_id: a.unitId } : {}) } })).person,
  geoUnits: async (state: GeoState, level: "district" | "mandal" | "village", parent?: string): Promise<GeoUnit[]> => {
    const r = await fetch(`${GEO}/${state}/units?level=${level}&limit=200${parent ? `&parent=${encodeURIComponent(parent)}` : ""}`);
    if (!r.ok) throw new CivicApiError("geo", r.status);
    const j = (await r.json()) as { items?: { code: string; nameEn: string; nameTe?: string }[] };
    return (j.items ?? []).map((u) => ({ code: u.code, nameEn: u.nameEn, nameTe: u.nameTe }));
  },
  geoSearchVillages: async (state: GeoState, q: string): Promise<(GeoUnit & { path: string[] })[]> => {
    const r = await fetch(`${GEO}/${state}/search?q=${encodeURIComponent(q)}&limit=20`);
    if (!r.ok) return [];
    const j = (await r.json()) as { results?: { kind: string; code: string; nameEn: string; nameTe?: string; path: string[] }[] };
    return (j.results ?? []).filter((h) => h.kind === "village").map((h) => ({ code: h.code, nameEn: h.nameEn, nameTe: h.nameTe, path: h.path }));
  },
  /** GET /identity/attest/requests (volunteers only) -> { requests: [{ person_id, label, village }] }. */
  attestRequests: async (): Promise<{ personId: string; label: string; village: string }[]> => {
    const d = await call<{ requests?: Record<string, unknown>[] }>("/identity/attest/requests", { fresh: true });
    return (d.requests ?? []).map((r) => ({ personId: String(r.person_id ?? r.personId ?? ""), label: String(r.label ?? ""), village: String(r.village ?? "") }));
  },
  attest: async (personId: string) => {
    const r = await call<{ ok: boolean; tier: string; independent_attestors: number }>("/identity/attest", { method: "POST", body: { person_id: personId } });
    return { tier: r.tier, attestors: r.independent_attestors };
  },
  /** POST /identity/volunteer/enrol { phone, context: household|shg, label? } -> 201 pending. Never sends a PIN (the server rejects one with pin_not_allowed). */
  enrolAdult: async (a: { phone: string; context: "household" | "shg"; label?: string }) => {
    const r = await call<{ enrolment_id: string; expires_at: string }>("/identity/volunteer/enrol", { method: "POST", body: { phone: e164(a.phone), context: a.context, ...(a.label ? { label: a.label } : {}) } });
    return { enrolmentId: r.enrolment_id, expiresAt: r.expires_at };
  },
  listEnrolments: async (): Promise<EnrolmentRow[]> => {
    const d = await call<{ enrolments?: Record<string, unknown>[] }>("/identity/volunteer/enrolments", { fresh: true });
    return (d.enrolments ?? []).map((e) => ({ id: String(e.id), contextKind: String(e.context_kind ?? ""), label: (e.label as string | null) ?? undefined, status: String(e.status), expiresAt: e.expires_at as string | undefined, createdAt: e.created_at as string | undefined }));
  },
  cancelEnrolment: (id: string) => call<{ ok: boolean }>(`/identity/volunteer/enrolments/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  /** POST /identity/activate { code, otp, pin } -> 201 { token, person }: the adult's own device and PIN; the SMS holds both the code and the OTP. */
  activate: (a: { code: string; otp: string; pin: string }) => call<Session>("/identity/activate", { method: "POST", body: a, auth: false }),
  inviteNotice: (id: string) => call<InviteNotice>(`/households/invites/${encodeURIComponent(id)}/notice`, { auth: false, fresh: true }),
  acceptInvite: (inviteId: string, pin: string) => call<{ ok: boolean }>("/households/invites/accept", { method: "POST", body: { inviteId, pin } }),
  declineInvite: (inviteId: string) => call<{ ok: boolean }>("/households/invites/decline", { method: "POST", body: { inviteId } }),
  reportNotAgreed: (inviteId: string) => call<{ ok: boolean }>("/households/invites/report-not-agreed", { method: "POST", body: { inviteId } }),
  /** GET /identity/sessions, DELETE /identity/sessions/:id, POST /identity/logout. */
  listSessions: async (): Promise<SessionRow[]> => {
    const d = await call<{ sessions?: Record<string, unknown>[] }>("/identity/sessions", { fresh: true });
    return (d.sessions ?? []).map((s) => ({ id: String(s.id), createdAt: s.created_at as string | undefined, lastSeen: (s.last_seen ?? s.last_used) as string | undefined, device: s.device as string | undefined, current: !!s.current }));
  },
  revokeSession: (id: string) => call<{ ok: boolean }>(`/identity/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  logout: async () => { try { await call<unknown>("/identity/logout", { method: "POST" }); } catch { /* route may be absent; the token is cleared locally anyway */ } },
};

// ---------------------------------------------------------------------------------------------------------------------
// Issues UI (S-137/139/140/142) and consoles. Shapes below are the REAL server shapes (server/civic/issues/{public,curation,routes}.ts).
// ---------------------------------------------------------------------------------------------------------------------
export interface CategoryInfo { id: string; labelEn: string; labelTe: string; icon: string; ivrDigit?: string; department?: string; slaHours?: number }
export interface TrustTierInfo { tier: "T0" | "T1" | "T2"; labelEn: string; labelTe: string; descriptionEn: string; descriptionTe: string; icon: string }
/** Filters shared by the list (`GET /issues`) and the export. Unit filters take LGD codes of that level. */
export interface FeedParams { village?: string; mandal?: string; district?: string; constituency?: string; category?: string; status?: string; q?: string; cursor?: string; limit?: number }
export interface FeedPage { items: Issue[]; nextCursor: string | null; hasMore: boolean }
export interface TimelineEntry { type: string; status?: string; at?: string }
export interface Unit { lgd: string; level: string; nameEn: string; nameTe?: string }
export interface OfficerResponse { text: string; officerTag?: string; at?: string }
export interface IssueDetail {
  id: string; category: string; status: string; department?: string;
  text?: string; textTe?: string; createdAt?: string; updatedAt?: string; slaDue?: string; resolvedAt?: string;
  supportCount: number; units: Unit[]; acNo?: number; timeline: TimelineEntry[]; officerResponses: OfficerResponse[];
  hasPhoto: boolean; hasVoice: boolean; photoMediaId?: string; voiceMediaId?: string;
  canConfirm: boolean; canAppeal: boolean;
  /** S-145: the one labelled reply of the elected representative, shown beside the report. Never affects order or counts. */
  officialReply?: OfficialReply | null;
}
export interface SchemeTagInfo { id: string; labelEn: string; labelTe: string }
export interface OfficialReply {
  constituencyEn: string; constituencyTe?: string; text: string; version: number; postedAt?: string; updatedAt?: string; edited: boolean;
  tags: SchemeTagInfo[]; history: { version: number; text: string; at?: string }[];
}
/** S-157: the caller's own report (GET /issues/mine). moderation: ok = public, held = waiting for review, taken_down = removed. Reason classes are coarse, never rule ids. */
export type OwnerModeration = "ok" | "held" | "taken_down";
export interface OwnerAppeal { status: string; at?: string; decidedAt?: string; count: number }
export interface MyReport {
  id: string; category: string; status: string; moderation: OwnerModeration; moderationClasses: string[]; escalated: boolean; canAppeal: boolean;
  appeal: OwnerAppeal | null; snippet: string; createdAt?: string; support: number;
}
export interface MyReportDetail extends IssueDetail { moderation: OwnerModeration; moderationClasses: string[]; escalated: boolean; appeal: OwnerAppeal | null }
export interface Me { personId?: string; roles: string[]; isAdmin?: boolean; mfa?: { enrolled: boolean; confirmed: boolean; recoveryCodesLeft?: number } }
export type ModQueueStatus = "held" | "escalated" | "taken_down";
export interface HeldReport { id: string; category?: string; villageLgd?: string; text?: string; textTe?: string; reasons: string[]; at?: string; appeal?: { id?: string; at?: string; reason?: string } | null; escalated: boolean; moderation?: string }
export interface ModMetrics { total?: number; held?: number; holdRate?: number; falsePositiveRate?: number }
export interface ModMetricsFull extends ModMetrics { lexiconVersion?: number; stillWaiting?: number; approvedAfterHold?: number; rejectedAfterHold?: number; appeals?: { total: number; decided: number; pending: number; meanHours: number | null; medianHours: number | null }; heldByRule: Record<string, number> }
export interface ModQueue { items: HeldReport[]; metrics: ModMetrics; nextCursor: string | null; hasMore: boolean; status: ModQueueStatus; waitingHoursOldest?: number }
export type ModDecision = "approve" | "reject" | "uphold" | "escalate";
export interface LexChange { id: string; op: "add" | "retire"; list: string; term: string; status: string; approvals: number; approvalsNeeded: number; note?: string }
export interface LexiconInfo { version?: number; changes: LexChange[]; lists: string[]; approvalsNeeded: { add: number; retire: number } }
export interface LexReviewResult { status: string; approvals?: number; approvalsNeeded?: number; version?: number }
export interface OfficerItem { id: string; category: string; department?: string; status: string; villageLgd?: string; createdAt?: string; slaDue?: string; escLevel?: number; overdue: boolean; text?: string; textTe?: string; support: number }
export interface OfficerQueue { role: { department: string | null; jurisdictionLgd: string | null }; items: OfficerItem[] }
export interface RoleRequest { id: string; action: "grant" | "revoke"; personId: string; role: string; scope?: string; department?: string; reason?: string; status: string; requestedBy?: string; createdAt?: string; expiresAt?: string; decidedBy?: string | null }
/** Second factor for admin mutations: a 6-digit TOTP code, or a one-time recovery code. Sent as x-totp-code / x-recovery-code, never stored. */
export type Mfa = { totp: string } | { recovery: string };
export interface MfaEnrolment { secret: string; uri?: string; recoveryCodes: string[] }
export interface AuditHead { hash: string; seq?: number; ts?: string; count: number; anchorSink?: string; anchorConfigured: boolean; unanchored: number }
export interface AuditVerify { ok: boolean; chainOk: boolean; anchorMatches: boolean | null; witnessReachable?: boolean; witnessMatches?: boolean }
const mfaHeaders = (m: Mfa): Record<string, string> => ("totp" in m ? { "x-totp-code": m.totp } : { "x-recovery-code": m.recovery });
export interface JobRow { name: string; runs: number; failures: number; lastRunAt: string | null; lastOk: boolean | null; lastError: string | null }
/** Error codes of POST /issues/media (body.code). `daily_limit` is derived from the 429, which carries no code. */
export type UploadErrorCode = "convert_on_client" | "unsupported_type" | "wrong_kind" | "too_large" | "dimensions_too_large" | "scan_rejected" | "scanner_unavailable" | "daily_limit" | "network" | "error";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
type Raw = Record<string, any>;
const enc = encodeURIComponent;

/** Offline / pre-load default; same ids, labels and icons as server/civic/issues/categories.ts. */
export const BUILTIN_CATEGORIES: CategoryInfo[] = [
  { id: "water", labelEn: "Drinking water", labelTe: "తాగునీరు", icon: "droplets", ivrDigit: "1" }, { id: "roads", labelEn: "Roads", labelTe: "రోడ్లు", icon: "route", ivrDigit: "2" },
  { id: "electricity", labelEn: "Electricity", labelTe: "విద్యుత్", icon: "zap", ivrDigit: "3" }, { id: "health", labelEn: "Health", labelTe: "ఆరోగ్యం", icon: "heart-pulse", ivrDigit: "4" },
  { id: "education", labelEn: "Schools and education", labelTe: "పాఠశాల, విద్య", icon: "graduation-cap", ivrDigit: "5" }, { id: "agriculture", labelEn: "Agriculture and irrigation", labelTe: "వ్యవసాయం, సాగునీరు", icon: "sprout", ivrDigit: "6" },
  { id: "welfare", labelEn: "Welfare schemes", labelTe: "సంక్షేమ పథకాలు", icon: "hand-heart", ivrDigit: "7" }, { id: "law_order", labelEn: "Law and order", labelTe: "శాంతిభద్రతలు", icon: "shield-alert", ivrDigit: "8" },
  { id: "other", labelEn: "Other", labelTe: "ఇతరం", icon: "ellipsis", ivrDigit: "9" },
];

const toUnit = (r: Raw): Unit => ({ lgd: String(r.lgd), level: String(r.level), nameEn: String(r.name_en ?? r.nameEn ?? r.lgd), nameTe: str(r.name_te ?? r.nameTe) });
const unitRef = (level: string, r: Raw | null | undefined): Unit[] => (r?.lgd ? [toUnit({ ...r, level })] : []);
const filterQuery = (p: FeedParams) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return qs;
};

/** A `GET /issues` item: place objects, English and Telugu snippets, support count. */
function toIssue(r: Raw): Issue {
  const units = [...unitRef("village", r.village), ...unitRef("mandal", r.mandal), ...unitRef("district", r.district), ...unitRef("constituency", r.constituency)];
  return {
    id: String(r.id), category: String(r.category ?? "other"), status: String(r.status ?? "Reported"), villageLgd: str(r.village?.lgd ?? r.village_lgd),
    text: str(r.snippet) ?? str(r.snippet_te), textTe: str(r.snippet_te), createdAt: str(r.created_at), unit: str(r.department), support: num(r.support), hasPhoto: !!r.has_photo, units,
  };
}

/** Upload with progress (fetch has no upload progress, so XHR). Raw body with the real content type; resolves `media:<id>`. */
function uploadMedia(blob: Blob, onProgress?: (frac: number) => void): Promise<{ ref: string }> {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open("POST", `${BASE}/issues/media`);
    const tok = tokenStore.get();
    if (tok) x.setRequestHeader("authorization", `Bearer ${tok}`);
    x.setRequestHeader("content-type", blob.type || "application/octet-stream");
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onerror = () => bad(new CivicApiError("network", 0, "network"));
    x.onload = () => {
      let d: Raw | null = null; try { d = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && typeof d?.ref === "string") return ok({ ref: d.ref });
      const e = d?.error;
      const code = str(d?.code) ?? (x.status === 413 ? "too_large" : x.status === 429 ? "daily_limit" : x.status === 415 ? "unsupported_type" : typeof e === "string" ? e : "error");
      const ce = new CivicApiError(typeof e === "string" ? e : code, x.status, code);
      if (d) ce.body = d;
      bad(ce);
    };
    x.send(blob);
  });
}

/** Map any thrown value from an upload to one of the documented codes. */
export const uploadErrorCode = (e: unknown): UploadErrorCode => {
  if (!(e instanceof CivicApiError)) return "error";
  const known: UploadErrorCode[] = ["convert_on_client", "unsupported_type", "wrong_kind", "too_large", "dimensions_too_large", "scan_rejected", "scanner_unavailable", "daily_limit", "network"];
  return (known as string[]).includes(e.code) ? (e.code as UploadErrorCode) : "error";
};

let catPayload: Promise<{ categories: CategoryInfo[]; tiers: TrustTierInfo[] }> | null = null;
const loadCategoryPayload = () => (catPayload ??= call<Raw>("/issues/categories", { auth: false }).then((d) => ({
  categories: list<Raw>(d, "categories").map((r) => ({ id: String(r.id), labelEn: String(r.label_en ?? r.id), labelTe: String(r.label_te ?? r.label_en ?? r.id), icon: String(r.icon ?? "ellipsis"), ivrDigit: str(r.ivr_digit), department: str(r.department), slaHours: num(r.sla_hours) })),
  tiers: list<Raw>(d, "trust_tiers").map((t) => ({ tier: t.tier, labelEn: String(t.label_en), labelTe: String(t.label_te), descriptionEn: String(t.description_en), descriptionTe: String(t.description_te), icon: String(t.icon ?? "") })),
})).catch((e) => { catPayload = null; throw e; }));

const decodeLexChange = (r: Raw): LexChange => ({ id: String(r.id), op: r.op === "retire" ? "retire" : "add", list: String(r.list ?? ""), term: String(r.term), status: String(r.status ?? "pending"), approvals: Number(r.approvals ?? 0), approvalsNeeded: Number(r.approvals_needed ?? 1), note: str(r.note) });

const toOwnerAppeal = (a: unknown): OwnerAppeal | null => { const r = a as Raw | null; return r && typeof r === "object" ? { status: String(r.status ?? ""), at: str(r.at), decidedAt: str(r.decided_at), count: num(r.count) ?? 1 } : null; };
/** Shared decoder of an issue detail body (public and owner views have the same shape). */
function decodeIssueDetail(r: Raw): IssueDetail {
  const status = String(r.status ?? "Reported");
  return {
    id: String(r.id), category: String(r.category ?? "other"), status, department: str(r.department),
    text: str(r.description_en) ?? str(r.description_te), textTe: str(r.description_te), createdAt: str(r.created_at), updatedAt: str(r.updated_at), slaDue: str(r.sla_due), resolvedAt: str(r.resolved_at),
    supportCount: num(r.counts?.support) ?? 0,
    units: [...unitRef("village", r.village), ...unitRef("mandal", r.mandal), ...unitRef("district", r.district), ...unitRef("constituency", r.constituency)], acNo: num(r.constituency?.ac_no),
    timeline: list<Raw>(r.timeline).map((e) => ({ type: String(e.type ?? "status"), status: str(e.status), at: str(e.at) })),
    officerResponses: list<Raw>(r.officer_responses).map((b) => ({ text: String(b.text ?? ""), officerTag: str(b.officer_tag), at: str(b.at) })),
    hasPhoto: !!r.has_photo, hasVoice: !!r.has_voice, photoMediaId: str(r.photo_media_id), voiceMediaId: str(r.voice_media_id),
    canConfirm: r.can_confirm === true || status === "Resolved", canAppeal: r.can_appeal === true,
    officialReply: decodeOfficialReply(r.official_reply),
  };
}
const decodeOfficialReply = (o: unknown): OfficialReply | null => {
  const r = o as Raw | null;
  if (!r || typeof r !== "object" || typeof r.text !== "string") return null;
  return {
    constituencyEn: String(r.constituency?.name_en ?? r.constituency?.lgd ?? ""), constituencyTe: str(r.constituency?.name_te), text: r.text, version: num(r.version) ?? 1,
    postedAt: str(r.posted_at), updatedAt: str(r.updated_at), edited: r.edited === true,
    tags: list<Raw>(r.scheme_tags).map((t) => ({ id: String(t.id), labelEn: String(t.label_en ?? t.id), labelTe: String(t.label_te ?? t.label_en ?? t.id) })),
    history: list<Raw>(r.history).map((h) => ({ version: num(h.version) ?? 0, text: String(h.text ?? ""), at: str(h.at) })),
  };
};

export const issuesApi = {
  uploadMedia,
  /** The nine canonical categories (GET /issues/categories); falls back to the built-in copy of the same list when the call fails. */
  categories: async (): Promise<CategoryInfo[]> => {
    try { const p = await loadCategoryPayload(); return p.categories.length ? p.categories : BUILTIN_CATEGORIES; } catch { return BUILTIN_CATEGORIES; }
  },
  /** Trust-tier badge labels (same payload as categories); empty when unavailable. */
  trustTiers: async (): Promise<TrustTierInfo[]> => { try { return (await loadCategoryPayload()).tiers; } catch { return []; } },
  /** Public list, newest first: `GET /issues` {items, next_cursor, has_more}. `cursor` is opaque; pass `nextCursor` back. */
  feed: async (p: FeedParams = {}): Promise<FeedPage> => {
    const qs = filterQuery({ ...p, limit: p.limit ?? 25 });
    const d = await call<Raw>(`/issues?${qs}`, { auth: false, fresh: true });
    return { items: list<Raw>(d, "items").map(toIssue), nextCursor: str(d?.next_cursor) ?? null, hasMore: d?.has_more === true };
  },
  /** Export URL for the same filters; `format` is ndjson (server default) or csv. The next part's cursor comes back in X-Next-Cursor (see exportPart). */
  exportUrl: (format: "csv" | "ndjson" = "csv", p: FeedParams = {}) => { const qs = filterQuery({ ...p, limit: undefined, format } as FeedParams & { format: string }); return `${BASE}/issues/export?${qs}`; },
  /** Fetch one export part as a Blob and read X-Next-Cursor (null at the end). Throws CivicApiError (429 = rate limit, code carries retry info). */
  exportPart: async (format: "csv" | "ndjson", p: FeedParams = {}, cursor?: string): Promise<{ blob: Blob; nextCursor: string | null }> => {
    let res: Response;
    try { res = await fetch(issuesApi.exportUrl(format, { ...p, cursor }), { cache: "no-cache" }); } catch { throw new CivicApiError("network", 0, "network"); }
    if (!res.ok) throw new CivicApiError(res.status === 429 ? "rate_limited" : "error", res.status, res.status === 429 ? "rate_limited" : "error");
    return { blob: await res.blob(), nextCursor: res.headers.get("X-Next-Cursor") };
  },
  /** Public detail `GET /issues/:id`. null when the server has no such visible issue (404). */
  detail: async (id: string): Promise<IssueDetail | null> => {
    try {
      const r = await call<Raw>(`/issues/${enc(id)}`, { auth: false, fresh: true });
      if (!r?.id) return null;
      const status = String(r.status ?? "Reported");
      return {
        id: String(r.id), category: String(r.category ?? "other"), status, department: str(r.department),
        text: str(r.description_en) ?? str(r.description_te), textTe: str(r.description_te), createdAt: str(r.created_at), updatedAt: str(r.updated_at), slaDue: str(r.sla_due), resolvedAt: str(r.resolved_at),
        supportCount: num(r.counts?.support) ?? 0,
        units: [...unitRef("village", r.village), ...unitRef("mandal", r.mandal), ...unitRef("district", r.district), ...unitRef("constituency", r.constituency)], acNo: num(r.constituency?.ac_no),
        timeline: list<Raw>(r.timeline).map((e) => ({ type: String(e.type ?? "status"), status: str(e.status), at: str(e.at) })),
        officerResponses: list<Raw>(r.officer_responses).map((b) => ({ text: String(b.text ?? ""), officerTag: str(b.officer_tag), at: str(b.at) })),
        hasPhoto: !!r.has_photo, hasVoice: !!r.has_voice, photoMediaId: str(r.photo_media_id), voiceMediaId: str(r.voice_media_id),
        officialReply: decodeOfficialReply(r.official_reply),
        // The public route has no viewer: it never sets can_confirm, and can_appeal is always false. The server enforces who may vote
        // (reporter or a sampled neighbour), so the confirm buttons stay visible on a Resolved issue and a 403 is explained.
        canConfirm: r.can_confirm === true || status === "Resolved", canAppeal: r.can_appeal === true,
      };
    } catch (e) { if (e instanceof CivicApiError && (e.status === 404 || e.status === 400)) return null; throw e; }
  },
  /**
   * Photo / voice bytes. GET /issues/media/:id needs the bearer token, so an <img>/<audio> cannot point at it: fetch it and hand back an
   * object URL (caller revokes it). null when signed out or not allowed.
   */
  mediaObjectUrl: async (mediaId: string): Promise<string | null> => {
    const tok = tokenStore.get();
    if (!tok) return null;
    try {
      const res = await fetch(`${BASE}/issues/media/${enc(mediaId)}`, { headers: { authorization: `Bearer ${tok}` } });
      return res.ok ? URL.createObjectURL(await res.blob()) : null;
    } catch { return null; }
  },
  meToo: (id: string) => call<Raw>(`/issues/${enc(id)}/me-too`, { method: "POST", body: {} }),
  confirm: (id: string, vote: "confirm" | "reopen") => call<Raw>(`/issues/${enc(id)}/confirm`, { method: "POST", body: { vote } }),
  /** S-157: the caller's own reports, held and removed ones included (GET /issues/mine). */
  mine: async (): Promise<MyReport[]> => list<Raw>(await call<Raw>("/issues/mine", { fresh: true }), "items").map((r) => ({
    id: String(r.id), category: String(r.category ?? "other"), status: String(r.status ?? "Reported"), moderation: (r.moderation === "held" || r.moderation === "taken_down" ? r.moderation : "ok") as OwnerModeration,
    moderationClasses: list<string>(r.moderation_classes), escalated: r.escalated === true, canAppeal: r.can_appeal === true,
    appeal: toOwnerAppeal(r.appeal), snippet: String(r.snippet ?? ""), createdAt: str(r.created_at), support: num(r.support) ?? 0,
  })),
  /** S-157: owner detail of one of the caller's own reports (GET /issues/mine/:id); can_appeal comes from the server. null when it is not the caller's. */
  myDetail: async (id: string): Promise<MyReportDetail | null> => {
    try {
      const r = await call<Raw>(`/issues/mine/${enc(id)}`, { fresh: true });
      if (!r?.id) return null;
      const base = decodeIssueDetail(r);
      return { ...base, canConfirm: false, canAppeal: r.can_appeal === true, moderation: (r.moderation === "held" || r.moderation === "taken_down" ? r.moderation : "ok") as OwnerModeration, moderationClasses: list<string>(r.moderation_classes), escalated: r.escalated === true, appeal: toOwnerAppeal(r.appeal) };
    } catch (e) { if (e instanceof CivicApiError && (e.status === 404 || e.status === 400)) return null; throw e; }
  },
  /** POST /issues/:id/appeal (only the reporter of a held or removed report; one pending appeal at a time). */
  appeal: (id: string, reason: string) => call<Raw>(`/issues/${enc(id)}/appeal`, { method: "POST", body: { reason } }),
  /** Geo units: ancestors of a village (mandal, district...) and its constituency, for the feed filters. */
  villageScopes: async (lgd: string): Promise<Unit[]> => {
    const out: Unit[] = [];
    try { out.push(...list<Raw>(await call<unknown>(`/geo/units/${enc(lgd)}`, { auth: false }), "ancestors").map(toUnit)); } catch { /* optional */ }
    try { out.push(...list<Raw>(await call<unknown>(`/geo/village/${enc(lgd)}/constituency`, { auth: false }), "constituencies").map((r) => ({ ...toUnit(r), level: "constituency" }))); } catch { /* optional */ }
    return out;
  },
  /** Who am I. Role gating in the UI is advisory only: every endpoint below is enforced by the server. */
  me: async (): Promise<Me> => {
    try {
      const d = await call<Raw>("/admin/me");
      const r = d?.person ?? d;
      return { personId: str(r.person_id ?? r.id), roles: list<unknown>(r.roles).map((x) => String(typeof x === "string" ? x : (x as Raw)?.role)), isAdmin: r.is_admin === true, mfa: r.mfa ? { enrolled: !!r.mfa.enrolled, confirmed: !!r.mfa.confirmed, recoveryCodesLeft: num(r.mfa.recovery_codes_left) } : undefined };
    } catch (e) {
      if (e instanceof CivicApiError && e.status === 404) { // endpoint not shipped: fall back to the identity record
        const d = await call<Raw>("/identity/me");
        const p = d?.person ?? d;
        return { personId: str(p?.id), roles: list<unknown>(p?.roles).map(String) };
      }
      throw e;
    }
  },
  /** Officer console: open, visible issues inside the officer's jurisdiction and department. */
  officerQueue: async (limit = 100): Promise<OfficerQueue> => {
    const d = await call<Raw>(`/issues/officer/queue?limit=${limit}`, { fresh: true });
    return {
      role: { department: str(d?.role?.department) ?? null, jurisdictionLgd: str(d?.role?.jurisdiction_lgd) ?? null },
      items: list<Raw>(d, "items").map((r) => ({ id: String(r.id), category: String(r.category ?? "other"), department: str(r.department), status: String(r.status ?? "Reported"), villageLgd: str(r.village_lgd), createdAt: str(r.created_at), slaDue: str(r.sla_due), escLevel: num(r.esc_level), overdue: r.overdue === true, text: str(r.description_en) ?? str(r.description_te), textTe: str(r.description_te), support: num(r.support) ?? 0 })),
    };
  },
  transition: (id: string, b: { to?: string; action?: string; department?: string; note?: string }) => call<Raw>(`/issues/${enc(id)}/transition`, { method: "POST", body: b }),
  rebuttal: (id: string, text: string) => call<Raw>(`/issues/${enc(id)}/rebuttal`, { method: "POST", body: { text } }),
  moderationQueue: async (o: { status?: ModQueueStatus; cursor?: string } = {}): Promise<ModQueue> => {
    const qs = filterQuery({ cursor: o.cursor } as FeedParams); if (o.status) qs.set("status", o.status);
    const d = await call<Raw>(`/issues/moderation/queue?${qs}`, { fresh: true });
    const m: Raw = d?.metrics ?? {};
    return {
      status: (str(d?.status) as ModQueueStatus | undefined) ?? o.status ?? "held", nextCursor: str(d?.next_cursor) ?? null, hasMore: d?.has_more === true, waitingHoursOldest: num(d?.waiting_hours_oldest),
      items: list<Raw>(d, "items").map((r) => ({
        id: String(r.id), category: str(r.category), villageLgd: str(r.village_lgd), text: str(r.description_en) ?? str(r.description_te), textTe: str(r.description_te),
        reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [], at: str(r.created_at), escalated: r.escalated === true, moderation: str(r.moderation),
        appeal: r.appeal ? { id: str(r.appeal.id), at: str(r.appeal.at), reason: str(r.appeal.reason) } : null,
      })),
      metrics: { total: num(m.total), held: num(m.held), holdRate: num(m.hold_rate), falsePositiveRate: num(m.false_positive_rate) },
    };
  },
  moderationMetrics: async (): Promise<ModMetricsFull> => {
    const m = await call<Raw>("/issues/moderation/metrics", { fresh: true });
    const a = m?.appeals;
    return {
      total: num(m.reports), held: num(m.held), holdRate: num(m.hold_rate), falsePositiveRate: num(m.false_positive_rate), lexiconVersion: num(m.lexicon_version), stillWaiting: num(m.still_waiting),
      approvedAfterHold: num(m.approved_after_hold), rejectedAfterHold: num(m.rejected_after_hold), heldByRule: (m.held_by_rule ?? {}) as Record<string, number>,
      appeals: a ? { total: Number(a.total ?? 0), decided: Number(a.decided ?? 0), pending: Number(a.pending ?? 0), meanHours: num(a.mean_turnaround_hours) ?? null, medianHours: num(a.median_turnaround_hours) ?? null } : undefined,
    };
  },
  /** approve = release, reject = take down, uphold = keep an appealed hold, escalate = hand to an admin (own route). */
  moderate: (id: string, decision: ModDecision, note?: string) =>
    call<Raw>(`/issues/${enc(id)}/${decision === "escalate" ? "escalate" : "moderate"}`, { method: "POST", body: decision === "escalate" ? { note } : { decision, note } }),
  lexicon: async (): Promise<LexiconInfo> => {
    const d = await call<Raw>("/issues/moderation/lexicon", { fresh: true });
    return { version: num(d?.version), changes: list<Raw>(d, "changes").map(decodeLexChange), lists: list<unknown>(d, "lists").map(String), approvalsNeeded: { add: Number(d?.approvals_needed?.add ?? 1), retire: Number(d?.approvals_needed?.retire ?? 2) } };
  },
  /** Propose adding or removing (retiring) a term. A different moderator must review it; retirements need more approvals. */
  proposeTerm: (term: string, action: "add" | "remove", list?: string) => call<Raw>("/issues/moderation/lexicon", { method: "POST", body: { term, action, list } }),
  reviewTerm: async (id: string, decision: "approve" | "reject"): Promise<LexReviewResult> => {
    const d = await call<Raw>(`/issues/moderation/lexicon/${enc(id)}/review`, { method: "POST", body: { decision } });
    return { status: String(d?.status ?? ""), approvals: num(d?.approvals), approvalsNeeded: num(d?.approvals_needed), version: num(d?.version) };
  },
  // ---- admin/* (S-140) and audit (S-144) ----
  roleRequests: async (): Promise<RoleRequest[]> => list<Raw>(await call<unknown>("/admin/roles/requests", { fresh: true }), "requests").map((r) => ({
    id: String(r.id), action: r.action === "revoke" ? "revoke" : "grant", personId: String(r.person_id), role: String(r.role), scope: str(r.jurisdiction), department: str(r.department), reason: str(r.reason),
    status: String(r.status ?? "pending"), requestedBy: str(r.requested_by), createdAt: str(r.created_at), expiresAt: str(r.expires_at), decidedBy: str(r.decided_by) ?? null })),
  /** File a dual-control request. Needs the admin's own TOTP code. A DIFFERENT admin must approve it within 72 hours. */
  requestRole: (b: { action: "grant" | "revoke"; personId: string; role: string; scope?: string; department?: string; reason: string }, mfa: Mfa) =>
    call<Raw>("/admin/roles/requests", { method: "POST", headers: mfaHeaders(mfa), body: { action: b.action, person_id: b.personId, role: b.role, jurisdiction: b.scope || undefined, department: b.department || undefined, reason: b.reason } }),
  decideRole: (id: string, decision: "approve" | "reject", mfa: Mfa) => call<Raw>(`/admin/roles/requests/${enc(id)}/${decision}`, { method: "POST", headers: mfaHeaders(mfa), body: {} }),
  /** Recovery codes come back once: the caller must show them immediately. */
  mfaEnrol: async (): Promise<MfaEnrolment> => { const d = await call<Raw>("/admin/mfa/enrol", { method: "POST", body: {} }); return { secret: String(d.secret ?? ""), uri: str(d.otpauth_uri), recoveryCodes: list<unknown>(d.recovery_codes).map(String) }; },
  /** Finishes enrolment with the first code; once enrolled it just checks a code. */
  mfaVerify: (code: string) => call<Raw>("/admin/mfa/verify", { method: "POST", body: { code } }),
  jobs: async (): Promise<{ alarm: string | null; jobs: JobRow[] }> => {
    const d = await call<Raw>("/ops/jobs", { fresh: true });
    return { alarm: d?.alarm ? String(d.alarm.detail ?? d.alarm.kind ?? "alarm") : null, jobs: list<Raw>(d, "jobs").map((j) => ({ name: String(j.name), runs: Number(j.runs ?? 0), failures: Number(j.failures ?? 0), lastRunAt: str(j.lastRunAt), lastOk: typeof j.lastOk === "boolean" ? j.lastOk : null, lastError: str(j.lastError) ?? null })) };
  },
  auditHead: async (): Promise<AuditHead | null> => {
    const d = await call<Raw>("/audit/head", { auth: false, fresh: true });
    const h = d?.head;
    return h?.hash ? { hash: String(h.hash), seq: num(h.seq), ts: str(h.ts), count: num(d.count) ?? 0, anchorSink: str(d.anchor?.sink), anchorConfigured: d.anchor?.configured === true, unanchored: num(d.anchor?.unanchored_entries) ?? 0 } : null;
  },
  /** GET /audit/verify: 200 ok, 409 when the chain, the anchor or the witness copy disagrees (an alarm, not an error). */
  auditVerify: async (): Promise<AuditVerify> => {
    try { const d = await call<Raw>("/audit/verify", { auth: false, fresh: true }); return { ok: true, chainOk: d.chain_ok !== false, anchorMatches: typeof d.anchor_matches_chain === "boolean" ? d.anchor_matches_chain : null, witnessReachable: d.witness?.reachable, witnessMatches: d.witness?.matches_local }; }
    catch (x) {
      if (x instanceof CivicApiError && x.status === 409) { const d = x.body as Raw; return { ok: false, chainOk: d.chain_ok !== false, anchorMatches: typeof d.anchor_matches_chain === "boolean" ? d.anchor_matches_chain : null, witnessReachable: d.witness?.reachable, witnessMatches: d.witness?.matches_local }; }
      throw x;
    }
  },
};

// ---- S-141 verified officer onboarding (/officers) ----
export type OfficerAppStatus = "submitted" | "awaiting_second_admin" | "approved" | "rejected" | "withdrawn" | "expired";
export interface OfficerApplication {
  id: string; status: OfficerAppStatus; department: string; designation?: string; jurisdiction?: string; emailDomain: string; letterChecked: boolean; emailConfirmed: boolean; canConfirmEmail: boolean; createdAt?: string; canWithdraw: boolean;
  /** Admin queue only. */
  personId?: string; fullName?: string; officialEmail?: string; roleRequestId?: string; reviewNote?: string;
}
const decodeApp = (r: Raw): OfficerApplication => ({
  id: String(r.id), status: String(r.status) as OfficerAppStatus, department: String(r.department ?? ""), designation: str(r.designation), jurisdiction: str(r.jurisdiction), emailDomain: String(r.email_domain ?? ""),
  letterChecked: r.letter_checked === true, emailConfirmed: r.email_confirmed === true, canConfirmEmail: r.can_confirm_email === true, createdAt: str(r.created_at), canWithdraw: r.can_withdraw === true,
  personId: str(r.person_id), fullName: str(r.full_name), officialEmail: str(r.official_email), roleRequestId: str(r.role_request_id), reviewNote: str(r.review_note),
});
export const officersApi = {
  domains: async (): Promise<{ domains: { domain: string; bodyEn: string; bodyTe: string }[]; departments: string[] }> => {
    const d = await call<Raw>("/officers/domains", { auth: false });
    return { domains: list<Raw>(d, "domains").map((x) => ({ domain: String(x.domain), bodyEn: String(x.body_en ?? x.domain), bodyTe: String(x.body_te ?? x.body_en ?? x.domain) })), departments: list<unknown>(d?.departments).map(String) };
  },
  mine: async (): Promise<OfficerApplication[]> => list<Raw>(await call<Raw>("/officers/applications/mine", { fresh: true }), "applications").map(decodeApp),
  apply: (b: { fullName: string; department: string; designation?: string; email: string; jurisdiction?: string; letterRef: string }) =>
    call<{ id: string; status: string; email_confirmation?: string; dev_email_code?: string }>("/officers/applications", { method: "POST", body: { full_name: b.fullName, department: b.department, designation: b.designation || undefined, official_email: b.email, jurisdiction: b.jurisdiction || undefined, letter_ref: b.letterRef } }),
  withdraw: (id: string) => call<Raw>(`/officers/applications/${enc(id)}/withdraw`, { method: "POST", body: {} }),
  /** Proof of e-mail ownership: ask for a new code, then send the code the applicant received. */
  resendEmail: (id: string) => call<{ ok: boolean; dev_email_code?: string }>(`/officers/applications/${enc(id)}/email/resend`, { method: "POST", body: {} }),
  confirmEmail: (id: string, code: string) => call<Raw>(`/officers/applications/${enc(id)}/email/confirm`, { method: "POST", body: { code } }),
  queue: async (status = "submitted"): Promise<OfficerApplication[]> => list<Raw>(await call<Raw>(`/officers/admin/queue?status=${enc(status)}`, { fresh: true }), "applications").map(decodeApp),
  /** The letter as an object URL (the caller revokes it); null when it cannot be shown. */
  letterObjectUrl: async (id: string): Promise<string | null> => {
    const tok = tokenStore.get();
    if (!tok) return null;
    try { const res = await fetch(`${BASE}/officers/admin/applications/${enc(id)}/letter`, { headers: { authorization: `Bearer ${tok}` }, cache: "no-store" }); return res.ok ? URL.createObjectURL(await res.blob()) : null; } catch { return null; }
  },
  verify: (id: string, note: string, mfa: Mfa) => call<Raw>(`/officers/admin/applications/${enc(id)}/verify`, { method: "POST", headers: mfaHeaders(mfa), body: { letter_checked: true, note: note || undefined } }),
  reject: (id: string, note: string, mfa: Mfa) => call<Raw>(`/officers/admin/applications/${enc(id)}/reject`, { method: "POST", headers: mfaHeaders(mfa), body: { note } }),
};

// ---- S-145 representative replies (/representatives) ----
export interface ReplyVersion { id: string; version: number; status: "visible" | "held" | "removed"; text: string; tags: string[]; holdReasons: string[]; createdAt?: string }
export interface HeldReply { id: string; issueId: string; version: number; constituency: string; text: string; tags: string[]; reasons: string[] }
const decodeVersion = (r: Raw): ReplyVersion => ({ id: String(r.id), version: num(r.version) ?? 1, status: r.status === "held" || r.status === "removed" ? r.status : "visible", text: String(r.text ?? ""), tags: list<unknown>(r.scheme_tags).map(String), holdReasons: list<unknown>(r.hold_reasons).map(String), createdAt: str(r.created_at) });
export const representativesApi = {
  schemes: async (): Promise<SchemeTagInfo[]> => list<Raw>(await call<Raw>("/representatives/schemes", { auth: false }), "schemes").map((t) => ({ id: String(t.id), labelEn: String(t.label_en), labelTe: String(t.label_te) })),
  post: async (issueId: string, text: string, tags: string[]): Promise<ReplyVersion> => decodeVersion(await call<Raw>(`/representatives/issues/${enc(issueId)}/reply`, { method: "POST", body: { text, scheme_tags: tags } })),
  revise: async (issueId: string, text: string, tags: string[]): Promise<ReplyVersion> => decodeVersion(await call<Raw>(`/representatives/issues/${enc(issueId)}/reply/revise`, { method: "POST", body: { text, scheme_tags: tags } })),
  mine: async (issueId: string): Promise<ReplyVersion[]> => list<Raw>(await call<Raw>(`/representatives/issues/${enc(issueId)}/reply/mine`, { fresh: true }), "versions").map(decodeVersion),
  heldQueue: async (): Promise<HeldReply[]> => list<Raw>(await call<Raw>("/representatives/moderation/queue", { fresh: true }), "replies").map((r) => ({ id: String(r.id), issueId: String(r.issue_id), version: num(r.version) ?? 1, constituency: String(r.constituency ?? ""), text: String(r.text ?? ""), tags: list<unknown>(r.scheme_tags).map(String), reasons: list<unknown>(r.reasons).map(String) })),
  review: (id: string, decision: "approve" | "hold" | "remove", note?: string) => call<Raw>(`/representatives/replies/${enc(id)}/review`, { method: "POST", body: { decision, note: note || undefined } }),
};

// ---- Assisted participation (S-49). The server answers 404 {code: "assisted_disabled"} while the feature is off: callers treat that as "hide". ----
export interface AssistedPlace { lgd: string; name_en: string; name_te: string | null }
export interface AssistedPair { id: string; village: AssistedPlace; label: string | null; status: string; suspendedReason: string | null; records: number; queued: number; checked: number; notConfirmed: number; notConfirmedRate: number | null }
export interface AssistedRecheck { recordId: string; pairId: string; village: AssistedPlace | null; category: string; flagged: boolean; textEn: string | null; textTe: string | null; dueBy: string | null; overdue: boolean }
export interface AssistedAlert { kind: "unconfirmed_rate" | "assisted_share"; pairId: string | null; unit: AssistedPlace | null; rate: number; sample: number }
export interface AssistedSegmentItem { id: string; category: string; status: string; village: AssistedPlace | null; snippet: string | null; snippetTe: string | null; createdAt: string }
export interface AssistedSegment { labelEn: string; labelTe: string; noteEn: string; noteTe: string; items: AssistedSegmentItem[] }
export interface AssistedConsent { adult: boolean; explained: boolean; willing_self: boolean; deletion_known: boolean }
export interface AssistedReceipt { id: string; held: boolean; receiptCode: string; recheckQueued: boolean }
export const isAssistedDisabled = (e: unknown): boolean => e instanceof CivicApiError && e.status === 404 && (e.body as { code?: string }).code === "assisted_disabled";
const place = (p: Raw | null | undefined): AssistedPlace | null => (p ? { lgd: String(p.lgd), name_en: String(p.name_en ?? p.lgd), name_te: str(p.name_te) ?? null } : null);

export const assistedApi = {
  /** The signed-in volunteer's active pair (null when none). Throws a 404 assisted_disabled error while the feature is off (see isAssistedDisabled). */
  myPair: async (): Promise<{ pairId: string; village: AssistedPlace | null; label: string | null } | null> => {
    const d = await call<Raw>("/assisted/my-pair", { fresh: true });
    return d?.in_pair ? { pairId: String(d.pair_id), village: place(d.village as Raw), label: str(d.label) ?? null } : null;
  },
  /** Both assistants must authenticate: the signed-in one in the usual header, the partner with a token from their own sign-in (never stored). */
  record: async (partnerToken: string, b: { category: string; description_en?: string; description_te?: string; consent_a: AssistedConsent; consent_b: AssistedConsent }): Promise<AssistedReceipt> => {
    const d = await call<Raw>("/assisted/records", { method: "POST", body: { ...b, adult_attested: true }, headers: { "x-assist-partner-authorization": `Bearer ${partnerToken}` } });
    return { id: String(d.id), held: d.held === true, receiptCode: String(d.receipt_code), recheckQueued: d.recheck_queued === true };
  },
  segment: async (): Promise<AssistedSegment> => {
    const d = await call<Raw>("/assisted/segment?limit=25", { auth: false, fresh: true });
    return {
      labelEn: String(d.label_en), labelTe: String(d.label_te), noteEn: String(d.note_en), noteTe: String(d.note_te),
      items: list<Raw>(d, "items").map((i) => ({ id: String(i.id), category: String(i.category), status: String(i.status), village: place(i.village as Raw), snippet: str(i.snippet) ?? null, snippetTe: str(i.snippet_te) ?? null, createdAt: String(i.created_at) })),
    };
  },
  receiptStatus: async (code: string): Promise<{ state: string; deleted: boolean; status: string | null }> => { const d = await call<Raw>("/assisted/receipts/status", { method: "POST", body: { code }, auth: false }); return { state: String(d.state), deleted: d.deleted === true, status: str(d.status) ?? null }; },
  receiptDelete: async (code: string): Promise<boolean> => (await call<Raw>("/assisted/receipts/delete", { method: "POST", body: { code }, auth: false })).deleted === true,
  pairs: async (): Promise<AssistedPair[]> => {
    const d = await call<Raw>("/assisted/pairs", { fresh: true });
    return list<Raw>(d, "pairs").map((p) => ({
      id: String(p.id), village: place(p.village as Raw) ?? { lgd: "", name_en: "", name_te: null }, label: str(p.label) ?? null, status: String(p.status), suspendedReason: str(p.suspended_reason) ?? null,
      records: Number(p.records ?? 0), queued: Number(p.queued ?? 0), checked: Number(p.checked ?? 0), notConfirmed: Number(p.not_confirmed ?? 0), notConfirmedRate: typeof p.not_confirmed_rate === "number" ? p.not_confirmed_rate : null,
    }));
  },
  createPair: async (b: { village_lgd: string; member_a: string; member_b: string; label?: string }) => call<Raw>("/assisted/pairs", { method: "POST", body: b }),
  suspendPair: async (id: string, reason: string) => call<Raw>(`/assisted/pairs/${encodeURIComponent(id)}/suspend`, { method: "POST", body: { reason } }),
  alerts: async (): Promise<{ alerts: AssistedAlert[]; thresholds: Record<string, number> }> => {
    const d = await call<Raw>("/assisted/alerts", { fresh: true });
    return { thresholds: (d.thresholds ?? {}) as Record<string, number>, alerts: list<Raw>(d, "alerts").map((a) => ({ kind: String(a.kind) as AssistedAlert["kind"], pairId: str(a.pair_id) ?? null, unit: place(a.unit as Raw), rate: Number(a.rate ?? 0), sample: Number(a.sample ?? 0) })) };
  },
  reinstatePair: async (id: string, reason: string) => call<Raw>(`/assisted/pairs/${encodeURIComponent(id)}/reinstate`, { method: "POST", body: { reason } }),
  holdArea: async (lgd: string, hold: boolean, reason: string) => call<Raw>(`/assisted/areas/${encodeURIComponent(lgd)}/${hold ? "suspend" : "resume"}`, { method: "POST", body: { reason } }),
  areaHolds: async (): Promise<{ unit: string; reason: string }[]> => list<Raw>(await call<Raw>("/assisted/areas/holds", { fresh: true }), "holds").map((h) => ({ unit: String(h.unit), reason: String(h.reason) })),
  pairRecords: async (id: string): Promise<{ recordId: string; category: string; snippet: string | null; deleted: boolean; createdAt: string }[]> =>
    list<Raw>(await call<Raw>(`/assisted/pairs/${encodeURIComponent(id)}/records`, { fresh: true }), "records").map((r) => ({ recordId: String(r.record_id), category: String(r.category), snippet: str(r.snippet) ?? null, deleted: r.deleted === true, createdAt: String(r.created_at) })),
  requestDeletion: async (recordId: string, reason: string) => call<Raw>("/assisted/delete-requests", { method: "POST", body: { record_id: recordId, reason } }),
  deletionRequests: async (): Promise<{ id: string; recordId: string; reason: string; mine: boolean }[]> =>
    list<Raw>(await call<Raw>("/assisted/delete-requests", { fresh: true }), "requests").map((r) => ({ id: String(r.id), recordId: String(r.record_id), reason: String(r.reason), mine: r.mine === true })),
  decideDeletion: async (id: string, approve: boolean) => call<Raw>(`/assisted/delete-requests/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`, { method: "POST", body: {} }),
  rechecks: async (): Promise<AssistedRecheck[]> => {
    const d = await call<Raw>("/assisted/rechecks", { fresh: true });
    return list<Raw>(d, "items").map((r) => ({ recordId: String(r.record_id), pairId: String(r.pair_id), village: place(r.village as Raw), category: String(r.category), flagged: r.flagged === true, textEn: str(r.text_en) ?? null, textTe: str(r.text_te) ?? null, dueBy: str(r.due_by) ?? null, overdue: r.overdue === true }));
  },
  submitRecheck: async (recordId: string, outcome: "confirmed" | "not_confirmed" | "unreachable", note?: string) => call<Raw>(`/assisted/rechecks/${encodeURIComponent(recordId)}`, { method: "POST", body: { outcome, note: note || undefined } }),
};

// ---- S-201 photo review (/api/v1/photos/admin, outside /civic but the same admin sign-in) ----
export interface PhotoSubmission {
  id: string; created_at: string; state: string; ac_no: number; year: number; candidate: string; claimed_name: string; relationship: string; holder: string;
  contact: string | null; status: "pending" | "approved" | "rejected"; decided_at: string | null; note: string | null;
}
export const photoReviewApi = {
  list: async (status: string): Promise<PhotoSubmission[]> => (await call<{ submissions: PhotoSubmission[] }>(`/photos/admin/submissions?status=${enc(status)}`, { root: true, fresh: true })).submissions ?? [],
  decide: (id: string, status: "approved" | "rejected", note: string) => call<{ ok: boolean }>(`/photos/admin/submissions/${enc(id)}/decide`, { root: true, method: "POST", body: { status, note: note || undefined } }),
  /** The submitted image as an object URL (the caller revokes it); null when it cannot be shown. */
  imageObjectUrl: async (id: string): Promise<string | null> => {
    const tok = tokenStore.get();
    if (!tok) return null;
    try { const res = await fetch(`/api/v1/photos/admin/submissions/${enc(id)}/file`, { headers: { authorization: `Bearer ${tok}` }, cache: "no-store" }); return res.ok ? URL.createObjectURL(await res.blob()) : null; } catch { return null; }
  },
};
