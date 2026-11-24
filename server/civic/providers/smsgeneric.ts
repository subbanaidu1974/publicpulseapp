/**
 * Generic configurable HTTP SMS-gateway adapter (S-63, E2E-78). A SmsTransport for "typical" Indian DLT gateways that take one HTTP call per
 * message with an auth header and a body carrying destination, text, sender (header), DLT template id and DLT entity id.
 *
 * NOT RUN AGAINST ANY REAL GATEWAY. It is tested only against the local simulator (providers/mock/genericSmsServer.ts) through the shared
 * contract suite. No vendor is chosen. The names of request fields, response paths, receipt format and signature scheme are CONFIGURATION
 * below; the correct values for a real vendor MUST be confirmed against that vendor's documentation and sandbox before use. Everything
 * vendor-independent (DLT template registry and production refusal of unregistered text, idempotency, ledger, retries, dead letters,
 * circuit breaker, cost accounting, receipts route, quiet failure policy) is inherited from ManagedSmsProvider.
 *
 * Environment (see .env.example):
 *   CIVIC_SMSGW_URL            submit endpoint (https in production; installs this adapter when CIVIC_SMS_URL is not set)
 *   CIVIC_SMSGW_AUTH_HEADER    header name carrying the credential (default Authorization)
 *   CIVIC_SMSGW_AUTH_VALUE     header value, e.g. "Bearer <token>" or "<api key>" (secret)
 *   CIVIC_SMSGW_ENTITY_ID      DLT principal entity id, sent when the field mapping names `entityId`
 *   CIVIC_SMSGW_FORMAT         json (default) or form (application/x-www-form-urlencoded)
 *   CIVIC_SMSGW_REQUEST_FIELDS JSON, request field names, e.g. {"to":"mobile","text":"message","sender":"senderid","templateId":"dlt_te_id",
 *                              "entityId":"dlt_pe_id","reference":"ref","callbackUrl":"dlr_url"}; omitted keys keep the neutral default names
 *   CIVIC_SMSGW_STATIC_FIELDS  JSON of constant extra fields (e.g. {"route":"transactional","unicode":"1"}). Telugu needs UCS-2/unicode flags on most gateways.
 *   CIVIC_SMSGW_RESPONSE_PATHS JSON dot paths into the submit answer: {"id":"data.id","status":"data.state","cost":"data.price","currency":"data.cur"}
 *   CIVIC_SMSGW_RECEIPT_PATHS  JSON for receipts: {"list":"dlr","id":"id","status":"state","error":"err"} (list "" = body is the array or one object)
 *   CIVIC_SMSGW_RECEIPT_SECRET HMAC-SHA256 secret over the raw receipt body (hex digest, optional "sha256=" prefix) in CIVIC_SMSGW_RECEIPT_SIG_HEADER
 *                              (default x-signature); OR CIVIC_SMSGW_RECEIPT_TOKEN + CIVIC_SMSGW_RECEIPT_TOKEN_HEADER (static token, constant-time compare)
 *   CIVIC_SMSGW_TIMEOUT_MS     per-attempt deadline (default: the gateway default, CIVIC_SMS_TIMEOUT_MS)
 * Unsigned receipts are never accepted: with neither a secret nor a token configured every receipt is refused (401).
 */
import crypto from "node:crypto";
import { ManagedSmsProvider, normalizeSmsStatus, safeEqual, SmsRejectedError, type SmsGatewayOpts, type SmsReceipt, type SmsSubmit, type SmsSubmitResult, type SmsTransport } from "./sms";
import { ProviderError, assertSecureUrl, type FetchLike } from "./util";

export interface GenericSmsConfig {
  url: string;
  authHeader?: string; authValue: string;
  entityId?: string;
  format?: "json" | "form";
  requestFields?: Partial<Record<"to" | "text" | "sender" | "templateId" | "entityId" | "reference" | "callbackUrl", string>>;
  staticFields?: Record<string, string | number | boolean>;
  responsePaths?: { id?: string; status?: string; cost?: string; currency?: string };
  receiptPaths?: { list?: string; id?: string; status?: string; error?: string; at?: string };
  receiptSecret?: string; receiptSigHeader?: string; receiptToken?: string; receiptTokenHeader?: string;
  callbackUrl?: string | null;
  timeoutMs?: number; fetchImpl?: FetchLike; now?: () => number;
}

