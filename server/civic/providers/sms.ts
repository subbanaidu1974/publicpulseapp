/**
 * SMS provider contract v2 (S-63, E2E-78). Additive on top of core `SmsProvider { send(to, text) }`; every existing caller keeps working.
 *
 * Layering (docs/PROVIDERS.md):
 *   SmsTransport          what a VENDOR ADAPTER implements: submit one rendered message (+ optionally parse/verify the vendor's receipts).
 *   ManagedSmsProvider    everything vendor-independent, installed with setSmsProvider(): DLT template registry (production refuses any text
 *                         that is not an approved, registered template), idempotency keys, a durable ledger (encrypted payload only while a
 *                         retry may still need it), retry with backoff, dead letters, circuit breaker, per-message cost accounting,
 *                         delivery receipts, and the quiet failure policy.
 *   HttpSmsProvider       ManagedSmsProvider over the neutral JSON shape below (CIVIC_SMS_URL), so a vendor adapter is a thin mapper.
 *
 * QUIET FAILURE POLICY: send() never throws because the vendor is slow or down. It waits at most one attempt timeout, records the message
 * for retry/dead-letter and resolves; `health().degraded` / `smsDegraded()` tell the UI to show a degraded notice. It DOES throw for
 * policy violations (SmsTemplateError, SmsRejectedError): those are bugs or abuse, not outages.
 *
 * NEUTRAL SUBMIT SHAPE   POST CIVIC_SMS_URL   headers X-Civic-Timestamp (ms) + X-Civic-Signature: sha256=hex(HMAC(secret, `${ts}.${body}`))
 *   { "version": 1, "idempotency_key": "...", "to": "+91...", "sender_id": "PPULSE", "text": "<rendered>",
 *     "template": { "id": "otp", "dlt_template_id": "1107...", "language": "en", "category": "otp" } | null,
 *     "variables": { "code": "123456" }, "callback_url": "https://.../api/v1/civic/channels/sms-receipt" | null }
 *   -> 200 { "message_id": "...", "status": "queued|sent|delivered|failed", "unit_cost": 0.12?, "currency": "INR"? }
 * NEUTRAL RECEIPT        POST /api/v1/civic/channels/sms-receipt  (same signature scheme, secret CIVIC_SMS_RECEIPT_SECRET)
 *   { "receipts": [ { "message_id": "...", "status": "delivered", "at": "ISO"?, "error_code": "..."? } ] }
 */
import crypto from "node:crypto";
import fs from "node:fs";
import express, { Router } from "express";
import { audit, getDb, getKeys, registerMigration, type SmsProvider } from "../core";
import { CircuitBreaker, ProviderError, assertSecureUrl, backoffMs, postJson, providerLog, verifySignature, type FetchLike } from "./util";

export type SmsStatus = "queued" | "sent" | "delivered" | "failed";
export type SmsCategory = "otp" | "transactional" | "service" | "promotional";

export class SmsTemplateError extends Error { constructor(m: string) { super(m); this.name = "SmsTemplateError"; } }
export class SmsRejectedError extends Error { constructor(m: string) { super(m); this.name = "SmsRejectedError"; } }

// ---------------------------------------------------------------------------------------------------------------------------------
// Template registry (DLT)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Body slots: `{{name}}` (max 30 chars) or `{{name:120}}`. `dltTemplateId` is the id the telecom regulator's DLT portal issued. */
export interface SmsTemplate { id: string; dltTemplateId?: string; body: string; language: string; category: SmsCategory; senderId?: string }
export interface TemplateMatch { template: SmsTemplate; variables: Record<string, string> }

