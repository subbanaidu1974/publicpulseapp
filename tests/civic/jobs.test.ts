import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audit, createSession, getDb, grantRole, migrate, resetDbForTests, setAnchorSink, type AnchorRecord } from "../../server/civic/core";
import { createPerson } from "../../server/civic/identity/service";
import { createCivicRouter } from "../../server/civic/index";
import { defaultJobs, jobsStatus, resetJobsForTests, runAllJobs, runJob, startJobs, stopJobs } from "../../server/civic/jobs";

const T0 = new Date("2026-06-01T10:00:00Z");
const ENV = { NODE_ENV: process.env.NODE_ENV, CIVIC_JOBS: process.env.CIVIC_JOBS };
const auditActions = () => (getDb().prepare("SELECT action, object FROM audit_log").all() as { action: string; object: string }[]);

beforeEach(() => { resetDbForTests(); migrate(); resetJobsForTests(); });
afterEach(() => {
  resetJobsForTests(); vi.useRealTimers(); vi.restoreAllMocks(); setAnchorSink(null);
  for (const [k, v] of Object.entries(ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("job scheduler (S-66)", () => {
  it("@E2E-81 is disabled under NODE_ENV=test and CIVIC_JOBS=0; start/stop are idempotent", () => {
    expect(startJobs()).toBe(false);
    process.env.NODE_ENV = "development";
    process.env.CIVIC_JOBS = "0";
    expect(startJobs()).toBe(false);
    delete process.env.CIVIC_JOBS;
    vi.useFakeTimers();
    expect(startJobs()).toBe(true);
    const n = vi.getTimerCount();
    expect(n).toBe(defaultJobs().length);
    expect(startJobs()).toBe(true);
    expect(vi.getTimerCount()).toBe(n);
    stopJobs(); stopJobs();
    expect(vi.getTimerCount()).toBe(0);
    expect(jobsStatus().started).toBe(false);
  });

  it("@E2E-81 timers are unref'd", () => {
    const unref = vi.fn();
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((...a: Parameters<typeof real>) => { const t = real(...a); clearInterval(t); return { unref, ref: () => undefined } as unknown as ReturnType<typeof real>; }) as typeof real);
    startJobs({ force: true });
    expect(unref).toHaveBeenCalledTimes(defaultJobs().length);
  });

  it("@E2E-81 every default job runs on its interval, records status and writes an audit entry", () => {
    vi.useFakeTimers();
    let now = T0;
    startJobs({ force: true, now: () => now });
    now = new Date(T0.getTime() + 25 * 3_600_000);
    vi.advanceTimersByTime(25 * 3_600_000);
    const s = jobsStatus();
    expect(s.jobs.map((j) => j.name).sort()).toEqual(["anchorAuditHead", "eraseDependentsAt18", "expireInvites", "purgeExpired", "purgeExpiredMedia", "sweep", "verifyAuditChain"].sort());
    for (const j of s.jobs) {
      expect(j.runs, j.name).toBeGreaterThan(0);
      expect(j.lastOk, j.name + " " + j.lastError).toBe(true);
      expect(j.lastRunAt).toBe(now.toISOString());
      expect(auditActions()).toContainEqual({ action: "job.run", object: "job:" + j.name });
    }
    expect(s.alarm).toBeNull();
  });

  it("@E2E-81 anchorAuditHead publishes to the anchor sink", () => {
    const got: AnchorRecord[] = [];
    setAnchorSink({ publish: (r) => { got.push(r); }, list: () => got });
    audit("system", "x.test", "obj");
    startJobs({ force: true });
    expect(runJob("anchorAuditHead", T0)).toBe(true);
    expect(got.length).toBe(1);
  });

  it("@E2E-81 a failing job does not stop the others and its error is recorded", () => {
    const ran: string[] = [];
    vi.useFakeTimers();
    startJobs({ force: true, jobs: [
      { name: "boom", intervalMs: 1000, run: () => { throw new Error("kaboom"); } },
      { name: "fine", intervalMs: 1000, run: () => { ran.push("fine"); return { ok: 1 }; } },
    ] });
    vi.advanceTimersByTime(3000);
    const j = Object.fromEntries(jobsStatus().jobs.map((x) => [x.name, x]));
    expect(j.boom).toMatchObject({ lastOk: false, lastError: "kaboom", failures: 3, runs: 3 });
    expect(j.fine).toMatchObject({ lastOk: true, failures: 0, runs: 3 });
    expect(ran.length).toBe(3);
    expect(auditActions().filter((a) => a.object === "job:boom").length).toBe(3);
  });

  it("@E2E-81 a job never overlaps itself", () => {
    let inner: boolean | undefined;
    startJobs({ force: true, jobs: [{ name: "reentrant", intervalMs: 60_000, run: () => { inner = runJob("reentrant"); } }] });
    expect(runJob("reentrant")).toBe(true);
    expect(inner).toBe(false);
    expect(jobsStatus().jobs[0].runs).toBe(1);
    expect(runJob("nope")).toBe(false);
  });

  it("@E2E-81 chain tampering raises an alarm (audit entry + exposed status)", () => {
    startJobs({ force: true });
    audit("system", "a.one", "o"); audit("system", "a.two", "o");
    runJob("verifyAuditChain", T0);
    expect(jobsStatus().alarm).toBeNull();
    getDb().prepare("UPDATE audit_log SET meta = '{\"n\":99}' WHERE seq = 1").run();
    runJob("verifyAuditChain", T0);
    const s = jobsStatus();
    expect(s.alarm).toMatchObject({ kind: "audit_chain_broken" });
    expect(s.alarm!.detail).toMatch(/seq 1/);
    expect(s.jobs.find((j) => j.name === "verifyAuditChain")).toMatchObject({ lastOk: false });
    expect(auditActions().some((a) => a.action === "alarm.audit_chain_broken")).toBe(true);
  });

  it("@E2E-81 default jobs do their work without error", () => {
    startJobs({ force: true });
    runAllJobs(T0);
    expect(jobsStatus().jobs.every((j) => j.lastOk)).toBe(true);
  });

  it("@E2E-81 the sweep job defers to the issue sweeper when that is running", async () => {
    const { startIssueSweeper, stopIssueSweeper } = await import("../../server/civic/issues/service");
    process.env.NODE_ENV = "development";
    startIssueSweeper(60_000);
    try {
      startJobs({ force: true });
      runJob("sweep", T0);
      expect(jobsStatus().jobs.find((j) => j.name === "sweep")!.lastResult).toMatchObject({ skipped: expect.stringMatching(/sweeper/) });
    } finally { stopIssueSweeper(); }
  });

  describe("GET /ops/jobs", () => {
    let server: Server, base = "";
    afterEach(() => { server?.close(); });
    it("@E2E-81 is admin-only and exposes the status table without secrets", async () => {
      const app = express();
      app.use("/api/v1/civic", createCivicRouter());
      await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", r); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic`;
      startJobs({ force: true });
      runAllJobs(T0);
      const admin = createPerson({ phone: "+919876500301", pin: "4821", consentVersion: "v1" });
      const user = createPerson({ phone: "+919876500302", pin: "4821", consentVersion: "v1" });
      grantRole("system", admin.id, "admin");
      expect((await fetch(base + "/ops/jobs")).status).toBe(401);
      expect((await fetch(base + "/ops/jobs", { headers: { authorization: "Bearer " + createSession(user.id) } })).status).toBe(403);
      const ok = await fetch(base + "/ops/jobs", { headers: { authorization: "Bearer " + createSession(admin.id) } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { started: boolean; jobs: unknown[] };
      expect(body.started).toBe(true);
      expect(body.jobs.length).toBe(7);
      expect(JSON.stringify(body)).not.toMatch(/secret|token|phone_hash|\bpin\b/i);
    });
  });
});
