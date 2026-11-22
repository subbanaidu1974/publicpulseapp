/**
 * Shared plumbing for provider adapters (S-62/S-63/S-64, docs/PROVIDERS.md): neutral HTTP/JSON with HMAC auth, timeouts, a circuit
 * breaker, backoff and a PII-scrubbing logger. Nothing here knows any vendor.
 */
import crypto from "node:crypto";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export class ProviderError extends Error {
  constructor(message: string, readonly kind: "timeout" | "network" | "http" | "circuit_open" | "bad_response" | "config", readonly status?: number) { super(message); this.name = "ProviderError"; }
  /** 5xx, 429, timeouts, network and an open circuit are worth retrying; other 4xx and malformed answers are not. */
  get retryable(): boolean { return this.kind === "timeout" || this.kind === "network" || this.kind === "circuit_open" || (this.kind === "http" && (this.status === 429 || (this.status ?? 0) >= 500)); }
}

const isProd = () => process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production";

/** Provider endpoints must use TLS in production; plain http is allowed only outside production (mock servers, localhost). */
export function assertSecureUrl(url: string, what: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new ProviderError(`${what} is not a valid URL`, "config"); }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && !isProd()) return;
  throw new ProviderError(`${what} must be an https URL in production`, "config");
}

// --- signing -------------------------------------------------------------------------------------------------------------------

/** Neutral signature: hex HMAC-SHA256 over `${timestampMs}.${rawBody}`; sent as X-Civic-Timestamp + X-Civic-Signature: sha256=<hex>. */
export const signBody = (secret: string, ts: string, body: string): string => crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

export function verifySignature(secret: string, ts: string | undefined, sigHeader: string | undefined, body: string, now = Date.now(), skewMs = 5 * 60_000): boolean {
  if (!secret || !ts || !sigHeader || !/^\d{12,14}$/.test(ts)) return false;
  if (Math.abs(now - Number(ts)) > skewMs) return false;
  const given = Buffer.from(sigHeader.replace(/^sha256=/i, ""), "hex"), want = Buffer.from(signBody(secret, ts, body), "hex");
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

export function signedHeaders(secret: string, body: string, now = Date.now()): Record<string, string> {
  const ts = String(Math.floor(now));
  return { "content-type": "application/json", "x-civic-timestamp": ts, "x-civic-signature": "sha256=" + signBody(secret, ts, body) };
}

// --- HTTP ------------------------------------------------------------------------------------------------------------------------

export interface PostOpts { secret?: string; timeoutMs: number; fetchImpl?: FetchLike; headers?: Record<string, string>; now?: () => number }

/** POST JSON with a hard deadline. Throws ProviderError (never returns a non-2xx). The body is never logged. */
export async function postJson<T = unknown>(url: string, payload: unknown, o: PostOpts): Promise<T> {
  const body = JSON.stringify(payload);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  const f: FetchLike = o.fetchImpl ?? ((u, i) => fetch(u, i) as never);
  try {
    const headers = { ...(o.secret ? signedHeaders(o.secret, body, o.now?.() ?? Date.now()) : { "content-type": "application/json" }), ...(o.headers ?? {}) };
    const res = await f(url, { method: "POST", headers, body, signal: ac.signal });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new ProviderError(`provider answered HTTP ${res.status}`, "http", res.status);
    try { return (text ? JSON.parse(text) : {}) as T; } catch { throw new ProviderError("provider answer is not JSON", "bad_response"); }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (ac.signal.aborted) throw new ProviderError(`provider timed out after ${o.timeoutMs} ms`, "timeout");
    throw new ProviderError("provider unreachable", "network"); // the underlying message may carry the URL/host; keep it out of logs
  } finally { clearTimeout(timer); }
}

// --- circuit breaker ----------------------------------------------------------------------------------------------------------

/** closed -> (threshold consecutive failures) -> open -> (cooldown) -> half-open (one probe) -> closed on success / open on failure. */
export class CircuitBreaker {
  private failures = 0; private openedAt = 0; private probing = false;
  constructor(private threshold = 5, private cooldownMs = 30_000, private clock: () => number = Date.now) {}
  get state(): "closed" | "open" | "half-open" {
    if (this.failures < this.threshold) return "closed";
    return this.clock() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
  }
  /** May a call go out now? In half-open exactly one probe is let through. */
  allow(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "half-open" && !this.probing) { this.probing = true; return true; }
    return false;
  }
  success(): void { this.failures = 0; this.probing = false; }
  failure(): void { this.failures++; this.probing = false; if (this.failures >= this.threshold) this.openedAt = this.clock(); }
}

/** Exponential backoff with full jitter: random in [0, min(cap, base * 2^(attempt-1))]. attempt starts at 1. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1)));
}

// --- logging ---------------------------------------------------------------------------------------------------------------------

const DROP_KEYS = /^(to|text|body|phone|number|otp|code|msisdn|plaintext|key|secret|token|payload|value|data)$/i;
/** Redact anything that looks like a phone number / OTP-sized digit run. */
export function scrub(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\+?\d[\d\s-]{4,}\d/g, "[redacted]").slice(0, 200);
  if (typeof v === "number" || typeof v === "boolean" || v == null) return v;
  return "[object]";
}
export type ProviderLogger = (line: string) => void;
const defaultLogger: ProviderLogger = (l) => { if (process.env.NODE_ENV !== "test" && !process.env.VITEST) console.warn(l); };
let logger: ProviderLogger = defaultLogger;
export function setProviderLogger(l: ProviderLogger | null): void { logger = l ?? defaultLogger; }
/** One JSON line per event; only scalar fields, PII-named fields dropped, digit runs redacted. */
export function providerLog(component: string, event: string, fields: Record<string, unknown> = {}): void {
  const out: Record<string, unknown> = { component, event };
  for (const [k, v] of Object.entries(fields)) if (!DROP_KEYS.test(k)) out[k] = scrub(v);
  try { logger("[civic-provider] " + JSON.stringify(out)); } catch { /* logging never breaks a request */ }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