const SLOT = /\{\{(\w+)(?::(\d+))?\}\}/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Compiled { template: SmsTemplate; re: RegExp; names: string[]; literalLen: number }
function compile(t: SmsTemplate): Compiled {
  const names: string[] = [];
  let re = "", last = 0, literal = 0;
  for (const m of t.body.matchAll(SLOT)) {
    const lit = t.body.slice(last, m.index);
    re += esc(lit); literal += lit.length;
    names.push(m[1]);
    re += `([\\s\\S]{1,${Math.min(2000, Number(m[2] || 30))}}?)`;
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = t.body.slice(last);
  re += esc(tail); literal += tail.length;
  return { template: t, re: new RegExp("^" + re + "$"), names, literalLen: literal };
}

export class SmsTemplateRegistry {
  private list: Compiled[] = [];
  constructor(templates: SmsTemplate[] = []) { for (const t of templates) this.register(t); }
  register(t: SmsTemplate): void {
    if (!/^[a-z0-9_.-]{1,64}$/i.test(t.id)) throw new Error("template id must match [a-z0-9_.-]{1,64}");
    if (!t.body || t.body.length > 1600) throw new Error("template body missing or too long");
    const c = compile(t);
    this.list = [...this.list.filter((x) => x.template.id !== t.id), c].sort((a, b) => b.literalLen - a.literalLen); // most specific first
  }
  get(id: string): SmsTemplate | undefined { return this.list.find((c) => c.template.id === id)?.template; }
  all(): SmsTemplate[] { return this.list.map((c) => c.template); }
  /** Which approved template does this rendered text come from, and with which slot values? null = not an approved template. */
  match(text: string): TemplateMatch | null {
    if (text.length > 1600) return null;
    for (const c of this.list) {
      const m = c.re.exec(text);
      if (m) return { template: c.template, variables: Object.fromEntries(c.names.map((n, i) => [n, m[i + 1]])) };
    }
    return null;
  }
  render(id: string, vars: Record<string, string>): string {
    const t = this.get(id);
    if (!t) throw new SmsTemplateError(`unknown SMS template "${id}"`);
    return t.body.replace(SLOT, (_m, n: string) => { if (vars[n] === undefined) throw new SmsTemplateError(`template "${id}" needs variable "${n}"`); return vars[n]; });
  }
  /** Templates that cannot be sent in production yet (no DLT template id). */
  unregistered(): string[] { return this.all().filter((t) => !t.dltTemplateId).map((t) => t.id); }
}

/**
 * The messages the civic code sends today, as templates. `dltTemplateId` is deliberately EMPTY: the real ids come from the operator's
 * DLT registration and are supplied with CIVIC_SMS_TEMPLATES_FILE (a JSON array of SmsTemplate, merged over these by id).
 */
export function defaultCivicTemplates(senderId?: string): SmsTemplate[] {
  const base = { language: "en", senderId };
  return [
    { id: "otp", category: "otp", body: "People Pulse code: {{code:8}}. Valid for 5 minutes. Do not share it.", ...base },
    { id: "pin_lockout", category: "service", body: "People Pulse: sign-in for a person linked to your number was locked from one device after repeated wrong PINs. It unlocks automatically in 30 minutes. You can reset the PIN with a code sent to this number.", ...base },
    { id: "adult_added", category: "service", body: "People Pulse: another adult was added to your number. If this was not you, reply STOP or contact the grievance officer.", ...base },
    { id: "issue_reference", category: "transactional", body: "People Pulse: your issue reference is {{ref:40}}. We never ask for OTP or bank details.", ...base },
    { id: "ivr_failed", category: "service", body: "People Pulse: we could not file this by phone. Please sign up or sign in on the app, then try again. We never ask for OTP or bank details.", ...base },
    { id: "enrol_activation", category: "transactional", body: "{{notice:1500}}\n\nPeople Pulse activation. Code: {{activation:16}}  OTP: {{otp:8}}\nEnter both in the app and choose your OWN PIN. Never tell the PIN to anyone, including the volunteer. Valid 72 hours (OTP 5 minutes).", ...base },
    { id: "household_invite", category: "service", body: "{{te:1500}}\n\n{{en:1500}}\n\nInvite code: {{invite:40}}\nValid 72 hours. [DRAFT NOTICE {{version:20}}]", ...base },
    // Government notifications (server/civic/notify): SMS fallback. NO dltTemplateId on purpose: UNAPPROVED placeholders until the operator registers
    // them on the DLT portal (production refuses to send them). The Telugu text is a DRAFT that needs human review.
    { id: "notify_sms_en", category: "service", body: "People Pulse [{{word:30}}] {{org:60}}: {{text:480}} We never ask for OTP, PIN, payment or login.", ...base },
    { id: "notify_sms_te", category: "service", body: "పీపుల్ పల్స్ [{{word:30}}] {{org:60}}: {{text:480}} మేము ఎప్పుడూ OTP, PIN, చెల్లింపు లేదా లాగిన్ అడగము.", ...base, language: "te" },
  ];
}

/** Defaults merged with the operator's DLT file (CIVIC_SMS_TEMPLATES_FILE). A malformed file throws: fail at startup, not at first send. */
export function loadTemplateRegistry(file = process.env.CIVIC_SMS_TEMPLATES_FILE, senderId = process.env.CIVIC_SMS_SENDER_ID): SmsTemplateRegistry {
  const reg = new SmsTemplateRegistry(defaultCivicTemplates(senderId));
  if (file) {
    const arr = JSON.parse(fs.readFileSync(file, "utf8")) as SmsTemplate[];
    if (!Array.isArray(arr)) throw new Error("CIVIC_SMS_TEMPLATES_FILE must be a JSON array of templates");
    for (const t of arr) reg.register({ senderId, ...t });
  }
  return reg;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Transport contract (what a vendor adapter implements)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SmsSubmit {
  idempotencyKey: string; to: string; text: string; senderId?: string;
  template: { id: string; dltTemplateId?: string; language: string; category: SmsCategory } | null;
  variables: Record<string, string>;
}
export interface SmsSubmitResult { messageId: string; status: SmsStatus; unitCost?: number; currency?: string }
export interface SmsReceipt { messageId: string; status: SmsStatus; at?: string; errorCode?: string }

export interface SmsTransport {
  readonly name: string;
  /** Submit one message. Throw ProviderError (retryable per its kind). Must pass `idempotencyKey` to the vendor if the vendor supports it. */
  submit(m: SmsSubmit, ctx: { timeoutMs: number }): Promise<SmsSubmitResult>;
  /** Vendor-specific receipt authentication (default: neutral HMAC with CIVIC_SMS_RECEIPT_SECRET). */
  verifyReceipt?(raw: string, headers: Record<string, string | undefined>): boolean;
  /** Vendor-specific receipt body -> neutral receipts (default: the neutral JSON shape). */
  parseReceipt?(raw: string): SmsReceipt[];
}

/** Contract v2 surface of an installed provider. `send` is the v1 method. */
export interface SmsProviderV2 extends SmsProvider {
  readonly contract: 2;
  submit(to: string, text: string, o?: { idempotencyKey?: string }): Promise<SmsSendResult>;
  sendTemplated(to: string, templateId: string, vars: Record<string, string>, o?: { idempotencyKey?: string }): Promise<SmsSendResult>;
  handleReceipt(r: SmsReceipt, now?: number): { matched: boolean; applied: boolean };
  runRetries(now?: number): Promise<{ processed: number }>;
  deadLetters(limit?: number): DeadLetter[];
  health(): SmsHealth;
}

export type SmsState = "pending" | "retry" | SmsStatus | "dead" | "budget_exhausted";
export interface SmsSendResult { state: SmsState; idempotencyKey: string; messageId?: string; deduped?: boolean; degraded?: boolean; templateId?: string }
export interface DeadLetter { idempotencyKey: string; templateId: string | null; attempts: number; error: string | null; createdAt: number; hasPayload: boolean }
export interface SmsHealth { breaker: "closed" | "open" | "half-open"; pending: number; retrying: number; dead: number; degraded: boolean }

/** SMS segment count: GSM-7 text is 160 chars (153 when concatenated); anything else (Telugu!) is UCS-2: 70 (67). */
export function smsSegments(text: string): number {
  const gsm = /^[\x20-\x7e\n\r]*$/.test(text);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Durable ledger (identity store). Phone only as keyed hash; payload encrypted and dropped as soon as no retry can need it.
// ---------------------------------------------------------------------------------------------------------------------------------

registerMigration("prov_001_sms_ledger", `
CREATE TABLE sms_ledger (
  idem_key TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  payload_enc TEXT,
  template_id TEXT,
  segments INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  provider_msg_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  cost_known INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_sms_ledger_msg ON sms_ledger(provider_msg_id);
CREATE INDEX idx_sms_ledger_due ON sms_ledger(status, next_attempt_at);
`);

interface Row {
  idem_key: string; phone_hash: string; payload_enc: string | null; template_id: string | null; segments: number; status: string; provider_msg_id: string | null;
  attempts: number; next_attempt_at: number | null; cost_micro: number; cost_known: number; currency: string | null; last_error: string | null; created_at: number; updated_at: number;
}
interface Payload { to: string; text: string }

export interface SmsGatewayOpts {
  registry?: SmsTemplateRegistry;
  /** Per-segment price in `currency` units. undefined/NaN = unknown: costs are recorded as 0 and flagged (cost_known=0). */
  unitCost?: number | null; currency?: string;
  /** Production default true: every send must match an approved template that carries a DLT template id. */
  requireTemplates?: boolean;
  maxAttempts?: number; timeoutMs?: number; backoffBaseMs?: number; backoffCapMs?: number;
  /** Known spend per rolling 24 h above which sends are held with state "budget_exhausted" (currency units). */
  dailyCostCap?: number | null;
  /** Identical (to, text) inside this window collapses to one message when the caller gave no idempotency key. */
  dedupeWindowMs?: number;
  breaker?: CircuitBreaker; now?: () => number; rand?: () => number; senderId?: string;
}

const isProd = () => process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production";
const E164 = /^\+[1-9]\d{7,14}$/;
const RANK: Record<string, number> = { pending: 0, retry: 0, queued: 1, sent: 2, delivered: 3 };
const num = (v: string | undefined): number | null => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export class ManagedSmsProvider implements SmsProviderV2 {
  readonly contract = 2 as const;
  readonly registry: SmsTemplateRegistry;
  protected o: Required<Pick<SmsGatewayOpts, "maxAttempts" | "timeoutMs" | "backoffBaseMs" | "backoffCapMs" | "dedupeWindowMs">> & SmsGatewayOpts;
  readonly breaker: CircuitBreaker;
  constructor(readonly transport: SmsTransport, opts: SmsGatewayOpts = {}) {
    const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as SmsGatewayOpts; // an unset env var must not erase a default
    this.o = { maxAttempts: 5, timeoutMs: 4000, backoffBaseMs: 30_000, backoffCapMs: 3_600_000, dedupeWindowMs: 5 * 60_000, ...defined };
    this.registry = opts.registry ?? new SmsTemplateRegistry(defaultCivicTemplates(opts.senderId));
    this.breaker = opts.breaker ?? new CircuitBreaker(5, 30_000, () => this.now());
  }
  protected now(): number { return this.o.now ? this.o.now() : Date.now(); }
  private requireTemplates(): boolean { return this.o.requireTemplates ?? isProd(); }
  private unitCost(): number | null { return this.o.unitCost === undefined ? num(process.env.CIVIC_SMS_UNIT_COST) : this.o.unitCost; }
  private currency(): string { return this.o.currency ?? process.env.CIVIC_SMS_CURRENCY ?? "INR"; }

  async send(toPhone: string, text: string): Promise<void> { await this.submit(toPhone, text); }

  async sendTemplated(to: string, templateId: string, vars: Record<string, string>, o: { idempotencyKey?: string } = {}): Promise<SmsSendResult> {
    return this.submit(to, this.registry.render(templateId, vars), o);
  }

  async submit(to: string, text: string, o: { idempotencyKey?: string } = {}): Promise<SmsSendResult> {
    const now = this.now();
    if (!E164.test(to)) throw new SmsRejectedError("invalid destination number");
    if (typeof text !== "string" || !text.trim() || text.length > 1600) throw new SmsRejectedError("message text empty or too long");
    const m = this.registry.match(text);
    if (this.requireTemplates() && (!m || !m.template.dltTemplateId)) {
      providerLog("sms", "template_refused", { reason: m ? "template has no DLT id" : "text matches no approved template", template: m?.template.id ?? "none" });
      throw new SmsTemplateError(m ? `template "${m.template.id}" has no DLT template id; refusing to send in production` : "message text is not an approved DLT template; refusing to send in production");
    }
    const idem = o.idempotencyKey ?? getKeys().hmac("sms-idem", `${to}|${text}|${Math.floor(now / this.o.dedupeWindowMs)}`);
    const db = getDb();
    const prior = db.prepare("SELECT * FROM sms_ledger WHERE idem_key = ?").get(idem) as unknown as Row | undefined;
    if (prior) return { state: prior.status as SmsState, idempotencyKey: idem, ...(prior.provider_msg_id ? { messageId: prior.provider_msg_id } : {}), deduped: true, degraded: prior.status === "retry" || prior.status === "dead" };
    const cap = this.o.dailyCostCap ?? num(process.env.CIVIC_SMS_DAILY_COST_CAP);
    if (cap != null && this.costSummary(now - 86_400_000, now + 1).knownCost >= cap) {
      providerLog("sms", "budget_exhausted", { cap });
      return { state: "budget_exhausted", idempotencyKey: idem, degraded: true };
    }
    const k = getKeys();
    db.prepare("INSERT INTO sms_ledger (idem_key, phone_hash, payload_enc, template_id, segments, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,'pending',0,?,?,?)")
      .run(idem, k.hmac("phone", to), k.encrypt("sms-payload", JSON.stringify({ to, text } satisfies Payload)), m?.template.id ?? null, smsSegments(text), now, now, now);
    return this.attempt(idem, now);
  }

  /** One transport attempt for a ledger row (inline for a fresh message, from runRetries for a due one). Never throws. */
  private async attempt(idem: string, now: number): Promise<SmsSendResult> {
    const db = getDb();
    const row = db.prepare("SELECT * FROM sms_ledger WHERE idem_key = ?").get(idem) as unknown as Row | undefined;
    if (!row || !row.payload_enc || (row.status !== "pending" && row.status !== "retry")) return { state: (row?.status as SmsState) ?? "dead", idempotencyKey: idem, deduped: true };
    const p = JSON.parse(getKeys().decrypt("sms-payload", row.payload_enc)) as Payload;
    const tpl = row.template_id ? this.registry.get(row.template_id) : undefined;
    const match = tpl ? this.registry.match(p.text) : null;
    const submit: SmsSubmit = {
      idempotencyKey: idem, to: p.to, text: p.text, senderId: tpl?.senderId ?? this.o.senderId ?? process.env.CIVIC_SMS_SENDER_ID,
      template: tpl ? { id: tpl.id, dltTemplateId: tpl.dltTemplateId, language: tpl.language, category: tpl.category } : null, variables: match?.variables ?? {},
    };
    const attempts = row.attempts + 1;
    try {
      if (!this.breaker.allow()) throw new ProviderError("circuit open", "circuit_open");
      const res = await this.withDeadline(this.transport.submit(submit, { timeoutMs: this.o.timeoutMs }));
      if (!res || typeof res.messageId !== "string" || !res.messageId) throw new ProviderError("vendor answer has no message id", "bad_response");
      this.breaker.success();
      const unit = res.unitCost ?? this.unitCost();
      const known = unit != null && Number.isFinite(unit);
      const cost = known ? Math.round((unit as number) * row.segments * 1e6) : 0;
      const status: SmsStatus = (["queued", "sent", "delivered", "failed"] as const).includes(res.status) ? res.status : "queued";
      db.prepare("UPDATE sms_ledger SET status = ?, provider_msg_id = ?, attempts = ?, payload_enc = NULL, next_attempt_at = NULL, cost_micro = ?, cost_known = ?, currency = ?, last_error = ?, updated_at = ? WHERE idem_key = ?")
        .run(status, res.messageId, attempts, cost, known ? 1 : 0, res.currency ?? this.currency(), status === "failed" ? "vendor_failed" : null, this.now(), idem);
      return { state: status, idempotencyKey: idem, messageId: res.messageId, templateId: tpl?.id, degraded: false };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("transport error", "network");
      if (pe.kind !== "circuit_open") this.breaker.failure();
      const retry = pe.retryable && attempts < this.o.maxAttempts;
      // An open circuit does not consume an attempt: the vendor was never asked.
      const used = pe.kind === "circuit_open" ? row.attempts : attempts;
      const tag = pe.kind + (pe.status ? ":" + pe.status : "");
      if (retry) {
        const at = this.now() + Math.max(1, backoffMs(Math.max(1, used), this.o.backoffBaseMs, this.o.backoffCapMs, this.o.rand));
        db.prepare("UPDATE sms_ledger SET status = 'retry', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE idem_key = ?").run(used, at, tag, this.now(), idem);
        providerLog("sms", "retry_scheduled", { attempt: used, error: tag, template: row.template_id ?? "none" });
        return { state: "retry", idempotencyKey: idem, degraded: true, templateId: tpl?.id };
      }
      db.prepare("UPDATE sms_ledger SET status = 'dead', attempts = ?, next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE idem_key = ?").run(used, tag, this.now(), idem);
      providerLog("sms", "dead_letter", { attempts: used, error: tag, template: row.template_id ?? "none" });
      try { audit("system", "sms.dead_letter", idem.slice(0, 16), { template: row.template_id, attempts: used, error: tag }); } catch { /* audit must not break sending */ }
      return { state: "dead", idempotencyKey: idem, degraded: true, templateId: tpl?.id };
    }
  }

  /** Hard deadline even if the transport ignores its own timeout. */
  private withDeadline<T>(p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout>;
    const dl = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ProviderError("transport deadline exceeded", "timeout")), this.o.timeoutMs + 250); });
    return Promise.race([p, dl]).finally(() => clearTimeout(t));
  }

  /** Attempt every pending/retry message that is due. Call from a timer (startSmsRetryLoop) or a job. */
  async runRetries(now = this.now()): Promise<{ processed: number }> {
    const due = getDb().prepare("SELECT idem_key FROM sms_ledger WHERE status IN ('pending','retry') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 100").all(now) as { idem_key: string }[];
    for (const d of due) await this.attempt(d.idem_key, now);
    return { processed: due.length };
  }

  /** Apply a delivery receipt. Never moves a message backwards (a late "sent" after "delivered" is ignored); unknown ids are reported, not stored. */
  handleReceipt(r: SmsReceipt, now = this.now()): { matched: boolean; applied: boolean } {
    const db = getDb();
    const row = db.prepare("SELECT * FROM sms_ledger WHERE provider_msg_id = ?").get(r.messageId) as unknown as Row | undefined;
    if (!row) return { matched: false, applied: false };
    if (row.status === "delivered" || row.status === "failed" || row.status === "dead") return { matched: true, applied: false };
    if (r.status === "failed") {
      db.prepare("UPDATE sms_ledger SET status = 'failed', payload_enc = NULL, last_error = ?, updated_at = ? WHERE idem_key = ?").run((r.errorCode ?? "failed").slice(0, 40), now, row.idem_key);
      return { matched: true, applied: true };
    }
    if ((RANK[r.status] ?? -1) <= (RANK[row.status] ?? 0)) return { matched: true, applied: false };
    db.prepare("UPDATE sms_ledger SET status = ?, updated_at = ? WHERE idem_key = ?").run(r.status, now, row.idem_key);
    return { matched: true, applied: true };
  }

  status(idem: string): { state: SmsState; attempts: number; messageId: string | null; error: string | null } | null {
    const r = getDb().prepare("SELECT status, attempts, provider_msg_id, last_error FROM sms_ledger WHERE idem_key = ?").get(idem) as { status: SmsState; attempts: number; provider_msg_id: string | null; last_error: string | null } | undefined;
    return r ? { state: r.status, attempts: r.attempts, messageId: r.provider_msg_id, error: r.last_error } : null;
  }

  deadLetters(limit = 100): DeadLetter[] {
    return (getDb().prepare("SELECT idem_key, template_id, attempts, last_error, created_at, payload_enc IS NOT NULL AS has FROM sms_ledger WHERE status = 'dead' ORDER BY created_at DESC LIMIT ?").all(limit) as
      { idem_key: string; template_id: string | null; attempts: number; last_error: string | null; created_at: number; has: number }[])
      .map((r) => ({ idempotencyKey: r.idem_key, templateId: r.template_id, attempts: r.attempts, error: r.last_error, createdAt: r.created_at, hasPayload: !!r.has }));
  }
  /** Operator action: give a dead letter (payload still held) a fresh set of attempts. */
  requeueDeadLetter(idem: string, now = this.now()): boolean {
    const r = getDb().prepare("UPDATE sms_ledger SET status = 'retry', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE idem_key = ? AND status = 'dead' AND payload_enc IS NOT NULL").run(now, now, idem);
    return Number(r.changes) > 0;
  }
  /** Drop payloads of dead letters older than `payloadMs` (default 24 h) and whole rows older than `rowMs` (default 90 days). */
  purge(now = this.now(), payloadMs = 86_400_000, rowMs = 90 * 86_400_000): { payloads: number; rows: number } {
    const db = getDb();
    const a = db.prepare("UPDATE sms_ledger SET payload_enc = NULL WHERE payload_enc IS NOT NULL AND status = 'dead' AND updated_at < ?").run(now - payloadMs);
    const b = db.prepare("DELETE FROM sms_ledger WHERE created_at < ? AND status NOT IN ('pending','retry')").run(now - rowMs);
    return { payloads: Number(a.changes), rows: Number(b.changes) };
  }

  health(): SmsHealth {
    const c = getDb().prepare("SELECT SUM(status='pending') AS p, SUM(status='retry') AS r, SUM(status='dead') AS d FROM sms_ledger").get() as { p: number | null; r: number | null; d: number | null };
    const breaker = this.breaker.state;
    return { breaker, pending: c.p ?? 0, retrying: c.r ?? 0, dead: c.d ?? 0, degraded: breaker !== "closed" || (c.r ?? 0) > 0 };
  }

  /** Spend between two instants. Messages whose price was unknown are counted separately, never silently as free. */
  costSummary(sinceMs = 0, untilMs = this.now() + 1): { messages: number; segments: number; knownCost: number; unknownCostMessages: number; currency: string } {
    const r = getDb().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(segments),0) AS seg, COALESCE(SUM(cost_micro),0) AS micro, COALESCE(SUM(1 - cost_known),0) AS unk FROM sms_ledger WHERE provider_msg_id IS NOT NULL AND created_at >= ? AND created_at < ?")
      .get(sinceMs, untilMs) as { n: number; seg: number; micro: number; unk: number };
    return { messages: r.n, segments: r.seg, knownCost: r.micro / 1e6, unknownCostMessages: r.unk, currency: this.currency() };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Neutral HTTP transport + provider
