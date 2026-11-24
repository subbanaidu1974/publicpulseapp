/**
 * Observability (S-67): structured JSON logger with redaction, request ids, health/readiness endpoints and Prometheus-text metrics.
 * No dependency. One JSON object per line on stdout (stderr for error level). Every line written while a request is in flight
 * carries `reqId` (AsyncLocalStorage). Phone numbers, OTPs, PINs, tokens and e-mail addresses never reach a log line:
 * redaction is by key name for structured fields and by pattern for free text.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { Router as makeRouter } from "express";

/* ---------------- redaction ---------------- */

const SENSITIVE_KEY = /(otp|pin|pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|phone|mobile|msisdn|e-?mail|session|master[-_]?key|private)/i;

/** Scrub secrets and personal identifiers out of free text. */
export function redactString(s: string): string {
  return s
    // OTP / PIN / code with a numeric value
    .replace(/\b(otp|pin|passcode|code)\b(["']?\s*[:=]?\s*["']?)\d{3,8}\b/gi, "$1$2[redacted]")
    // Bearer / Basic credentials
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    // e-mail
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    // phone numbers: optional +91/0091/0, then 10 digits starting 6-9, or any 10-13 digit run with separators
    .replace(/(?:\+|00)?\d[\d\s().-]{8,16}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m));
}

const MAX_DEPTH = 5;

/** Deep-copy a value with sensitive keys masked and strings scrubbed. Cycles and depth are bounded. */
export function redact(v: unknown, depth = 0, key = ""): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof v === "string") return redactString(v);
  if (v === null || typeof v !== "object") return v;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (v instanceof Error) return { name: v.name, message: redactString(v.message) };
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redact(val, depth + 1, k);
  return out;
}

/* ---------------- logger ---------------- */

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const als = new AsyncLocalStorage<{ reqId: string }>();
export const currentRequestId = (): string | undefined => als.getStore()?.reqId;

type Sink = (line: string, level: Level) => void;
let sink: Sink = (line, level) => { (level === "error" ? process.stderr : process.stdout).write(line + "\n"); };
/** Tests only: capture lines. Pass null to restore stdout. */
export function setLogSink(s: Sink | null): void {
  sink = s ?? ((line, level) => { (level === "error" ? process.stderr : process.stdout).write(line + "\n"); });
}

function threshold(): number {
  const l = (process.env.LOG_LEVEL || "info").toLowerCase() as Level;
  return ORDER[l] ?? ORDER.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: redactString(String(msg)),
  };
  const reqId = currentRequestId();
  if (reqId) rec.reqId = reqId;
  if (fields) {
    const safe = redact(fields) as Record<string, unknown>;
    for (const [k, v] of Object.entries(safe)) if (!(k in rec)) rec[k] = v;
  }
  let line: string;
  try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ ts: rec.ts, level, msg: "unserialisable log record" }); }
  sink(line, level);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

const fmt = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");

/** Route console.log/info/warn/error through the logger so third-party and legacy call sites are structured and redacted too. */
export function installConsole(): void {
  console.log = (...a: unknown[]) => log.info(fmt(a));
  console.info = (...a: unknown[]) => log.info(fmt(a));
  console.warn = (...a: unknown[]) => log.warn(fmt(a));
  console.error = (...a: unknown[]) => log.error(fmt(a));
}

/* ---------------- request context ---------------- */

const ID_OK = /^[A-Za-z0-9._-]{8,64}$/;

/** Class of route for logs and metrics. Low cardinality by construction: never includes ids or query strings. */
import { degradedPayload, recordOutcome } from "./degraded";
import { freshnessAlert } from "./freshness";

export function routeClass(p: string): string {
  if (p === "/healthz" || p === "/readyz" || p === "/metrics") return p.slice(1);
  const m = /^\/api\/v1\/civic\/([a-z-]+)/.exec(p);
  if (m) return "civic_" + m[1].replace(/-/g, "_");
  if (p.startsWith("/api/v1/civic")) return "civic";
  if (p.startsWith("/api/")) return "api";
  return "static";
}

