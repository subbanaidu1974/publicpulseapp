import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter, loadDatasets } from "../../server/api";
import { deriveSegments, loadSegments } from "../../pipeline/lsmap/segments";
import { nearestLsYear, splitVotingReport } from "../../src/lib/splitvoting";
import type { CandidateResult } from "../../src/lib/elections";

let server: Server, base: string;
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as any, headers: r.headers }; };
beforeAll(() => {
  const app = express();
  app.use("/api/v1", createApiRouter(loadDatasets()));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => { server.close(); });

describe("@E2E-110 LS to assembly segment mapping", () => {
  it("committed segments.json maps every AC to exactly one PC and agrees with ac-link", () => {
    const s = loadSegments()!;
    expect(Object.keys(s.segments.AP)).toHaveLength(175);
    expect(Object.keys(s.segments.TG)).toHaveLength(119);
    expect(Object.keys(s.pcs.AP)).toHaveLength(25);
    expect(Object.keys(s.pcs.TG)).toHaveLength(17);
    expect(s.issues).toEqual([]);
    expect(Object.values(s.pcs.AP).reduce((n, a) => n + a.length, 0)).toBe(175);
    expect(s.segments.TG["1"]).toBe(1);
  });
  it("derive reports disagreements instead of silently resolving them and leaves unmapped ACs out", () => {
    const out = deriveSegments(
      [{ state: "AP", acNo: 1, pcNo: 2 }, { state: "AP", acNo: 2, pcNo: null }, { state: "TG", acNo: 1, pcNo: null }],
      { AP: { features: [{ properties: { acNo: 1, pcNo: 3 } }, { properties: { acNo: 2, pcNo: 4 } }] } }, "2026-01-01");
    expect(out.segments.AP).toEqual({ "1": 2, "2": 4 });
    expect(out.issues.some(i => /AC 1: ac-link says PC 2, boundaries say PC 3/.test(i))).toBe(true);
    expect(out.issues.some(i => /TG AC 1: no PC/.test(i))).toBe(true);
    expect(out.segments.TG).toEqual({});
  });
});

const row = (type: "assembly" | "ls", year: number, acNo: number, party: string, votes: number, pos: number, state: "AP" | "TG" = "AP"): CandidateResult =>
  ({ state, type, year, acNo, acName: `${type}${acNo}`, candidate: `${party}${acNo}`, party, votes, position: pos, validVotes: 1000 });

describe("@E2E-110 split voting helper", () => {
  const rows = [
    row("assembly", 2018, 1, "A", 600, 1), row("assembly", 2018, 1, "B", 400, 2),
    row("assembly", 2018, 2, "B", 700, 1), row("assembly", 2018, 2, "A", 300, 2),
    row("assembly", 2018, 3, "A", 500, 1), row("assembly", 2018, 3, "B", 500, 2),
    row("ls", 2019, 1, "A", 800, 1), row("ls", 2019, 1, "B", 200, 2),
  ];
  const seg = { "1": 1, "2": 1 }; // AC 3 unmapped
  it("nearest LS year is explicit; ties go earlier; beyond 2 years is none", () => {
    expect(nearestLsYear(2018, [2019, 2024])).toEqual({ lsYear: 2019, gap: 1 });
    expect(nearestLsYear(2019, [2014, 2024, 2019])).toEqual({ lsYear: 2019, gap: 0 });
    expect(nearestLsYear(2016, [2014, 2018])).toEqual({ lsYear: 2014, gap: 2 });
    expect(nearestLsYear(2014, [2019])).toBeNull();
  });
  it("counts aligned, split and unmapped seats and per-party differences", () => {
    const r = splitVotingReport(rows, "AP", 2018, seg)!;
    expect(r).toMatchObject({ assemblyYear: 2018, lsYear: 2019, gapYears: 1, sameCycle: false, totalSeats: 3, aligned: 1, split: 1, unmapped: 1 });
    expect(r.caveat).toMatch(/1 year\(s\) after/);
    expect(r.seats.find(s => s.acNo === 2)).toMatchObject({ split: true, assemblyParty: "B", lsParty: "A" });
    expect(r.seats.find(s => s.acNo === 3)!.split).toBeNull();
    expect(r.pcs).toHaveLength(1);
    expect(r.pcs[0]).toMatchObject({ pcNo: 1, lsParty: "A", segments: 2, aligned: 1, split: 1, assemblyWins: { A: 1, B: 1 } });
    // assembly in the PC1 segments: A 900 / B 1100 of 2000 polled; LS: A 800 / B 200 of 1000
    expect(r.pcs[0].voteShareDiff).toEqual({ A: -35, B: 35 });
    expect(r.voteShareDiff.A.ls).toBe(80);
  });
  it("returns null when an election is missing", () => {
    expect(splitVotingReport(rows, "AP", 2010, seg)).toBeNull();
    expect(splitVotingReport(rows, "TG", 2018, seg)).toBeNull();
    expect(splitVotingReport(rows, "AP", 2018, seg, 2024)).toBeNull();
  });
});

describe("@E2E-110 GET /elections/:state/split-voting", () => {
  it("TG 2023 is compared with LS 2024 and states the pairing", async () => {
    const r = await get("/elections/TG/split-voting?year=2023");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "TG", assemblyYear: 2023, lsYear: 2024, gapYears: 1, sameCycle: false, totalSeats: 119, unmapped: 0 });
    expect(r.body.aligned + r.body.split).toBe(119);
    expect(r.body.rule).toMatch(/nearest/i);
    expect(r.body.caveat).toBeTruthy();
    expect(r.body.pcs).toHaveLength(17);
    expect(r.body.voteShareDiff.INC).toBeDefined();
    expect(r.body.source).toBeTruthy();
    expect(r.headers.get("cache-control")).toMatch(/public/);
  });
  it("AP 2019 and 2024 are same-cycle pairs; default is the latest assembly year", async () => {
    for (const y of [2019, 2024]) {
      const r = await get(`/elections/AP/split-voting?year=${y}`);
      expect(r.body).toMatchObject({ assemblyYear: y, lsYear: y, sameCycle: true, caveat: null, totalSeats: 175 });
    }
    expect((await get("/elections/AP/split-voting")).body.assemblyYear).toBe(2024);
    expect((await get("/elections/TG/split-voting?year=2018")).body.lsYear).toBe(2019);
  });
  it("errors: AP 2014 has no LS within 2 years, bad year, unknown state", async () => {
    expect((await get("/elections/AP/split-voting?year=2014")).body.code).toBe("no_ls_pair");
    expect((await get("/elections/AP/split-voting?year=20x4")).status).toBe(400);
    expect((await get("/elections/AP/split-voting?year=1999")).status).toBe(404);
    expect((await get("/elections/XX/split-voting")).status).toBe(404);
  });
});