// ---------------------------------------------------------------------------------------------------------------------------------

export interface HttpSmsOpts extends SmsGatewayOpts {
  url: string; secret: string; receiptSecret?: string; callbackUrl?: string | null; timeoutMs?: number; fetchImpl?: FetchLike;
}

export const NEUTRAL_STATUS: Record<string, SmsStatus> = {
  queued: "queued", accepted: "queued", pending: "queued", scheduled: "queued",
  sent: "sent", submitted: "sent", dispatched: "sent", enroute: "sent",
  delivered: "delivered", delivrd: "delivered", delivery_success: "delivered",
  failed: "failed", undeliv: "failed", undelivered: "failed", rejected: "failed", expired: "failed", error: "failed", dropped: "failed", blocked: "failed",
};
export const normalizeSmsStatus = (s: unknown): SmsStatus | null => (typeof s === "string" ? NEUTRAL_STATUS[s.trim().toLowerCase()] ?? null : null);

export function parseNeutralReceipts(raw: string): SmsReceipt[] {
  let j: { receipts?: { message_id?: unknown; status?: unknown; at?: unknown; error_code?: unknown }[] };
  try { j = JSON.parse(raw); } catch { throw new SmsRejectedError("receipt body is not JSON"); }
  if (!Array.isArray(j.receipts) || j.receipts.length > 500) throw new SmsRejectedError("receipts must be an array of at most 500");
  const out: SmsReceipt[] = [];
  for (const x of j.receipts) {
    const status = normalizeSmsStatus(x.status);
    if (typeof x.message_id !== "string" || !x.message_id || x.message_id.length > 128 || !status) continue;
    out.push({ messageId: x.message_id, status, ...(typeof x.at === "string" ? { at: x.at.slice(0, 40) } : {}), ...(typeof x.error_code === "string" ? { errorCode: x.error_code.slice(0, 40) } : {}) });
  }
  return out;
}

