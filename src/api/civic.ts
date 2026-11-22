/** Typed client for /api/v1/civic (identity, households, geo, issues). The session token is kept in sessionStorage only. */
const BASE = "/api/v1/civic";
const TOKEN_KEY = "civic-token";

export class CivicApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "error") { super(message); this.status = status; this.code = code; }
}

export interface Village { lgd: string; nameEn: string; nameTe?: string; mandal?: string; district?: string }
export interface Issue { id: string; category: string; text?: string; status: string; villageLgd?: string; unit?: string; createdAt?: string }
export interface Session { token: string; personId?: string; tier?: string }
export interface OtpRequestResult { ok: boolean; devOtp?: string }

export const tokenStore = {
  get(): string | null { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t: string) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* storage unavailable */ } },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean; fresh?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const tok = tokenStore.get();
  if (tok && init.auth !== false) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: init.method ?? "GET", headers, cache: init.fresh ? "no-cache" : undefined, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new CivicApiError("network", 0, "network");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (data as { error?: string | { code?: string; message?: string } } | null)?.error;
    const code = typeof e === "string" ? e : e?.code ?? "error";
    throw new CivicApiError(typeof e === "object" && e?.message ? e.message : code, res.status, code);
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
  reportIssue: (a: { category: string; text: string; villageLgd: string; audioKey?: string }) => {
    const te = /[ఀ-౿]/.test(a.text);
    return call<{ id: string; merged?: boolean }>("/issues", { method: "POST", body: { category: a.category, village_lgd: a.villageLgd, [te ? "description_te" : "description_en"]: a.text || "Voice note", photo_ref: a.audioKey } });
  },
  /** Public feed: latest event per issue (no reporter identity, no free text). */
  listIssues: async (): Promise<Issue[]> => {
    const ev = list<EventDto>(await call<unknown>("/issues/feed?limit=200", { auth: false, fresh: true }), "events");
    const latest = new Map<string, Issue>();
    for (const e of ev) latest.set(e.issue_id, { id: e.issue_id, category: e.category, status: e.status ?? e.type, villageLgd: e.village_lgd });
    return [...latest.values()].reverse().slice(0, 50);
  },
};
