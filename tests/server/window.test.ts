import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter } from "../../server/api";
import type { Datasets } from "../../server/api";
import { createSession, grantRole, migrate, resetDbForTests } from "../../server/civic/core";
import { createPerson } from "../../server/civic/identity/service";

const empty: Datasets = { elections: [], census: [], demo: true, status: [{ name: "elections", rows: 0, provenance: "demo", generatedAt: null }] };
let server: Server; let base: string;
const get = async (p: string, headers: Record<string, string> = {}) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, body: await r.json() as any };
};

beforeAll(async () => {
  const app = express();
  app.use("/api/v1", createApiRouter(empty));
  server = await new Promise<Server>((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((res) => { server.close(() => res()); }));
beforeEach(() => { delete process.env.FORECAST_BLACKOUT; delete process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST; });

describe("GET /election-window", () => {
  it("@E2E-133 shipped calendar has no verified entries: unknown, forecast hidden, surveys and notifications refused", async () => {
    const r = await get("/election-window?state=AP");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "AP", window: "unknown", surveysAllowed: false, notificationsAllowed: false, forecast: { show: false, reason: "unknown" }, flagSource: "calendar" });
    expect(r.body.calendar.verifiedEntries).toBe(0);
  });
  it("@E2E-133 the fail-open env lifts only the forecast, never surveys", async () => {
    process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST = "1";
    const r = await get("/election-window?state=TG");
    expect(r.body.forecast).toEqual({ show: true, reason: "unknown-fail-open" });
    expect(r.body.surveysAllowed).toBe(false);
  });
  it("@E2E-133 FORECAST_BLACKOUT=1 is reported as the flag source", async () => {
    process.env.FORECAST_BLACKOUT = "1";
    const r = await get("/election-window?state=AP");
    expect(r.body).toMatchObject({ window: "blackout", flagSource: "env:FORECAST_BLACKOUT" });
  });
  it("@E2E-133 validates the state with a coded error", async () => {
    expect((await get("/election-window")).body.code).toBe("missing_state");
    const r = await get("/election-window?state=XX");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("unknown_state");
  });
  it("@E2E-133 the forecast route withholds seats when the window is unknown (fail closed)", async () => {
    const r = await get("/elections/AP/forecast");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ blackout: true, window: "unknown", withheldReason: "unknown" });
    expect(r.body.seats).toBeUndefined();
    expect(r.body.backtest).toBeUndefined();
  });
});

describe("GET /data-status/admin", () => {
  const tmp = path.join(os.tmpdir(), `civic-window-${process.pid}-${Date.now()}.db`);
  let admin = ""; let resident = "";
  beforeAll(() => {
    process.env.CIVIC_DB = tmp;
    resetDbForTests(); migrate();
    const a = createPerson({ phone: "+919876500801", pin: "4821", consentVersion: "v1" });
    const b = createPerson({ phone: "+919876500802", pin: "4821", consentVersion: "v1" });
    grantRole("system", a.id, "admin");
    admin = createSession(a.id); resident = createSession(b.id);
  });
  afterAll(() => { resetDbForTests(); delete process.env.CIVIC_DB; for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) { try { fs.rmSync(f); } catch { /* ignore */ } } });

  it("@E2E-19 no token is 401", async () => { expect((await get("/data-status/admin")).status).toBe(401); });
  it("@E2E-19 a non-admin session is 403", async () => {
    expect((await get("/data-status/admin", { authorization: `Bearer ${resident}` })).status).toBe(403);
  });
  it("@E2E-19 a garbage token is 401", async () => {
    expect((await get("/data-status/admin", { authorization: "Bearer nope" })).status).toBe(401);
  });
  it("@E2E-19 an admin session is 200 with the per-source status", async () => {
    const r = await get("/data-status/admin", { authorization: `Bearer ${admin}` });
    expect(r.status).toBe(200);
    expect(r.body.datasets[0].name).toBe("elections");
  });
});
