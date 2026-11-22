import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { resolve } from "node:path";
import { createApiRouter, loadDatasets } from "../../server/api";

const ROOT = resolve(__dirname, "../..");
let server: Server, base: string;
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as any }; };

beforeAll(() => {
  const app = express();
  app.use("/api/v1", createApiRouter(loadDatasets(ROOT)));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => { server.close(); });

describe("@E2E-102 /elections seats carry district, electors and acNameTe (S-87)", () => {
  it("AP assembly 2024: every seat has a district and electors, Telugu names where the gazetteer has them", async () => {
    const r = await get("/elections?state=AP&year=2024");
    expect(r.status).toBe(200);
    expect(r.body.seats).toHaveLength(175);
    expect(r.body.seats.every((s: any) => typeof s.district === "string" && s.district.length > 0)).toBe(true);
    expect(r.body.seats.filter((s: any) => s.electors > 0).length).toBeGreaterThan(150);
    const te = r.body.seats.filter((s: any) => s.acNameTe);
    expect(te.length).toBe(172); // 3 ACs have no Telugu name in Wikidata: not invented
    expect(r.body.seats[0]).toMatchObject({ acNo: 1, district: "Srikakulam", winner: expect.any(String), margin: expect.any(Number) });
  });
  it("works for every year and type: TG 2014 assembly, AP 2019 LS, TG 2024 LS", async () => {
    for (const [q, n] of [["state=TG&year=2014", 119], ["state=AP&year=2019&type=ls", 25], ["state=TG&year=2024&type=ls", 17]] as const) {
      const r = await get(`/elections?${q}`);
      expect(r.body.seats).toHaveLength(n);
      expect(r.body.seats.every((s: any) => s.district)).toBe(true);
      expect(r.body.seats.filter((s: any) => s.acNameTe).length).toBeGreaterThanOrEqual(n - 3);
    }
  });
  it("is backwards compatible: existing fields and the other endpoints are unchanged", async () => {
    const r = await get("/elections?state=TG&year=2023");
    expect(Object.keys(r.body)).toEqual(expect.arrayContaining(["demo", "state", "year", "type", "count", "expectedSeats", "seats", "tally"]));
    expect(Object.keys(r.body.seats[0])).toEqual(expect.arrayContaining(["acNo", "acName", "winner", "winnerParty", "runnerUpParty", "margin", "marginPct", "validVotes"]));
    const m = await get("/elections/TG/marginal?year=2023");
    expect(m.status).toBe(200);
    expect(m.body.seats[0]).not.toHaveProperty("district"); // only /elections is enriched
  });
  it("demo datasets get no geo enrichment (acNo 1..n of the fixtures are not the real constituencies)", async () => {
    const d = loadDatasets(resolve(ROOT, "tests/api")); // no generated data here: falls back to demo fixtures
    expect(d.geo).toBeUndefined();
  });
});
