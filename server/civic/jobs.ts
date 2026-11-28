/**
 * Job scheduler (S-66). Registers the periodic civic jobs and runs them on unref'd intervals. Disabled when NODE_ENV=test or
 * CIVIC_JOBS=0. start/stop are idempotent; a job never overlaps itself; a failing job never stops the others. Every run writes an
 * audit entry and updates the per-job status table (jobsStatus / GET /api/v1/civic/ops/jobs).
 * verifyAuditChain breakage raises an alarm: an audit entry plus `alarm` in the status until a later verification passes.
 * The issue `sweep` job defers to startIssueSweeper when that timer is running, so the sweep is never double-run.
 */
import { anchorAuditHead, audit, drainErasureOutbox, pendingErasureCount, verifyAuditChain } from "./core";
import { purgeExpired } from "./identity/service";
import { expirePendingEnrolments } from "./identity/enrolment";
import { eraseDependentsAt18, expireInvites } from "./households/routes";
import { purgeExpiredMedia } from "./issues/media";
import { isIssueSweeperRunning, sweep } from "./issues/service";
import { closeDueSurveys } from "./surveys/registry";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export interface JobDef { name: string; intervalMs: number; run: (now: Date) => unknown }
export interface JobStatus {
  name: string; intervalMs: number; running: boolean; runs: number; failures: number;
  lastRunAt: string | null; lastOk: boolean | null; lastError: string | null; lastResult: unknown;
}
export interface JobsStatus { started: boolean; alarm: { kind: "audit_chain_broken"; at: string; detail: string } | null; jobs: JobStatus[] }

let clockFn: () => Date = () => new Date();
let alarm: JobsStatus["alarm"] = null;
const table = new Map<string, JobStatus>();
let defs: JobDef[] = [];
let timers: ReturnType<typeof setInterval>[] = [];
let started = false;

const short = (m: string) => m.replace(/\s+/g, " ").slice(0, 200);

export function defaultJobs(): JobDef[] {
  return [...baseJobs(), ...extraJobs];
}

/** Register an additional periodic job (call at module load; a name is registered once). */
export function registerJob(def: JobDef): void { if (!extraJobs.some((j) => j.name === def.name)) extraJobs.push(def); }
const extraJobs: JobDef[] = [];

function baseJobs(): JobDef[] {
  return [
    { name: "purgeExpired", intervalMs: 6 * HOUR, run: (now) => purgeExpired(now) },
    { name: "eraseDependentsAt18", intervalMs: DAY, run: async (now) => ({ erased: await eraseDependentsAt18(now) }) },
    { name: "expireInvites", intervalMs: HOUR, run: async (now) => { await expireInvites(now.getTime()); return { pendingEnrolmentsExpired: expirePendingEnrolments(now) }; } },
    // S-74: the second step of account erasure (issue-store unlinking, audit redaction) is retried until it succeeds.
    { name: "retryErasureOutbox", intervalMs: 5 * MIN, run: () => { const r = drainErasureOutbox(); return { done: r.done, failed: r.failed, pending: pendingErasureCount() }; } },
    { name: "anchorAuditHead", intervalMs: HOUR, run: () => { const a = anchorAuditHead(); return a ? { seq: a.seq } : { seq: null }; } },
    {
      name: "verifyAuditChain", intervalMs: HOUR, run: (now) => {
        const v = verifyAuditChain();
        if (!v.ok) {
          const detail = short(`${v.reason ?? "chain verification failed"} at seq ${v.brokenAt ?? v.anchorMismatch ?? "?"}`);
          alarm = { kind: "audit_chain_broken", at: now.toISOString(), detail };
          audit("system", "alarm.audit_chain_broken", "audit_log", { detail });
          throw new Error(detail);
        }
        alarm = null;
        return { checked: v.checked };
      },
    },
    { name: "closeDueSurveys", intervalMs: MIN, run: (now) => closeDueSurveys(now) }, // Pulse Surveys close at closes_at
    { name: "purgeExpiredMedia", intervalMs: HOUR, run: (now) => ({ purged: purgeExpiredMedia(now) }) },
    {
      name: "sweep", intervalMs: Math.max(1000, Number(process.env.CIVIC_SWEEP_INTERVAL_MS) || 10 * MIN), run: (now) => {
        if (process.env.CIVIC_SWEEP === "0") return { skipped: "CIVIC_SWEEP=0" };
        if (isIssueSweeperRunning()) return { skipped: "owned by the issue sweeper" };
        const s = sweep(now);
        return { confirmed: s.confirmed.length, reopened: s.reopened.length, escalated: s.escalated.length, mediaPurged: s.mediaPurged };
      },
    },
  ];
}

function ensure(d: JobDef): JobStatus {
  let s = table.get(d.name);
  if (!s) { s = { name: d.name, intervalMs: d.intervalMs, running: false, runs: 0, failures: 0, lastRunAt: null, lastOk: null, lastError: null, lastResult: null }; table.set(d.name, s); }
  s.intervalMs = d.intervalMs;
  return s;
}

/** Run one job now (no overlap). Returns false when it is unknown or already running. Never throws. */
export function runJob(name: string, now: Date = clockFn()): boolean {
  const d = defs.find((x) => x.name === name);
  if (!d) return false;
  const s = ensure(d);
  if (s.running) return false;
  s.running = true;
  const t0 = Date.now();
  const done = (ok: boolean, result: unknown, error: unknown): void => {
    if (ok) { s.lastOk = true; s.lastError = null; s.lastResult = result ?? null; }
    else { s.lastOk = false; s.lastError = short((error as Error)?.message ?? String(error)); s.failures++; }
    s.running = false; s.runs++; s.lastRunAt = now.toISOString();
    try { audit("system", "job.run", "job:" + name, { ok: s.lastOk, error: s.lastError, ms: Date.now() - t0 }); } catch { /* audit must not break a job */ }
  };
  let result: unknown;
  try { result = d.run(now); } catch (e) { done(false, null, e); return true; }
  // A job on the async data layer returns a promise: it stays "running" until it settles, then records the same way. Synchronous jobs finish here, as before.
  if (result instanceof Promise) { result.then((r) => done(true, r, null), (e) => done(false, null, e)); return true; }
  done(true, result, null);
  return true;
}

export function runAllJobs(now: Date = clockFn()): void { for (const d of defs) runJob(d.name, now); }

/** Start the scheduler. Idempotent. Returns true when running; false when disabled (NODE_ENV=test, CIVIC_JOBS=0). */
export function startJobs(opts: { jobs?: JobDef[]; now?: () => Date; force?: boolean } = {}): boolean {
  if (!opts.force && (process.env.NODE_ENV === "test" || process.env.CIVIC_JOBS === "0")) return false;
  if (started) return true;
  defs = opts.jobs ?? defaultJobs();
  clockFn = opts.now ?? (() => new Date());
  for (const d of defs) {
    ensure(d);
    const t = setInterval(() => runJob(d.name), Math.max(10, d.intervalMs));
    t.unref();
    timers.push(t);
  }
  started = true;
  return true;
}

export function stopJobs(): void {
  for (const t of timers) clearInterval(t);
  timers = []; started = false; defs = []; clockFn = () => new Date();
}

/** Tests only: stop and forget all status. */
export function resetJobsForTests(): void { stopJobs(); table.clear(); alarm = null; }

export const jobsRunning = () => started;

/** Status table for ops: names, timings, last result/error text only (no secrets, no row data). */
export function jobsStatus(): JobsStatus {
  return { started, alarm, jobs: [...table.values()].map((s) => ({ ...s })) };
}