export class HttpSmsTransport implements SmsTransport {
  readonly name = "http";
  constructor(private c: HttpSmsOpts) { assertSecureUrl(c.url, "CIVIC_SMS_URL"); if (!c.secret) throw new ProviderError("CIVIC_SMS_SECRET is required", "config"); }
  async submit(m: SmsSubmit, ctx: { timeoutMs: number }): Promise<SmsSubmitResult> {
    const r = await postJson<{ message_id?: unknown; status?: unknown; unit_cost?: unknown; currency?: unknown }>(this.c.url, {
      version: 1, idempotency_key: m.idempotencyKey, to: m.to, sender_id: m.senderId ?? null, text: m.text,
      template: m.template ? { id: m.template.id, dlt_template_id: m.template.dltTemplateId ?? null, language: m.template.language, category: m.template.category } : null,
      variables: m.variables, callback_url: this.c.callbackUrl ?? null,
    }, { secret: this.c.secret, timeoutMs: ctx.timeoutMs, fetchImpl: this.c.fetchImpl, now: this.c.now });
    if (typeof r.message_id !== "string" || !r.message_id) throw new ProviderError("vendor answer has no message_id", "bad_response");
    return {
      messageId: r.message_id, status: normalizeSmsStatus(r.status) ?? "queued",
      ...(typeof r.unit_cost === "number" ? { unitCost: r.unit_cost } : {}), ...(typeof r.currency === "string" ? { currency: r.currency } : {}),
    };
  }
  verifyReceipt(raw: string, h: Record<string, string | undefined>): boolean {
    return verifySignature(this.c.receiptSecret ?? process.env.CIVIC_SMS_RECEIPT_SECRET ?? "", h["x-civic-timestamp"], h["x-civic-signature"], raw, this.c.now?.() ?? Date.now());
  }
  parseReceipt(raw: string): SmsReceipt[] { return parseNeutralReceipts(raw); }
}