/** Metrics state (process-local). */
const BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 10];
interface Hist { buckets: number[]; sum: number; count: number }
const requests = new Map<string, number>(); // `${class}|${statusClass}` -> n
const latency = new Map<string, Hist>();
export function resetMetricsForTests(): void { requests.clear(); latency.clear(); }

function observe(cls: string, status: number, seconds: number): void {
  const k = `${cls}|${Math.floor(status / 100)}xx`;
  requests.set(k, (requests.get(k) ?? 0) + 1);
  recordOutcome(status);
  const h = latency.get(cls) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
  h.sum += seconds; h.count++;
  latency.set(cls, h);
}

/**
 * Assigns/propagates X-Request-Id (an inbound id is honoured only when it is a safe token), runs the rest of the request inside
 * the logging context, logs one access line on finish and records metrics.
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers["x-request-id"];
    const reqId = typeof inbound === "string" && ID_OK.test(inbound) ? inbound : crypto.randomUUID();
    res.setHeader("X-Request-Id", reqId);
    const t0 = process.hrtime.bigint();
    const cls = routeClass(req.path);
    res.on("finish", () => {
      const secs = Number(process.hrtime.bigint() - t0) / 1e9;
      observe(cls, res.statusCode, secs);
      if (cls === "healthz" && res.statusCode < 400) return; // keep probes out of the log
      als.run({ reqId }, () => log.info("request", { method: req.method, route: cls, status: res.statusCode, ms: Math.round(secs * 1000) }));
    });
    als.run({ reqId }, next);
  };
}

/* ---------------- health, readiness, metrics ---------------- */

export interface ReadyDeps {
  /** Throws when the database is unreachable. */
  dbPing: () => void;
  migrations: () => { registered: number; applied: number; pending: string[]; drift: string[] };
  jobs: () => { started: boolean; alarm: { kind: string; at: string; detail: string } | null; jobs: { name: string; runs: number; failures: number; lastOk: boolean | null; lastRunAt: string | null }[] };
  demoProvenance: () => string[];
}

export interface Readiness { ok: boolean; checks: Record<string, { ok: boolean; detail?: unknown }> }

