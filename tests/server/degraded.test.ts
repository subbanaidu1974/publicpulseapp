import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { SmoothedQueue, degradedGate, degradedPayload, degradedState, markSmsExhausted, recordOutcome, resetDegradedForTests, shedRuleFor } from "../../server/degraded";
import { obsRouter } from "../../server/obs";

const ENV = ["CIVIC_DEGRADED", "CIVIC_OTP_MIN_BURST", "CIVIC_OTP_SMOOTH_FACTOR", "CIVIC_OTP_QUEUE_MAX", "CIVIC_OTP_MAX_WAIT_SECONDS", "CIVIC_DEGRADED_MIN_HOLD_SECONDS", "CIVIC_DEGRADED_RETRY_SECONDS", "CIVIC_DEGRADED_QUEUE_DEPTH"];
beforeEach(() => { resetDegradedForTests(); });
afterEach(() => { for (const k of ENV) delete process.env[k]; resetDegradedForTests(); });

describe("degraded state (S-46)", () => {
  it("@E2E-56 is off by default and on with CIVIC_DEGRADED=1 (read live)", () => {
    expect(degradedState().degraded).toBe(false);
    process.env.CIVIC_DEGRADED = "1";
    expect(degradedState()).toMatchObject({ degraded: true, reasons: ["operator"] });
    delete process.env.CIVIC_DEGRADED;
    process.env.CIVIC_DEGRADED_MIN_HOLD_SECONDS = "0";
    expect(degradedState().degraded).toBe(false);
  });

  it("@E2E-56 turns on when the SMS budget is exhausted, and stays on through the hold window", () => {
    process.env.CIVIC_DEGRADED_MIN_HOLD_SECONDS = "30";
    const t = 1_000_000;
    markSmsExhausted(t);
    expect(degradedState(t + 1000).reasons).toContain("sms_budget");
    expect(degradedState(t + 301_000).degraded).toBe(false); // budget hold over and the 30 s hysteresis long past
    process.env.CIVIC_DEGRADED = "1";
    expect(degradedState(t + 400_000).degraded).toBe(true);
    delete process.env.CIVIC_DEGRADED;
    expect(degradedState(t + 410_000).degraded).toBe(true); // hysteresis: still on 10 s after the cause ended
    expect(degradedState(t + 431_000).degraded).toBe(false);
  });

  it("@E2E-56 turns on at a high 5xx share (deliberate 503 sheds do not count) and needs enough samples", () => {
    const t = 5_000_000;
    for (let i = 0; i < 30; i++) recordOutcome(500, t);
    expect(degradedState(t).degraded).toBe(false); // too few samples
    for (let i = 0; i < 20; i++) recordOutcome(200, t);
    expect(degradedState(t).reasons).toContain("error_rate");
    resetDegradedForTests();
    for (let i = 0; i < 100; i++) recordOutcome(503, t);
    expect(degradedState(t).degraded).toBe(false);
  });

  it("@E2E-56 turns on when the OTP queue is deep", () => {
    process.env.CIVIC_OTP_MIN_BURST = "1"; process.env.CIVIC_DEGRADED_QUEUE_DEPTH = "2"; process.env.CIVIC_OTP_MAX_WAIT_SECONDS = "100000";
    const q = new SmoothedQueue(() => 0);
    q.admit(1);
    for (let i = 0; i < 2; i++) { expect(q.admit(1).lane).toBe("queued"); q.enqueue(async () => undefined, 1); }
    expect(q.depth()).toBe(2);
    q.reset();
  });

  it("@E2E-56 the banner payload is bilingual and present only while degraded", () => {
    expect(degradedPayload().banner).toBeNull();
    process.env.CIVIC_DEGRADED = "1";
    const p = degradedPayload();
    expect(p.read_only).toBe(true);
    expect(p.banner?.body_en).toBeTruthy();
    expect(/[ఀ-౿]/.test(p.banner!.body_te)).toBe(true);
  });
});

