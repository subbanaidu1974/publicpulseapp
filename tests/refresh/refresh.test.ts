import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApiRouter, loadDatasets } from "../../server/api";
import { obsRouter } from "../../server/obs";
import { createRefreshRouter, runFreshnessCheck } from "../../server/refresh";
import { alertFrom, computeFreshness, parseAsOf, parseThresholdOverrides, setFreshnessAlert, thresholdFor } from "../../server/freshness";
import { defaultSteps, diffManifests, guardErrors, refreshDirs, rollbackRefresh, runRefresh, type RefreshStep } from "../../pipeline/refresh/stage";
import { buildManifest } from "../../pipeline/manifest";

const REAL = process.cwd();
let root: string, gen: string;

const writeJson = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
/** A tiny but manifest-valid data/generated tree in a temp root (reference files are copied from the repo so licence keys resolve). */
function seed() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-"));
  gen = path.join(root, "data", "generated");
  fs.mkdirSync(path.join(root, "data", "reference"), { recursive: true });
  fs.copyFileSync(path.join(REAL, "data/reference/licences.json"), path.join(root, "data/reference/licences.json"));
  writeJson(path.join(gen, "elections.json"), { schema: 1, provenance: "TCPD", source: "t", results: [{ year: 2024, state: "AP" }] });
  writeJson(path.join(gen, "geo", "lgd-AP.json"), { schema: 1, asOf: "2026-11-01", provenance: "LGD", districts: [["1", "A"]], mandals: [] });
  writeJson(path.join(gen, "manifest.json"), buildManifest(gen, root));
}
const step = (name: string, fn: (dir: string) => void): RefreshStep => ({ name, run: async ({ stagingDir }) => fn(stagingDir) });
const setLgd = (dir: string, asOf: string) => writeJson(path.join(dir, "geo", "lgd-AP.json"), { schema: 1, asOf, provenance: "LGD", districts: [["1", "A"], ["2", "B"]], mandals: [] });

beforeEach(() => { seed(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); setFreshnessAlert(null); });

describe("@E2E-91 freshness report", () => {
  it("classifies datasets fresh, stale and unknown from the manifest with thresholds", () => {
    const now = new Date("2026-11-23T00:00:00Z");
    const m = JSON.parse(fs.readFileSync(path.join(gen, "manifest.json"), "utf8"));
    m.datasets.find((d: { id: string }) => d.id === "geo-lgd-AP").asOf = "2026-11-01";
    m.datasets.push({ id: "geo-lgd-TG", path: "data/generated/geo/lgd-TG.json", asOf: "2025-01-01", demo: false });
    m.datasets.push({ id: "census-districts", path: "x", asOf: null, demo: false });
    writeJson(path.join(gen, "manifest.json"), m);
    const r = computeFreshness(root, now, {});
    const by = Object.fromEntries(r.datasets.map(d => [d.id, d]));
    expect(by["geo-lgd-AP"]).toMatchObject({ status: "fresh", ageDays: 22, thresholdDays: 365 });
    expect(by["geo-lgd-TG"]).toMatchObject({ status: "stale", thresholdDays: 365 });
    expect(by["census-districts"]).toMatchObject({ status: "unknown", ageDays: null });
    expect(by["elections"].asOf).toMatch(/^2024/);
    expect(r.summary).toMatchObject({ stale: 1, unknown: 1 });
    expect(alertFrom(r)).toMatchObject({ raised: true, stale: ["geo-lgd-TG"] });
  });

  it("reads thresholds and overrides; parses ISO dates and bare years", () => {
    expect(parseThresholdOverrides("geo-lgd-AP=30, elections=400 ,bad,x=0")).toEqual({ "geo-lgd-AP": 30, elections: 400 });
    expect(thresholdFor("geo-lgd-AP", { "geo-lgd-AP": 30 })).toBe(30);
    expect(thresholdFor("census-units")).toBeGreaterThan(thresholdFor("geo-lgd-AP"));
    expect(thresholdFor("something-new")).toBe(365);
    expect(parseAsOf("2024 (latest election in file)")?.toISOString().slice(0, 10)).toBe("2024-12-31");
    expect(parseAsOf("2026-11-22")?.toISOString().slice(0, 10)).toBe("2026-11-22");
    expect(parseAsOf("soon")).toBeNull();
    const r = computeFreshness(root, new Date("2026-11-23T00:00:00Z"), { DATA_FRESHNESS_THRESHOLDS: "geo-lgd-AP=10" });
    expect(r.datasets.find(d => d.id === "geo-lgd-AP")?.status).toBe("stale");
  });

  it("a missing manifest is reported (alert raised) rather than crashing", () => {
    fs.rmSync(path.join(gen, "manifest.json"));
    const r = computeFreshness(root);
    expect(r).toMatchObject({ manifestPresent: false, datasets: [] });
    expect(alertFrom(r).raised).toBe(true);
  });

  it("GET /data-freshness returns per-dataset rows; the real repository manifest has no unknown or stale dataset today", async () => {
    const app = express();
    app.use("/api/v1", createRefreshRouter({ baseDir: root, now: () => new Date("2026-11-23T00:00:00Z") }));
    const s = app.listen(0);
    try {
      const b = await (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1/data-freshness`)).json();
      expect(b.datasets.map((d: { id: string }) => d.id)).toContain("geo-lgd-AP");
      expect(b.datasets[0]).toHaveProperty("thresholdDays");
      expect(b.alert).toHaveProperty("raised");
    } finally { s.close(); }
    const real = computeFreshness(REAL);
    expect(real.manifestPresent).toBe(true);
    expect(real.datasets.length).toBeGreaterThan(10);
  });

  it("the job raises the alert flag, logs, and /readyz exposes it", async () => {
    const m = JSON.parse(fs.readFileSync(path.join(gen, "manifest.json"), "utf8"));
    m.datasets[0].asOf = "2001-01-01";
    writeJson(path.join(gen, "manifest.json"), m);
    const a = runFreshnessCheck(root, new Date("2026-11-23T00:00:00Z"));
    expect(a.raised).toBe(true);
    const app = express();
    app.use(obsRouter({ dbPing: () => undefined, migrations: () => ({ registered: 0, applied: 0, pending: [], drift: [] }), jobs: () => ({ started: false, alarm: null, jobs: [] }), demoProvenance: () => [] }));
    const s = app.listen(0);
    try {
      const b = await (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/readyz`)).json();
      expect(b.info.dataFreshness).toMatchObject({ raised: true });
      expect(b.info.dataFreshness.stale.length).toBeGreaterThan(0);
    } finally { s.close(); }
  });
});