export function computeReadiness(d: ReadyDeps): Readiness {
  const checks: Readiness["checks"] = {};
  try { d.dbPing(); checks.db = { ok: true }; } catch (e) { checks.db = { ok: false, detail: redactString((e as Error).message).slice(0, 120) }; }
  if (checks.db.ok) {
    try {
      const m = d.migrations();
      checks.migrations = { ok: m.pending.length === 0 && m.drift.length === 0, detail: { applied: m.applied, registered: m.registered, pending: m.pending, drift: m.drift } };
    } catch (e) { checks.migrations = { ok: false, detail: redactString((e as Error).message).slice(0, 120) }; }
  } else {
    checks.migrations = { ok: false, detail: "db unavailable" };
  }
  try {
    const j = d.jobs();
    const verify = j.jobs.find((x) => x.name === "verifyAuditChain");
    const broken = !!j.alarm || verify?.lastOk === false;
    checks.auditChain = {
      ok: !broken,
      detail: { jobsStarted: j.started, lastVerifiedAt: verify?.lastRunAt ?? null, lastOk: verify?.lastOk ?? null, alarm: j.alarm ? { kind: j.alarm.kind, at: j.alarm.at } : null },
    };
  } catch (e) { checks.auditChain = { ok: false, detail: redactString((e as Error).message).slice(0, 120) }; }
  try {
    const demo = d.demoProvenance();
    // Informational: production guards (S-55) are what refuse demo data; readiness only reports it.
    checks.dataProvenance = { ok: true, detail: { demo } };
  } catch { checks.dataProvenance = { ok: true, detail: { demo: [] } }; }
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

export function renderMetrics(jobs: ReadyDeps["jobs"] | null, ready: Readiness | null): string {
  const out: string[] = [];
  out.push("# HELP pulse_http_requests_total HTTP requests by route class and status class.", "# TYPE pulse_http_requests_total counter");
  for (const [k, n] of [...requests].sort()) { const [c, s] = k.split("|"); out.push(`pulse_http_requests_total{route="${c}",status="${s}"} ${n}`); }
  out.push("# HELP pulse_http_request_duration_seconds Request latency by route class.", "# TYPE pulse_http_request_duration_seconds histogram");
  for (const [c, h] of [...latency].sort()) {
    BUCKETS.forEach((b, i) => out.push(`pulse_http_request_duration_seconds_bucket{route="${c}",le="${b}"} ${h.buckets[i]}`));
    out.push(`pulse_http_request_duration_seconds_bucket{route="${c}",le="+Inf"} ${h.count}`);
    out.push(`pulse_http_request_duration_seconds_sum{route="${c}"} ${h.sum.toFixed(6)}`, `pulse_http_request_duration_seconds_count{route="${c}"} ${h.count}`);
  }
  if (jobs) {
    try {
      const j = jobs();
      out.push("# HELP pulse_job_runs_total Job runs.", "# TYPE pulse_job_runs_total counter");
      for (const x of j.jobs) out.push(`pulse_job_runs_total{job="${x.name}"} ${x.runs}`);
      out.push("# HELP pulse_job_failures_total Job failures.", "# TYPE pulse_job_failures_total counter");
      for (const x of j.jobs) out.push(`pulse_job_failures_total{job="${x.name}"} ${x.failures}`);
      out.push("# HELP pulse_job_last_ok 1 when the last run succeeded, 0 when it failed.", "# TYPE pulse_job_last_ok gauge");
      for (const x of j.jobs) if (x.lastOk !== null) out.push(`pulse_job_last_ok{job="${x.name}"} ${x.lastOk ? 1 : 0}`);
      out.push("# HELP pulse_audit_chain_alarm 1 when audit chain verification has failed.", "# TYPE pulse_audit_chain_alarm gauge", `pulse_audit_chain_alarm ${j.alarm ? 1 : 0}`);
    } catch { /* jobs not available */ }
  }
  if (ready) out.push("# HELP pulse_ready 1 when /readyz would answer 200.", "# TYPE pulse_ready gauge", `pulse_ready ${ready.ok ? 1 : 0}`);
  out.push("# HELP pulse_process_uptime_seconds Process uptime.", "# TYPE pulse_process_uptime_seconds gauge", `pulse_process_uptime_seconds ${Math.round(process.uptime())}`);
  return out.join("\n") + "\n";
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * /metrics access: with METRICS_TOKEN set, only `Authorization: Bearer <token>` (constant-time compare) is accepted.
 * Without it, only direct loopback connections (no X-Forwarded-For, so a local reverse proxy does not expose it).
 */
export function metricsAllowed(req: Pick<Request, "headers" | "socket">, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env.METRICS_TOKEN;
  if (token) {
    const h = String(req.headers.authorization || "");
    const given = /^Bearer\s+(.+)$/i.exec(h)?.[1] ?? "";
    const a = crypto.createHash("sha256").update(given).digest();
    const b = crypto.createHash("sha256").update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && !req.headers["x-forwarded-for"];
}

/** /healthz (liveness: process answers), /readyz (DB, migrations, audit chain, provenance), /metrics. Mount at the app root. */
export function obsRouter(deps: ReadyDeps, env: NodeJS.ProcessEnv = process.env): Router {
  const r = makeRouter();
  const noStore: RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };
  r.get("/healthz", noStore, (_req, res) => { res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }); });
  r.get("/readyz", noStore, (_req, res) => {
    const rd = computeReadiness(deps);
    res.status(rd.ok ? 200 : 503).json({ ...rd, info: { degraded: degradedPayload(), dataFreshness: freshnessAlert() } });
  });
  r.get("/api/v1/degraded", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=30, stale-if-error=300"); res.json(degradedPayload()); });
  r.get("/metrics", noStore, (req, res) => {
    if (!metricsAllowed(req, env)) return void res.status(404).type("text/plain").send("Not found\n");
    res.type("text/plain; version=0.0.4").send(renderMetrics(deps.jobs, computeReadiness(deps)));
  });
  return r;
}
