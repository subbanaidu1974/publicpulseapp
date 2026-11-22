import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  computeReadiness, currentRequestId, log, metricsAllowed, obsRouter, redact, redactString, renderMetrics,
  requestContext, resetMetricsForTests, routeClass, setLogSink, type ReadyDeps,
} from "../../server/obs";

const okDeps = (over: Partial<ReadyDeps> = {}): ReadyDeps => ({
  dbPing: () => undefined,
  migrations: () => ({ registered: 3, applied: 3, pending: [], drift: [] }),
  jobs: () => ({ started: true, alarm: null, jobs: [{ name: "verifyAuditChain", runs: 2, failures: 0, lastOk: true, lastRunAt: "2026-01-01T00:00:00Z" }] }),
  demoProvenance: () => [],
  ...over,
});

let lines: Record<string, unknown>[] = [];
const capture = () => { lines = []; setLogSink((l) => lines.push(JSON.parse(l))); };
afterEach(() => { setLogSink(() => undefined); resetMetricsForTests(); });

describe("UT-obs redaction", () => {
  it("@E2E-82 never lets phone numbers, OTPs, PINs, tokens or e-mail into a log line", () => {
    capture();
    log.info("otp sent to +91 98765 43210 code 123456", { phone: "9876543210", otp: "123456", nested: { pin: "4321", authorization: "Bearer abcdefghijkl", note: "call 9876543210 or mail a.b@example.com" } });
    log.error("failed", { error: new Error("could not text 09876543210, otp=654321") });
    const text = JSON.stringify(lines);
    for (const bad of ["9876543210", "98765 43210", "123456", "4321", "abcdefghijkl", "a.b@example.com", "654321"]) expect(text).not.toContain(bad);
    expect(lines[0].phone).toBe("[redacted]");
    expect(lines[0].msg).toContain("[phone]");
  });

  it("@E2E-82 keeps ordinary values intact", () => {
    expect(redactString("request took 125 ms for civic_issues")).toBe("request took 125 ms for civic_issues");
    expect(redact({ status: 200, route: "api" })).toEqual({ status: 200, route: "api" });
  });

  it("@E2E-82 routeClass is low-cardinality and carries no ids or queries", () => {
    expect(routeClass("/api/v1/civic/identity/otp/9876543210")).toBe("civic_identity");
    expect(routeClass("/api/v1/elections")).toBe("api");
    expect(routeClass("/healthz")).toBe("healthz");
    expect(routeClass("/some/page")).toBe("static");
  });
});

describe("UT-obs http", () => {
  let server: Server; let base: string;
  let deps = okDeps();
  const env: NodeJS.ProcessEnv = {};
  beforeAll(async () => {
    const app = express();
    app.use(requestContext());
    app.use(obsRouter({ dbPing: () => deps.dbPing(), migrations: () => deps.migrations(), jobs: () => deps.jobs(), demoProvenance: () => deps.demoProvenance() }, env));
    app.get("/api/v1/civic/identity/x", (_req, res) => { log.info("handler line", { phone: "9876543210" }); res.json({ reqId: currentRequestId() }); });
    server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { server.close(() => r()); }));

  it("@E2E-82 honours a safe inbound X-Request-Id, generates one otherwise, and puts it in every log line", async () => {
    capture();
    const a = await fetch(`${base}/api/v1/civic/identity/x`, { headers: { "x-request-id": "client-req-12345" } });
    expect(a.headers.get("x-request-id")).toBe("client-req-12345");
    expect((await a.json()).reqId).toBe("client-req-12345");
    const b = await fetch(`${base}/api/v1/civic/identity/x`, { headers: { "x-request-id": "bad id with spaces" } });
    expect(b.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    await new Promise((r) => setTimeout(r, 50));
    const mine = lines.filter((l) => l.reqId === "client-req-12345");
    expect(mine.map((l) => l.msg)).toEqual(expect.arrayContaining(["handler line", "request"]));
    expect(lines.every((l) => typeof l.reqId === "string")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("9876543210");
  });

  it("@E2E-82 /healthz is liveness only; /readyz is 503 when the audit chain alarm is raised, the DB is down or migrations are pending", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ok = await fetch(`${base}/readyz`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    deps = okDeps({ jobs: () => ({ started: true, alarm: { kind: "audit_chain_broken", at: "t", detail: "x" }, jobs: [] }) });
    const bad = await fetch(`${base}/readyz`);
    expect(bad.status).toBe(503);
    expect((await bad.json()).checks.auditChain.ok).toBe(false);
    deps = okDeps({ dbPing: () => { throw new Error("disk I/O error"); } });
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    deps = okDeps({ migrations: () => ({ registered: 3, applied: 2, pending: ["x"], drift: [] }) });
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    deps = okDeps();
  });

  it("@E2E-82 /metrics exposes request counts, latency and job status, and is token-gated when METRICS_TOKEN is set", async () => {
    await fetch(`${base}/api/v1/civic/identity/x`);
    await new Promise((r) => setTimeout(r, 30));
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('pulse_http_requests_total{route="civic_identity",status="2xx"}');
    expect(text).toContain("pulse_http_request_duration_seconds_count");
    expect(text).toContain('pulse_job_last_ok{job="verifyAuditChain"} 1');
    expect(text).toContain("pulse_ready 1");
    env.METRICS_TOKEN = "s3cret-token";
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: "Bearer wrong" } })).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
    delete env.METRICS_TOKEN;
  });
});

describe("UT-obs units", () => {
  it("@E2E-82 metricsAllowed: loopback only, never when forwarded through a proxy, token overrides", () => {
    const req = (addr: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: addr } }) as never;
    expect(metricsAllowed(req("127.0.0.1"), {})).toBe(true);
    expect(metricsAllowed(req("::1"), {})).toBe(true);
    expect(metricsAllowed(req("10.0.0.5"), {})).toBe(false);
    expect(metricsAllowed(req("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }), {})).toBe(false);
    expect(metricsAllowed(req("10.0.0.5", { authorization: "Bearer t" }), { METRICS_TOKEN: "t" })).toBe(true);
    expect(metricsAllowed(req("127.0.0.1"), { METRICS_TOKEN: "t" })).toBe(false);
  });

  it("@E2E-82 computeReadiness reports data provenance without failing on it and renders gauges", () => {
    const r = computeReadiness(okDeps({ demoProvenance: () => ["census.json"] }));
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.checks.dataProvenance)).toContain("census.json");
    expect(renderMetrics(null, r)).toContain("pulse_ready 1");
  });
});
