import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter, loadDatasets } from "../../server/api";

let server: Server;
let base: string;
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any, headers: r.headers }; };

beforeAll(async () => {
  const app = express();
  app.use("/api/v1", createApiRouter(loadDatasets()));
  server = await new Promise<Server>(res => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>(res => { delete process.env.FORECAST_BLACKOUT; server.close(() => res()); }));

describe("GET /elections/:state/forecast", () => {
  for (const st of ["AP", "TG", "tg"]) {
    it(`${st}: shape, disclaimer, sorted seats, probabilities, back-test`, async () => {
      const { status, body, headers } = await get(`/elections/${st}/forecast`);
      expect(status).toBe(200);
      expect(headers.get("cache-control")).toMatch(/max-age/);
      expect(body.method).toBe("uniform-swing-damped-v1");
      expect(body.blackout).toBe(false);
      expect(body.disclaimer).toBe("Model projection from past results. Not a poll, not a prediction of any outcome.");
      expect(body.basedOn.assembly).toBeGreaterThan(2000);
      const nos: number[] = body.seats.map((s: any) => s.acNo);
      expect(nos).toEqual([...nos].sort((a, b) => a - b));
      for (const s of body.seats) { expect(s.winProbLeader).toBeGreaterThanOrEqual(0); expect(s.winProbLeader).toBeLessThanOrEqual(1); expect(["safe", "lean", "toss-up"]).toContain(s.class); }
      for (const a of body.alliances) { expect(a.majorityProb).toBeGreaterThanOrEqual(0); expect(a.majorityProb).toBeLessThanOrEqual(1); }
      expect(body.backtest.runs.length).toBeGreaterThan(0);
      expect(body.backtest.runs[0]).toHaveProperty("winnerHitRate");
      expect(body.backtest.runs[0]).toHaveProperty("seatError");
    });
  }
  it("is deterministic across calls", async () => {
    const a = await get("/elections/AP/forecast"), b = await get("/elections/AP/forecast");
    expect(b.body).toEqual(a.body);
  });
  it("unknown state -> 404 JSON", async () => {
    const r = await get("/elections/XX/forecast");
    expect(r.status).toBe(404);
    expect(r.body.error).toBeTruthy();
  });
  it("blackout fails closed with 200, no seats or alliances", async () => {
    process.env.FORECAST_BLACKOUT = "1";
    try {
      const r = await get("/elections/AP/forecast");
      expect(r.status).toBe(200);
      expect(r.body.blackout).toBe(true);
      expect(r.body.seats).toBeUndefined();
      expect(r.body.alliances).toBeUndefined();
      expect(r.body.backtest).toBeUndefined();
    } finally { delete process.env.FORECAST_BLACKOUT; }
    expect((await get("/elections/AP/forecast")).body.blackout).toBe(false);
  });
});