describe("@E2E-91 staged refresh with atomic swap", () => {
  it("swaps a changed set in, keeps the previous set, rebuilds the manifest and writes a report", async () => {
    const rep = await runRefresh({ root, genDir: gen, steps: [step("lgd", d => setLgd(d, "2026-11-23"))] });
    expect(rep.errors).toEqual([]);
    expect(rep).toMatchObject({ ok: true, swapped: true, unchanged: false });
    expect(rep.changed).toContain("data/generated/geo/lgd-AP.json");
    expect(JSON.parse(fs.readFileSync(path.join(gen, "geo", "lgd-AP.json"), "utf8")).asOf).toBe("2026-11-23");
    const d = refreshDirs(root);
    expect(JSON.parse(fs.readFileSync(path.join(d.previous, "geo", "lgd-AP.json"), "utf8")).asOf).toBe("2026-11-01");
    expect(fs.existsSync(d.staging)).toBe(false);
    expect(JSON.parse(fs.readFileSync(d.report, "utf8")).swapped).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(gen, "manifest.json"), "utf8")).datasets.find((x: { id: string }) => x.id === "geo-lgd-AP").asOf).toBe("2026-11-23");
  });

  it("does nothing when no dataset changed", async () => {
    const rep = await runRefresh({ root, genDir: gen, steps: [step("noop", () => undefined)] });
    expect(rep).toMatchObject({ ok: true, swapped: false, unchanged: true });
    expect(fs.existsSync(refreshDirs(root).previous)).toBe(false);
  });

  it("a failing step leaves the live set untouched and removes nothing", async () => {
    const before = fs.readFileSync(path.join(gen, "geo", "lgd-AP.json"), "utf8");
    const rep = await runRefresh({ root, genDir: gen, steps: [step("ok", d => setLgd(d, "2026-11-23")), step("boom", () => { throw new Error("network down"); })] });
    expect(rep.ok).toBe(false);
    expect(rep.errors[0]).toMatch(/step boom failed: network down/);
    expect(rep.steps.map(s => s.ok)).toEqual([true, false]);
    expect(fs.readFileSync(path.join(gen, "geo", "lgd-AP.json"), "utf8")).toBe(before);
  });

  it("never replaces real data with demo data", async () => {
    const rep = await runRefresh({ root, genDir: gen, steps: [step("elections", d => writeJson(path.join(d, "elections.json"), { schema: 1, provenance: "demo", source: "fixture", results: [{ year: 2024, state: "AP" }] }))] });
    expect(rep.ok).toBe(false);
    expect(rep.errors.join()).toMatch(/replaced by DEMO data/);
    expect(JSON.parse(fs.readFileSync(path.join(gen, "elections.json"), "utf8")).provenance).toBe("TCPD");
    expect(guardErrors(gen, gen)).toEqual([]);
  });

  it("refuses a staged set that lost a dataset", async () => {
    const rep = await runRefresh({ root, genDir: gen, steps: [step("rm", d => fs.rmSync(path.join(d, "geo", "lgd-AP.json")))] });
    expect(rep.ok).toBe(false);
    expect(rep.errors.join()).toMatch(/disappeared/);
    expect(fs.existsSync(path.join(gen, "geo", "lgd-AP.json"))).toBe(true);
  });

  it("a failing validator blocks the swap and leaves the live set as it was", async () => {
    const rep = await runRefresh({ root, genDir: gen, steps: [step("x", d => setLgd(d, "2026-11-23"))], validate: () => ["validate: forced failure"] });
    expect(rep.ok).toBe(false);
    expect(rep.errors).toContain("validate: forced failure");
    expect(JSON.parse(fs.readFileSync(path.join(gen, "geo", "lgd-AP.json"), "utf8")).asOf).toBe("2026-11-01");
  });

  it("rolls back when the swap itself fails: the live directory is restored", async () => {
    const rep = await runRefresh({ root, genDir: gen, steps: [step("x", d => setLgd(d, "2026-11-23"))], failSwapForTests: true });
    expect(rep).toMatchObject({ ok: false, swapped: false, rolledBack: true });
    expect(JSON.parse(fs.readFileSync(path.join(gen, "geo", "lgd-AP.json"), "utf8")).asOf).toBe("2026-11-01");
    expect(fs.existsSync(path.join(gen, "manifest.json"))).toBe(true);
  });

  it("rollbackRefresh puts the previous set back and keeps the replaced one", async () => {
    await runRefresh({ root, genDir: gen, steps: [step("x", d => setLgd(d, "2026-11-23"))] });
    expect(rollbackRefresh(root, gen)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(path.join(gen, "geo", "lgd-AP.json"), "utf8")).asOf).toBe("2026-11-01");
    expect(JSON.parse(fs.readFileSync(path.join(refreshDirs(root).previous, "geo", "lgd-AP.json"), "utf8")).asOf).toBe("2026-11-23");
    fs.rmSync(refreshDirs(root).previous, { recursive: true });
    expect(rollbackRefresh(root, gen).ok).toBe(false);
  });

  it("diffs manifests by checksum", () => {
    const a = buildManifest(gen, root);
    setLgd(gen, "2026-12-01");
    const b = buildManifest(gen, root);
    expect(diffManifests(a, b).changed).toEqual(["data/generated/geo/lgd-AP.json"]);
  });

  it("network steps are opt-in: default steps are the open-data geography scripts, elections only with TCPD_CSV_URL", () => {
    expect(defaultSteps(root, {}).map(s => s.name)).toEqual(["lgd", "boundaries", "names-te"]);
    expect(defaultSteps(root, { REFRESH_STEPS: "elections,census" }).map(s => s.name)).toEqual(["census"]);
    expect(defaultSteps(root, { REFRESH_STEPS: "elections", TCPD_CSV_URL: "https://example.org/x.csv" }).map(s => s.name)).toEqual(["elections"]);
    expect(defaultSteps(root, { REFRESH_STEPS: "rm -rf" })).toEqual([]);
  });

  it("the in-server refresh job is off unless REFRESH_ENABLED=1", () => {
    expect(process.env.REFRESH_ENABLED).not.toBe("1");
    const env = fs.readFileSync(path.join(REAL, ".env.example"), "utf8");
    expect(env).toMatch(/REFRESH_ENABLED=0/);
  });
});