export class HttpSmsProvider extends ManagedSmsProvider {
  constructor(opts: HttpSmsOpts) { super(new HttpSmsTransport(opts), opts); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Installed gateway, receipts endpoint, retry loop
// ---------------------------------------------------------------------------------------------------------------------------------

let gateway: ManagedSmsProvider | null = null;
export function setSmsGateway(g: ManagedSmsProvider | null): void { gateway = g; }
export function getSmsGateway(): ManagedSmsProvider | null { return gateway; }
/** For the UI: true while sends are being retried or the vendor circuit is open. False when no managed provider is installed. */
export function smsDegraded(): boolean { try { return gateway?.health().degraded ?? false; } catch { return false; } }

/** POST /api/v1/civic/channels/sms-receipt. Mount before the channels router (server/civic/index.ts does). */
export function createSmsReceiptRouter(): Router {
  const r = Router();
  r.post("/", express.raw({ type: () => true, limit: "256kb" }), (req, res) => {
    const gw = gateway;
    if (!gw) return void res.status(503).json({ error: "sms_provider_not_installed" });
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const ok = gw.transport.verifyReceipt
      ? gw.transport.verifyReceipt(raw, headers)
      : verifySignature(process.env.CIVIC_SMS_RECEIPT_SECRET ?? "", headers["x-civic-timestamp"], headers["x-civic-signature"], raw);
    if (!ok) { providerLog("sms", "receipt_rejected", { reason: "bad_signature" }); return void res.status(401).json({ error: "bad_signature" }); }
    let receipts: SmsReceipt[];
    try { receipts = (gw.transport.parseReceipt ?? parseNeutralReceipts)(raw); } catch { return void res.status(400).json({ error: "bad_receipt" }); }
    let applied = 0, unmatched = 0;
    for (const x of receipts) { const o = gw.handleReceipt(x); if (!o.matched) unmatched++; else if (o.applied) applied++; }
    providerLog("sms", "receipts", { count: receipts.length, applied, unmatched });
    res.json({ ok: true, received: receipts.length, applied, unmatched });
  });
  return r;
}

let retryTimer: ReturnType<typeof setInterval> | null = null;
/** Retry/dead-letter sweep every 30 s (unref'd). No-op under NODE_ENV=test or CIVIC_JOBS=0. */
export function startSmsRetryLoop(everyMs = 30_000): void {
  if (retryTimer || process.env.NODE_ENV === "test" || process.env.VITEST || process.env.CIVIC_JOBS === "0") return;
  retryTimer = setInterval(() => { const g = gateway; if (!g) return; g.runRetries().then(() => g.purge()).catch(() => providerLog("sms", "retry_loop_error")); }, everyMs);
  retryTimer.unref?.();
}
export function stopSmsRetryLoop(): void { if (retryTimer) clearInterval(retryTimer); retryTimer = null; }

/** Constant-time string compare helper for adapters that authenticate receipts with a static token. */
export const safeEqual = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