describe("priority table and shedding", () => {
  it("@E2E-56 sheds exports, uploads, sign-up OTPs, consultation and household writes, credential requests, survey admin writes; keeps reads and respond", () => {
    for (const [m, p] of [["GET", "/issues/export"], ["GET", "/scope/export"], ["POST", "/issues/media"], ["POST", "/identity/signup/request"], ["POST", "/consultations/c1/feedback"], ["POST", "/surveys/s1/credential/request"], ["POST", "/surveys"], ["PATCH", "/surveys/s1/close"], ["POST", "/households/h1/members"], ["POST", "/issues/i1/me-too"]] as const) {
      expect(shedRuleFor(m, p), `${m} ${p}`).not.toBeNull();
    }
    for (const [m, p] of [["GET", "/issues/feed"], ["GET", "/issues"], ["GET", "/issues/i1"], ["GET", "/surveys/s1/results"], ["POST", "/surveys/s1/respond"], ["POST", "/identity/login"], ["POST", "/identity/signup/verify"], ["POST", "/issues"], ["GET", "/audit/head"], ["GET", "/geo/search"], ["POST", "/admin/roles/requests"], ["POST", "/identity/pin/recover/request"]] as const) {
      expect(shedRuleFor(m, p), `${m} ${p}`).toBeNull();
    }
  });

  it("@E2E-56 the gate answers 503 + Retry-After + bilingual notice for shed routes, lengthens public caches, and does nothing when healthy", async () => {
    const app = express();
    app.use(degradedGate());
    app.get("/issues/export", (_q, r) => { r.send("x"); });
    app.get("/issues/feed", (_q, r) => { r.set("Cache-Control", "public, max-age=60"); r.json({ ok: true }); });
    app.post("/identity/login", (_q, r) => { r.json({ ok: true }); });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      expect((await fetch(base + "/issues/export")).status).toBe(200);
      process.env.CIVIC_DEGRADED = "1"; process.env.CIVIC_DEGRADED_RETRY_SECONDS = "45";
      const shed = await fetch(base + "/issues/export");
      expect(shed.status).toBe(503);
      expect(shed.headers.get("retry-after")).toBe("45");
      const body = await shed.json();
      expect(body).toMatchObject({ error: "degraded", degraded: true, shed: "export", retry_after_seconds: 45 });
      expect(body.notice_en).toBeTruthy(); expect(/[ఀ-౿]/.test(body.notice_te)).toBe(true);
      const feed = await fetch(base + "/issues/feed");
      expect(feed.status).toBe(200);
      expect(feed.headers.get("cache-control")).toMatch(/public, max-age=60, stale-while-revalidate=\d+, stale-if-error=\d+/);
      expect(feed.headers.get("x-degraded")).toBe("1");
      expect((await fetch(base + "/identity/login", { method: "POST" })).status).toBe(200);
    } finally { srv.close(); }
  });

  it("@E2E-56 GET /api/v1/degraded and /readyz info expose the state", async () => {
    const app = express();
    app.use(obsRouter({ dbPing: () => undefined, migrations: () => ({ registered: 0, applied: 0, pending: [], drift: [] }), jobs: () => ({ started: false, alarm: null, jobs: [] }), demoProvenance: () => [] }));
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      expect((await (await fetch(base + "/api/v1/degraded")).json()).degraded).toBe(false);
      process.env.CIVIC_DEGRADED = "1";
      const d = await (await fetch(base + "/api/v1/degraded")).json();
      expect(d).toMatchObject({ degraded: true, read_only: true });
      const ready = await (await fetch(base + "/readyz")).json();
      expect(ready.info.degraded.degraded).toBe(true);
    } finally { srv.close(); }
  });
});

describe("OTP queue and budget smoothing", () => {
  it("@E2E-56 spends the budget evenly: a burst leaves per-slot, the rest waits and is released slot by slot, overflow is refused", async () => {
    process.env.CIVIC_OTP_MIN_BURST = "2"; // 120 per hour = 2 per minute, factor 2 -> 4 per slot
    let now = 0;
    const q = new SmoothedQueue(() => now);
    const sent: number[] = [];
    const lanes: string[] = [];
    for (let i = 0; i < 13; i++) {
      const a = q.admit(120);
      lanes.push(a.lane);
      if (a.lane === "now") sent.push(i);
      else if (a.lane === "queued") q.enqueue(async () => { sent.push(i); }, 120);
    }
    expect(lanes.filter((l) => l === "now").length).toBe(4);
    expect(lanes.filter((l) => l === "queued").length).toBe(8);
    expect(lanes.filter((l) => l === "full").length).toBe(1);
    expect(q.depth()).toBe(8);
    expect(sent).toEqual([0, 1, 2, 3]);
    now = 60_000; expect(await q.drain(now)).toBe(4);
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    now = 120_000; expect(await q.drain(now)).toBe(4);
    expect(q.depth()).toBe(0);
    expect(sent.length).toBe(12);
    q.reset();
  });

  it("@E2E-56 the queue is bounded", () => {
    process.env.CIVIC_OTP_MIN_BURST = "1"; process.env.CIVIC_OTP_QUEUE_MAX = "3"; process.env.CIVIC_OTP_MAX_WAIT_SECONDS = "100000";
    const q = new SmoothedQueue(() => 0);
    expect(q.admit(1).lane).toBe("now");
    for (let i = 0; i < 3; i++) { expect(q.admit(1).lane).toBe("queued"); q.enqueue(async () => undefined, 1); }
    const full = q.admit(1);
    expect(full.lane).toBe("full");
    expect(full.retryAfterSeconds).toBeGreaterThan(0);
    q.reset();
  });
});
