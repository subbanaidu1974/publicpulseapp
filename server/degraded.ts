/**
 * Count-day degraded mode and the OTP send queue (S-46, E2E-56; DESIGN_2028 3.8 item 6; docs/DEGRADED_MODE.md).
 *
 * One process-wide state, `degradedState()`, is ON when any of these holds:
 *   - CIVIC_DEGRADED=1 (operator switch, read live);
 *   - the SMS hourly budget was refused recently (markSmsExhausted, held CIVIC_DEGRADED_SMS_HOLD_SECONDS);
 *   - the 5xx share of the last 60 s of responses is at least CIVIC_DEGRADED_ERROR_RATE (default 0.25, needs 40+ responses);
 *   - the OTP send queue holds at least CIVIC_DEGRADED_QUEUE_DEPTH entries (default 100).
 * Once on it stays on for CIVIC_DEGRADED_MIN_HOLD_SECONDS (default 60) so it does not flap.
 * This file imports nothing from the app (server/obs.ts and the identity routes call into it), so there are no import cycles.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

const num = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== "" ? n : d; };
const env = () => process.env;

export type DegradedReason = "operator" | "sms_budget" | "error_rate" | "queue_depth";
export interface DegradedState { degraded: boolean; reasons: DegradedReason[]; since: string | null; retry_after_seconds: number }

// ---------- signals ----------
let smsExhaustedUntil = 0;
/** Called by the OTP route when the hourly SMS budget refuses a send. */
export function markSmsExhausted(nowMs = Date.now()): void { smsExhaustedUntil = nowMs + num(env().CIVIC_DEGRADED_SMS_HOLD_SECONDS, 300) * 1000; }

const BUCKET_MS = 10_000, BUCKETS = 6;
const outcomes = new Map<number, { n: number; e: number }>();
/** Called by server/obs.ts for every finished request. */
export function recordOutcome(status: number, nowMs = Date.now()): void {
  const b = Math.floor(nowMs / BUCKET_MS);
  const o = outcomes.get(b) ?? { n: 0, e: 0 };
  o.n++; if (status >= 500 && status !== 503) o.e++; // our own deliberate 503 sheds must not keep the mode on
  outcomes.set(b, o);
  for (const k of outcomes.keys()) if (k <= b - BUCKETS) outcomes.delete(k);
}
function errorRate(nowMs: number): { n: number; rate: number } {
  const b = Math.floor(nowMs / BUCKET_MS);
  let n = 0, e = 0;
  for (const [k, v] of outcomes) if (k > b - BUCKETS) { n += v.n; e += v.e; }
  return { n, rate: n ? e / n : 0 };
}

let onSince: number | null = null, lastOn = 0, lastReasons: DegradedReason[] = [];
export function degradedState(nowMs = Date.now()): DegradedState {
  const reasons: DegradedReason[] = [];
  if (env().CIVIC_DEGRADED === "1") reasons.push("operator");
  if (nowMs < smsExhaustedUntil) reasons.push("sms_budget");
  const er = errorRate(nowMs);
  if (er.n >= 40 && er.rate >= num(env().CIVIC_DEGRADED_ERROR_RATE, 0.25)) reasons.push("error_rate");
  if (otpQueue.depth() >= num(env().CIVIC_DEGRADED_QUEUE_DEPTH, 100)) reasons.push("queue_depth");
  const hold = num(env().CIVIC_DEGRADED_MIN_HOLD_SECONDS, 60) * 1000;
  if (reasons.length) { if (onSince === null) onSince = nowMs; lastOn = nowMs; lastReasons = [...reasons]; }
  else if (onSince !== null && nowMs - lastOn < hold) reasons.push(...lastReasons); // hysteresis: stay on through the hold
  else onSince = null;
  return { degraded: reasons.length > 0, reasons, since: onSince === null ? null : new Date(onSince).toISOString(), retry_after_seconds: retryAfterSeconds() };
}
export const retryAfterSeconds = (): number => Math.max(1, Math.floor(num(env().CIVIC_DEGRADED_RETRY_SECONDS, 60)));
export function resetDegradedForTests(): void { smsExhaustedUntil = 0; outcomes.clear(); onSince = null; lastOn = 0; lastReasons = []; otpQueue.reset(); }

