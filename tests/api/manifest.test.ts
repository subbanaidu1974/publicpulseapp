import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { resolve } from "node:path";
import { createApiRouter } from "../../server/api";
import type { Datasets } from "../../server/api";
import { datasetForPath, loadManifestIndex } from "../../server/manifest";
import type { CandidateResult } from "../../src/lib/elections";

const ROOT = resolve(__dirname, "../..");
const row = (state: "AP" | "TG", year: number, acNo: number, party: string, votes: number, position: number): CandidateResult =>
  ({ state, year, type: "assembly", acNo, acName: `AC-${acNo}`, candidate: `${party}${acNo}`, party, votes, position, validVotes: 1000, provenance: "TCPD" });

const elections: CandidateResult[] = [
  row("AP", 2014, 1, "TDP", 600, 1), row("AP", 2014, 1, "YSRCP", 400, 2),
  row("AP", 2019, 1, "YSRCP", 600, 1), row("AP", 2019, 1, "TDP", 400, 2),
  row("TG", 2018, 1, "BRS", 600, 1), row("TG", 2018, 1, "INC", 400, 2),
  row("TG", 2023, 1, "INC", 600, 1), row("TG", 2023, 1, "BRS", 400, 2),
];

let server: Server, base: string;
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any }; };

function start(data: Datasets) {
  const app = express();
  app.use("/api/v1", createApiRouter(data));
  return new Promise<Server>(res => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
}

describe("@E2E-108 /api/v1 envelopes carry source and asOf from the manifest", () => {
  const manifest = loadManifestIndex(ROOT);
  beforeAll(async () => {
    server = await start({
      elections, census: [], demo: false, manifest,
      status: [{ name: "elections", rows: elections.length, provenance: "TCPD", generatedAt: null }],
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  it("loads the manifest index for the committed data", () => {
    expect(manifest).not.toBeNull();
    expect(Object.keys(manifest!)).toEqual(expect.arrayContaining(["elections", "census-districts", "parties", "alliances"]));
    expect(datasetForPath("/elections/AP/summary")).toBe("elections");
    expect(datasetForPath("/census/AP/districts")).toBe("census-districts");
    expect(datasetForPath("/elections/AP/forecast")).toBeNull();
    expect(datasetForPath("/health")).toBeNull();
  });

  it("election responses include source (URLs, licences, attribution, provenance) and asOf", async () => {
    const { status, body } = await get("/elections?state=AP&year=2019");
    expect(status).toBe(200);
    expect(body.source.dataset).toBe("elections");
    expect(body.source.urls.length).toBeGreaterThan(0);
    expect(body.source.licences).toContain("tcpd-nc");
    expect(body.source.attribution).toMatch(/Election Commission of India/);
    expect(body.asOf).toBe(manifest!.elections.asOf);
    expect(body.asOf).toMatch(/2024/);
  });

  it("does not stamp errors or non-dataset routes", async () => {
    const bad = await get("/elections?state=ZZ");
    expect(bad.status).toBe(404);
    expect(bad.body.source).toBeUndefined();
    const h = await get("/health");
    expect(h.body.source).toBeUndefined();
  });

  it("swing responses carry comparability notes (AP 2014 residual state, district reorganisation)", async () => {
    const { body } = await get("/elections/AP/swing?from=2014&to=2019");
    expect(Array.isArray(body.notes)).toBe(true);
    const n = body.notes.join(" ");
    expect(n).toMatch(/residual state/);
    expect(n).toMatch(/13 districts to 26/);
    expect(body.source.dataset).toBe("elections");
    const tg = await get("/elections/TG/swing?from=2018&to=2023");
    expect(tg.body.notes.join(" ")).toMatch(/renamed Bharat Rashtra Samithi/);
  });

  it("works without a manifest (older callers keep the previous shape)", async () => {
    const s2 = await start({ elections, census: [], demo: false, status: [] });
    const b = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/v1`;
    const body = await (await fetch(`${b}/elections?state=AP&year=2019`)).json() as any;
    expect(body.source).toBeUndefined();
    await new Promise<void>(r => s2.close(() => r()));
  });
});