export const DEFAULT_REQUEST_FIELDS = { to: "to", text: "text", sender: "sender_id", templateId: "dlt_template_id", entityId: "dlt_entity_id", reference: "reference", callbackUrl: "callback_url" } as const;
export const DEFAULT_RESPONSE_PATHS = { id: "message_id", status: "status", cost: "unit_cost", currency: "currency" } as const;
export const DEFAULT_RECEIPT_PATHS = { list: "receipts", id: "message_id", status: "status", error: "error_code", at: "at" } as const;

/** Read a dot path ("data.items.0.id") from parsed JSON. Own properties only; __proto__ and friends are refused. */
export function getPath(obj: unknown, p: string | undefined): unknown {
  if (!p) return obj;
  let cur: unknown = obj;
  for (const k of p.split(".")) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return undefined;
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

export class GenericHttpSmsTransport implements SmsTransport {
  readonly name = "generic-http";
  private f: Record<string, string | undefined>;
  private rp: { id: string; status?: string; cost?: string; currency?: string };
  private rc: { list: string; id: string; status: string; error?: string; at?: string };
  constructor(private c: GenericSmsConfig) {
    assertSecureUrl(c.url, "CIVIC_SMSGW_URL");
    if (!c.authValue) throw new ProviderError("CIVIC_SMSGW_AUTH_VALUE is required", "config");
    this.f = { ...DEFAULT_REQUEST_FIELDS, ...(c.requestFields ?? {}) };
    this.rp = { ...DEFAULT_RESPONSE_PATHS, ...(c.responsePaths ?? {}) } as typeof this.rp;
    this.rc = { ...DEFAULT_RECEIPT_PATHS, ...(c.receiptPaths ?? {}) } as typeof this.rc;
  }

  /** The exact request fields, exposed for tests and for checking the mapping against vendor documentation. */
  buildFields(m: SmsSubmit): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = { ...(this.c.staticFields ?? {}) };
    const set = (key: string, v: string | null | undefined) => { const name = this.f[key]; if (name && v != null && v !== "") out[name] = v; };
    set("to", m.to); set("text", m.text); set("sender", m.senderId);
    set("templateId", m.template?.dltTemplateId); set("entityId", this.c.entityId);
    set("reference", m.idempotencyKey); set("callbackUrl", this.c.callbackUrl);
    return out;
  }

  async submit(m: SmsSubmit, ctx: { timeoutMs: number }): Promise<SmsSubmitResult> {
    const fields = this.buildFields(m);
    const form = this.c.format === "form";
    const body = form ? new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(fields);
    const headers: Record<string, string> = { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json", [this.c.authHeader || "Authorization"]: this.c.authValue };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ctx.timeoutMs);
    const doFetch: FetchLike = this.c.fetchImpl ?? ((u, i) => fetch(u, i) as never);
    let status: number, text: string;
    try {
      const res = await doFetch(this.c.url, { method: "POST", headers, body, signal: ac.signal });
      status = res.status; text = await res.text();
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(ac.signal.aborted ? `gateway timed out after ${ctx.timeoutMs} ms` : "gateway unreachable", ac.signal.aborted ? "timeout" : "network");
    } finally { clearTimeout(timer); }
    if (status < 200 || status >= 300) throw new ProviderError(`gateway answered HTTP ${status}`, "http", status); // 4xx (not 429) permanent; 5xx/429 retried
    let j: unknown;
    try { j = text ? JSON.parse(text) : {}; } catch { throw new ProviderError("gateway answer is not JSON", "bad_response"); }
    const id = str(getPath(j, this.rp.id));
    if (!id) throw new ProviderError("gateway answer has no message id at the configured path", "bad_response");
    const st = normalizeSmsStatus(this.rp.status ? getPath(j, this.rp.status) : undefined) ?? "queued"; // unknown word = accepted, outcome pending
    const cost = this.rp.cost ? Number(getPath(j, this.rp.cost)) : NaN;
    const cur = this.rp.currency ? str(getPath(j, this.rp.currency)) : null;
    return { messageId: id, status: st, ...(Number.isFinite(cost) && cost >= 0 ? { unitCost: cost } : {}), ...(cur ? { currency: cur } : {}) };
  }

  verifyReceipt(raw: string, h: Record<string, string | undefined>): boolean {
    const { receiptSecret, receiptToken } = this.c;
    if (receiptSecret) {
      const given = (h[(this.c.receiptSigHeader || "x-signature").toLowerCase()] ?? "").replace(/^sha256=/i, "").trim().toLowerCase();
      const want = crypto.createHmac("sha256", receiptSecret).update(raw).digest("hex");
      return /^[0-9a-f]{64}$/.test(given) && safeEqual(given, want);
    }
    if (receiptToken) {
      const given = h[(this.c.receiptTokenHeader || "x-receipt-token").toLowerCase()];
      return !!given && safeEqual(given, receiptToken);
    }
    return false;
  }

  /** Arrow property: the receipts route calls it detached from the instance. */
  parseReceipt = (raw: string): SmsReceipt[] => {
    let j: unknown;
    try { j = JSON.parse(raw); } catch { throw new SmsRejectedError("receipt body is not JSON"); }
    const l = getPath(j, this.rc.list);
    const list = Array.isArray(l) ? l : l && typeof l === "object" ? [l] : null;
    if (!list || list.length > 500) throw new SmsRejectedError("receipt list missing or too long");
    const out: SmsReceipt[] = [];
    for (const x of list) {
      const id = str(getPath(x, this.rc.id));
      const status = normalizeSmsStatus(getPath(x, this.rc.status));
      if (!id || id.length > 128 || !status) continue;
      const err = this.rc.error ? str(getPath(x, this.rc.error)) : null;
      const at = this.rc.at ? str(getPath(x, this.rc.at)) : null;
      out.push({ messageId: id, status, ...(at ? { at: at.slice(0, 40) } : {}), ...(err ? { errorCode: err.slice(0, 40) } : {}) });
    }
    return out;
  };
}

export class GenericHttpSmsProvider extends ManagedSmsProvider {
  constructor(cfg: GenericSmsConfig, opts: SmsGatewayOpts = {}) { super(new GenericHttpSmsTransport(cfg), opts); }
}

const jsonEnv = <T>(v: string | undefined, name: string): T | undefined => {
  if (!v) return undefined;
  try { const x = JSON.parse(v); if (x && typeof x === "object" && !Array.isArray(x)) return x as T; } catch { /* fall through */ }
  throw new ProviderError(`${name} must be a JSON object`, "config");
};

/** Build the adapter config from the environment. Malformed JSON throws ProviderError("config"): fail at startup, not at first send. */
export function genericSmsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GenericSmsConfig {
  return {
    url: env.CIVIC_SMSGW_URL ?? "", authHeader: env.CIVIC_SMSGW_AUTH_HEADER || undefined, authValue: env.CIVIC_SMSGW_AUTH_VALUE ?? "",
    entityId: env.CIVIC_SMSGW_ENTITY_ID || undefined, format: env.CIVIC_SMSGW_FORMAT === "form" ? "form" : "json",
    requestFields: jsonEnv(env.CIVIC_SMSGW_REQUEST_FIELDS, "CIVIC_SMSGW_REQUEST_FIELDS"), staticFields: jsonEnv(env.CIVIC_SMSGW_STATIC_FIELDS, "CIVIC_SMSGW_STATIC_FIELDS"),
    responsePaths: jsonEnv(env.CIVIC_SMSGW_RESPONSE_PATHS, "CIVIC_SMSGW_RESPONSE_PATHS"), receiptPaths: jsonEnv(env.CIVIC_SMSGW_RECEIPT_PATHS, "CIVIC_SMSGW_RECEIPT_PATHS"),
    receiptSecret: env.CIVIC_SMSGW_RECEIPT_SECRET || undefined, receiptSigHeader: env.CIVIC_SMSGW_RECEIPT_SIG_HEADER || undefined,
    receiptToken: env.CIVIC_SMSGW_RECEIPT_TOKEN || undefined, receiptTokenHeader: env.CIVIC_SMSGW_RECEIPT_TOKEN_HEADER || undefined,
    callbackUrl: env.CIVIC_SMS_RECEIPT_URL ?? null,
  };
}