// ---------- notice ----------
export const NOTICE = {
  title_en: "High demand: read-only mode", title_te: "అధిక రద్దీ: చదవడానికి మాత్రమే",
  body_en: "Public information still works. Sign-ups, exports and some updates are paused for a short while. Please try again soon.",
  body_te: "ప్రజా సమాచారం యథావిధిగా పనిచేస్తుంది. సైన్ అప్‌లు, ఎగుమతులు, కొన్ని మార్పులు కొద్దిసేపు నిలిపివేయబడ్డాయి. దయచేసి కొద్దిసేపటి తర్వాత ప్రయత్నించండి.",
} as const;

/** The static read-only banner the UI can show; also the body of GET /api/v1/degraded. */
export function degradedPayload(nowMs = Date.now()) {
  const s = degradedState(nowMs);
  return { degraded: s.degraded, read_only: s.degraded, reasons: s.reasons, since: s.since, retry_after_seconds: s.retry_after_seconds, banner: s.degraded ? { ...NOTICE } : null, queue: { depth: otpQueue.depth(), max: otpQueue.max() } };
}

// ---------- shedding (priority table: docs/DEGRADED_MODE.md) ----------
interface ShedRule { id: string; method: RegExp; path: RegExp }
/** Paths are relative to /api/v1/civic. First match sheds. Everything not listed stays up. */
export const SHED_RULES: ShedRule[] = [
  { id: "export", method: /^GET$/, path: /^\/(issues\/export|scope\/export)(\/|$)/ },
  { id: "media_upload", method: /^POST$/, path: /^\/issues\/media$/ },
  { id: "signup_otp", method: /^POST$/, path: /^\/identity\/signup\/request$/ },
  { id: "consultation_write", method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/consultations(\/|$)/ },
  { id: "survey_credential", method: /^POST$/, path: /^\/surveys\/[^/]+\/credential\/request$/ },
  { id: "survey_admin_write", method: /^(POST|PATCH|PUT|DELETE)$/, path: /^\/surveys(\/|$)(?!.*\/respond$)(?!.*\/credential\/)/ },
  { id: "me_too", method: /^POST$/, path: /^\/issues\/[^/]+\/me-too$/ },
  { id: "household_write", method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/households(\/|$)/ },
  { id: "notify_send", method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/notify(\/|$)/ },
];
const PUBLIC_READ = /^\/(issues(\/(feed|categories|[^/]+))?|geo\/.*|audit\/.*|surveys(\/[^/]+(\/results(\/method)?|\/versions\/\d+)?)?)?$/;

export function shedRuleFor(method: string, path: string): ShedRule | null {
  const p = path.replace(/\/+$/, "") || "/";
  return SHED_RULES.find((r) => r.method.test(method) && r.path.test(p)) ?? null;
}

/**
 * Mount first on the civic router. When degraded: sheds the listed routes with 503 + Retry-After + bilingual notice, and lengthens the
 * cache lifetime of public reads with stale-while-revalidate / stale-if-error so edges keep serving them.
 */
export function degradedGate(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const s = degradedState();
    if (!s.degraded) return next();
    const rule = shedRuleFor(req.method, req.path);
    if (rule) {
      res.set({ "Retry-After": String(s.retry_after_seconds), "Cache-Control": "no-store", "X-Degraded": "1" });
      res.status(503).json({ error: "degraded", degraded: true, shed: rule.id, reasons: s.reasons, retry_after_seconds: s.retry_after_seconds, notice_en: NOTICE.body_en, notice_te: NOTICE.body_te, banner: { ...NOTICE } });
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && PUBLIC_READ.test(req.path.replace(/\/+$/, "") || "/")) {
      const wh = res.writeHead;
      res.writeHead = function (this: Response, ...a: unknown[]) {
        if (!res.headersSent) {
          const cc = res.getHeader("Cache-Control");
          if (typeof cc === "string" && /\bpublic\b/.test(cc) && !/stale-while-revalidate/.test(cc)) res.setHeader("Cache-Control", `${cc}, stale-while-revalidate=3600, stale-if-error=86400`);
          res.setHeader("X-Degraded", "1");
        }
        return (wh as (...x: unknown[]) => Response).apply(this, a);
      } as typeof res.writeHead;
    }
    next();
  };
}

