/**
 * Generic configurable HTTP mail adapter (S-141): a MailProvider for a transactional e-mail API that takes one authenticated HTTP POST
 * per message (JSON or form body carrying recipient, sender, subject and plain text).
 *
 * NOT RUN AGAINST ANY REAL VENDOR. It is tested only against the local simulator (providers/mock/genericMailServer.ts). No vendor is
 * chosen. The request field names, auth header and body format are CONFIGURATION below; the correct values for a real vendor MUST be
 * confirmed against that vendor's documentation and a sandbox run before use. Sender-domain authentication (SPF/DKIM/DMARC) is a human
 * step at the vendor and in DNS; nothing here can verify it. A vendor whose flow does not fit (OAuth tokens, SMTP, multipart, XML,
 * nested JSON bodies) needs its own MailProvider.
 *
 * Rules kept (see mail.ts): one bounded attempt, no retries (the caller offers a resend); at most one send per idempotencyKey in this
 * process (the key is also sent as an Idempotency-Key header and a mapped field so a vendor that honours it dedupes across restarts);
 * the recipient and the body (a one-time code) are NEVER logged and never placed in an error message. Errors are ProviderError with a
 * fixed text, a kind and (for HTTP) the status code only.
 *
 * Environment (see .env.example):
 *   CIVIC_MAIL_URL             submit endpoint (https required in production); installs this adapter when set
 *   CIVIC_MAIL_AUTH_HEADER     header name carrying the credential (default Authorization)
 *   CIVIC_MAIL_AUTH_VALUE      header value, e.g. "Bearer <token>" (secret, required)
 *   CIVIC_MAIL_FROM            sender address
 *   CIVIC_MAIL_FORMAT          json (default) or form (application/x-www-form-urlencoded)
 *   CIVIC_MAIL_REQUEST_FIELDS  JSON mapping to/from/subject/text/idempotencyKey to vendor field names; omitted keys keep neutral names
 *   CIVIC_MAIL_STATIC_FIELDS   JSON of constant extra fields
 *   CIVIC_MAIL_TIMEOUT_MS      deadline for the single attempt (default 5000)
 */
import type { MailMessage, MailProvider } from "./mail";
import { ProviderError, assertSecureUrl, providerLog, type FetchLike } from "./util";

export interface GenericMailConfig {
  url: string;
  authHeader?: string; authValue: string;
  from?: string;
  format?: "json" | "form";
  requestFields?: Partial<Record<"to" | "from" | "subject" | "text" | "idempotencyKey", string>>;
  staticFields?: Record<string, string | number | boolean>;
  timeoutMs?: number; fetchImpl?: FetchLike;
}

export const DEFAULT_MAIL_FIELDS = { to: "to", from: "from", subject: "subject", text: "text", idempotencyKey: "idempotency_key" } as const;

export class GenericHttpMailProvider implements MailProvider {
  readonly name = "generic-http";
  private f: Record<string, string | undefined>;
  private sent = new Set<string>();
  private inflight = new Map<string, Promise<void>>();
  constructor(private c: GenericMailConfig) {
    assertSecureUrl(c.url, "CIVIC_MAIL_URL");
    if (!c.authValue) throw new ProviderError("CIVIC_MAIL_AUTH_VALUE is required", "config");
    this.f = { ...DEFAULT_MAIL_FIELDS, ...(c.requestFields ?? {}) };
  }

  /** The exact request fields, exposed for tests and for checking the mapping against vendor documentation. */
  buildFields(m: MailMessage): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = { ...(this.c.staticFields ?? {}) };
    const set = (key: string, v: string | undefined) => { const name = this.f[key]; if (name && v) out[name] = v; };
    set("to", m.to); set("from", this.c.from); set("subject", m.subject); set("text", m.text); set("idempotencyKey", m.idempotencyKey);
    return out;
  }

  send(m: MailMessage): Promise<void> {
    const k = m.idempotencyKey;
    if (!k) return this.attempt(m);
    if (this.sent.has(k)) return Promise.resolve();
    const running = this.inflight.get(k);
    if (running) return running;
    const p = this.attempt(m).then(() => { this.sent.add(k); }).finally(() => { this.inflight.delete(k); });
    this.inflight.set(k, p);
    return p;
  }

  private async attempt(m: MailMessage): Promise<void> {
    const timeoutMs = this.c.timeoutMs ?? 5000;
    const fields = this.buildFields(m);
    const form = this.c.format === "form";
    const body = form ? new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(fields);
    const headers: Record<string, string> = { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json", [this.c.authHeader || "Authorization"]: this.c.authValue };
    if (m.idempotencyKey) headers["Idempotency-Key"] = m.idempotencyKey;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const doFetch: FetchLike = this.c.fetchImpl ?? ((u, i) => fetch(u, i) as never);
    try {
      const res = await doFetch(this.c.url, { method: "POST", headers, body, signal: ac.signal });
      await res.text().catch(() => ""); // drain; the answer is never used or logged
      if (res.status < 200 || res.status >= 300) throw new ProviderError(`mail provider answered HTTP ${res.status}`, "http", res.status);
    } catch (e) {
      const err = e instanceof ProviderError ? e
        : ac.signal.aborted ? new ProviderError(`mail provider timed out after ${timeoutMs} ms`, "timeout")
        : new ProviderError("mail provider unreachable", "network"); // the underlying message may carry the URL, host or request
      providerLog("mail", "send_failed", { kind: err.kind, status: err.status });
      throw err;
    } finally { clearTimeout(timer); }
  }
}

const jsonEnv = <T>(v: string | undefined, name: string): T | undefined => {
  if (!v) return undefined;
  try { const x = JSON.parse(v); if (x && typeof x === "object" && !Array.isArray(x)) return x as T; } catch { /* fall through */ }
  throw new ProviderError(`${name} must be a JSON object`, "config");
};

/** Build the adapter config from the environment. Malformed JSON throws ProviderError("config"): fail at startup, not at first send. */
export function genericMailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GenericMailConfig {
  const t = Number(env.CIVIC_MAIL_TIMEOUT_MS);
  return {
    url: env.CIVIC_MAIL_URL ?? "", authHeader: env.CIVIC_MAIL_AUTH_HEADER || undefined, authValue: env.CIVIC_MAIL_AUTH_VALUE ?? "",
    from: env.CIVIC_MAIL_FROM || undefined, format: env.CIVIC_MAIL_FORMAT === "form" ? "form" : "json",
    requestFields: jsonEnv(env.CIVIC_MAIL_REQUEST_FIELDS, "CIVIC_MAIL_REQUEST_FIELDS"), staticFields: jsonEnv(env.CIVIC_MAIL_STATIC_FIELDS, "CIVIC_MAIL_STATIC_FIELDS"),
    timeoutMs: env.CIVIC_MAIL_TIMEOUT_MS && Number.isFinite(t) && t > 0 ? t : undefined,
  };
}