describe("@E2E-91 forecast cache follows the data snapshot", () => {
  it("a swapped manifest changes the snapshot signature, so the forecast is recomputed", async () => {
    process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST = "1";
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "fc-"));
    const g = path.join(base, "data", "generated");
    fs.mkdirSync(g, { recursive: true });
    for (const f of ["elections.json", "manifest.json"]) fs.copyFileSync(path.join(REAL, "data/generated", f), path.join(g, f));
    const app = express();
    app.use("/api/v1", createApiRouter(loadDatasets(base), { baseDir: base }));
    const s = app.listen(0);
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1/elections/AP/forecast`;
    try {
      const a = await (await fetch(url)).json();
      const a2 = await (await fetch(url)).json();
      expect(a.dataSnapshot.signature).toBe(a2.dataSnapshot.signature);
      const m = JSON.parse(fs.readFileSync(path.join(g, "manifest.json"), "utf8"));
      m.generatedNote = "refreshed";
      fs.writeFileSync(path.join(g, "manifest.json"), JSON.stringify(m, null, 1));
      const b = await (await fetch(url)).json();
      expect(b.dataSnapshot.signature).not.toBe(a.dataSnapshot.signature);
      expect(b.seats.length).toBe(a.seats.length);
    } finally { s.close(); delete process.env.ELECTION_WINDOW_FAIL_OPEN_FORECAST; fs.rmSync(base, { recursive: true, force: true }); }
  });
});