// ---------- OTP send queue with budget smoothing ----------
/**
 * Spends the SMS budget evenly. Per slot (CIVIC_OTP_SLOT_SECONDS, default 60) at most `ceil(perHour / (3600 / slot) * CIVIC_OTP_SMOOTH_FACTOR)`
 * (never below CIVIC_OTP_MIN_BURST, default 20) texts leave immediately; further sends wait in a bounded queue (CIVIC_OTP_QUEUE_MAX, default
 * 200) released slot by slot. A request is refused ("full") when the queue is full or the estimated wait exceeds CIVIC_OTP_MAX_WAIT_SECONDS
 * (default 120, well inside the 5 minute code lifetime), so a queued code is always delivered while still valid.
 */
export type OtpLane = "now" | "queued" | "full";
export class SmoothedQueue {
  private slotStart = 0; private used = 0; private q: (() => Promise<void>)[] = []; private timer: NodeJS.Timeout | null = null;
  constructor(private clock: () => number = Date.now) {}
  depth(): number { return this.q.length; }
  max(): number { return Math.max(0, Math.floor(num(env().CIVIC_OTP_QUEUE_MAX, 200))); }
  slotMs(): number { return Math.max(1, num(env().CIVIC_OTP_SLOT_SECONDS, 60)) * 1000; }
  perSlot(perHour: number): number {
    const slots = 3600_000 / this.slotMs();
    return Math.max(Math.floor(num(env().CIVIC_OTP_MIN_BURST, 20)), Math.ceil((perHour / slots) * num(env().CIVIC_OTP_SMOOTH_FACTOR, 2)));
  }
  private roll(now: number): void { if (now - this.slotStart >= this.slotMs()) { this.slotStart = now - (now % this.slotMs()); this.used = 0; } }
  /** Estimated seconds until a newly queued send would leave. */
  estimateWaitSeconds(perHour: number, now = this.clock()): number {
    this.roll(now);
    const cap = this.perSlot(perHour), ahead = this.q.length + 1, room = Math.max(0, cap - this.used);
    if (ahead <= room) return 0;
    const slotsNeeded = Math.ceil((ahead - room) / cap);
    return Math.ceil((this.slotStart + slotsNeeded * this.slotMs() - now) / 1000);
  }
  /** Decide the lane. "now": the caller sends inline (slot use is counted). "queued": call enqueue(job). "full": refuse with 503 + Retry-After. */
  admit(perHour: number, now = this.clock()): { lane: OtpLane; retryAfterSeconds: number } {
    this.roll(now);
    const cap = this.perSlot(perHour);
    if (!this.q.length && this.used < cap) { this.used++; return { lane: "now", retryAfterSeconds: 0 }; }
    const wait = this.estimateWaitSeconds(perHour, now);
    if (this.q.length >= this.max() || wait > num(env().CIVIC_OTP_MAX_WAIT_SECONDS, 120)) return { lane: "full", retryAfterSeconds: Math.max(1, wait || this.slotMs() / 1000) };
    return { lane: "queued", retryAfterSeconds: wait };
  }
  enqueue(job: () => Promise<void>, perHour: number): void { this.q.push(job); this.perHour = perHour; this.arm(); }
  private perHour = 0;
  private arm(): void {
    if (this.timer || !this.q.length) return;
    const now = this.clock();
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, Math.max(1, this.slotStart + this.slotMs() - now));
    this.timer.unref?.();
  }
  /** Release as many queued sends as the current slot allows. Returns how many left. Exposed for tests (inject a clock). */
  async drain(now = this.clock()): Promise<number> {
    this.roll(now);
    const cap = this.perSlot(this.perHour);
    let sent = 0;
    const jobs: Promise<void>[] = [];
    while (this.q.length && this.used < cap) { const job = this.q.shift()!; this.used++; sent++; jobs.push(job().catch(() => undefined)); }
    await Promise.all(jobs);
    this.arm();
    return sent;
  }
  reset(): void { this.q = []; this.used = 0; this.slotStart = 0; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
export const otpQueue = new SmoothedQueue();
