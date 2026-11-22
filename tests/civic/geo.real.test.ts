import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, migrate, resetDbForTests } from "../../server/civic/core";
import { buildRealGeoDataset, hasRealGeo, lgdCode, rawLgd } from "../../server/civic/geo/real";
import { geoRouter } from "../../server/civic/geo/routes";
import { ancestors, electionConstituency, getUnit, importGeo, resetAcLinkForTests, villageConstituencies } from "../../server/civic/geo/service";
import { AcLink } from "../../pipeline/geo/link";

const ROOT = resolve(__dirname, "../..");
let server: Server, base: string;
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as any }; };

beforeAll(() => {
  const app = express(); app.use("/geo", geoRouter);
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/geo`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); resetAcLinkForTests(); });

describe("@E2E-95 real LGD import into the civic geo tables (S-80)", () => {
  it("builds the real dataset with namespaced codes and no hamlets", () => {
    expect(hasRealGeo(ROOT)).toBe(true);
    const { data, asOf } = buildRealGeoDataset(ROOT);
    const by = (l: string) => data.units.filter(u => u.level === l);
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([by("state").length, by("district").length, by("mandal").length, by("constituency").length]).toEqual([2, 61, 1309, 294]);
    expect(by("village").length).toBeGreaterThan(29000);
    expect(data.hamlets).toEqual([]); // hamlets stay human-reviewed; nothing is auto-created
    expect(new Set(data.units.map(u => u.lgd)).size).toBe(data.units.length); // namespacing prevents cross-level collisions
    expect(data.units.every(u => u.parent === null || /^(S|D|M|V|AC)-/.test(u.parent))).toBe(true);
    expect(data.units.some(u => u.lgd.startsWith("DEMO-"))).toBe(false);
    expect(data.villageConstituency.length).toBeGreaterThan(29000);
    expect(data.units.filter(u => u.te).length).toBeGreaterThan(10000); // TG village names + gazetteer names
    expect(lgdCode.ac("3161")).toBe("AC-3161");
    expect(rawLgd("AC-3161")).toBe("3161");
    expect(rawLgd("V-1")).toBe("1");
  });

  it("imports idempotently and resolves village -> mandal -> district -> state and village -> constituency", () => {
    const { data } = buildRealGeoDataset(ROOT);
    importGeo(data);
    const again = importGeo(data);
    const c = (t: string) => (getDb().prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    expect(c("admin_unit")).toBe(again.units);
    expect(c("village_constituency")).toBe(again.links);
    expect(c("hamlet")).toBe(0);
    // Karanji (T), Adilabad district, Boath constituency (eci 8)
    const chain = ancestors("V-568945").map(u => [u.level, u.name_en]);
    expect(chain).toEqual([["village", "Karanji (T)"], ["mandal", "Bheempur"], ["district", "Adilabad"], ["state", "Telangana"]]);
    const acs = villageConstituencies("V-568945");
    expect(acs.map(a => a.name_en)).toEqual(["Boath"]);
    expect(electionConstituency(acs[0].lgd)).toMatchObject({ state: "TG", acNo: 8, name: expect.stringMatching(/boath/i) });
    expect(getUnit("D-508")?.name_te).toBeTruthy();
  });

  it("geo route adds the election constituency (S-102) next to the LGD constituency", async () => {
    importGeo(buildRealGeoDataset(ROOT).data);
    const r = await get("/village/V-568945/constituency");
    expect(r.body.constituencies.map((c: any) => c.lgd)).toEqual(["AC-3161"]);
    expect(r.body.electionConstituencies).toEqual([expect.objectContaining({ state: "TG", acNo: 8, pcNo: 1, reservation: "ST" })]);
  });

  it("electionConstituency honours validity dates and unknown codes", () => {
    resetAcLinkForTests(new AcLink([{ state: "AP", acNo: 5, eci: 124, lgd: "77", name: "X", pcNo: 2, reservation: "GEN", validFrom: "2008-02-19", validTo: "2030-01-01", datesInferred: true }]));
    expect(electionConstituency("AC-77", "2026-01-01")).toMatchObject({ state: "AP", acNo: 5 });
    expect(electionConstituency("77", new Date("2031-01-01"))).toBeNull();
    expect(electionConstituency("AC-404")).toBeNull();
  });
});

describe("@E2E-95 import-lgd CLI never auto-seeds demo data", () => {
  const run = (cwd: string, args: string[] = []) => spawnSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "scripts/import-lgd.ts"), ...args],
    { cwd, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", CIVIC_DB: ":memory:" } });
  it("fails with guidance when no LGD data exists and loads demo only when --demo is explicit", () => {
    const empty = mkdtempSync(join(tmpdir(), "lgd-empty-"));
    try {
      const r = run(empty);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/fetch-lgd/);
      expect(r.stdout).not.toMatch(/DEMO/);
      const d = run(ROOT, ["--demo"]);
      expect(d.status).toBe(0);
      expect(d.stdout).toMatch(/DEMO fixture/);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
  it("imports the committed real snapshot by default", () => {
    const r = run(ROOT);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Real LGD snapshot as of \d{4}-\d{2}-\d{2}/);
    expect(r.stdout).toMatch(/Imported \d+ units, 0 hamlets/);
  });
  it("--file imports a custom dataset and a missing --url fails loudly", () => {
    const r = run(ROOT, ["--file", "data/civic/demo-geo.json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Imported \d+ units/);
    expect(run(ROOT, ["--url", "http://127.0.0.1:9/none.json"]).status).not.toBe(0);
  });
});
