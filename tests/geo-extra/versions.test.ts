import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGeoApiRouter } from "../../server/geo-api";
import { AcLink, type AcLinkRow } from "../../pipeline/geo/link";
import { buildCurrentRegistry, dryRunCandidate, loadRegistry, selectSet, sha256Of, validateRegistry, VersionError, type BoundarySet, type CandidateBundle, type VersionRegistry } from "../../pipeline/geo/versions";

const GEO = path.join(process.cwd(), "data", "generated", "geo");
const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "pipeline/fixtures/geo/delimitation-2029-TEST-ONLY.json"), "utf8")) as CandidateBundle;

const set2008: BoundarySet = {
  id: "delimitation-2008", label: "2008", valid_from: "2008-02-19", valid_to: "2029-06-01", source: "ECI 2008",
  seats: { AP: { assembly: 175, ls: 25 } }, files: { ac: { AP: "ac-AP.geojson" } }, checksums: {},
};
const set2029: BoundarySet = {
  id: "delimitation-2029", label: "hypothetical (unit test)", valid_from: "2029-06-01", valid_to: null, source: "unit test",
  seats: { AP: { assembly: 6, ls: 2 } }, files: { ac: { AP: "v2029/ac-AP.geojson" } }, checksums: {},
};
const reg: VersionRegistry = { schema: 1, asOf: "2029-06-02", note: "", sets: [set2008, set2029] };

describe("@E2E-107 boundary version selection", () => {
  it("resolves two versions correctly by date (end exclusive) and by id; default is the set in force", () => {
    expect(selectSet(reg, { asOf: "2024-06-04" }).id).toBe("delimitation-2008");
    expect(selectSet(reg, { asOf: "2029-05-31" }).id).toBe("delimitation-2008");
    expect(selectSet(reg, { asOf: "2029-06-01" }).id).toBe("delimitation-2029");
    expect(selectSet(reg, { version: "delimitation-2008" }).id).toBe("delimitation-2008");
    expect(selectSet(reg, {}, "2026-11-23").id).toBe("delimitation-2008");
    expect(selectSet(reg, {}, "2030-01-01").id).toBe("delimitation-2029");
  });

  it("never silently mixes: id and date that disagree, bad input, unknown id and uncovered dates all fail loudly", () => {
    const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof VersionError ? e.code : "other"; } };
    expect(code(() => selectSet(reg, { version: "delimitation-2008", asOf: "2030-01-01" }))).toBe("version_mismatch");
    expect(code(() => selectSet(reg, { version: "delimitation-2008", asOf: "2020-01-01" }))).toBe("none");
    expect(code(() => selectSet(reg, { asOf: "2001-01-01" }))).toBe("no_set_for_date");
    expect(code(() => selectSet(reg, { asOf: "2020-13-45" }))).toBe("invalid_asof");
    expect(code(() => selectSet(reg, { version: "../etc" }))).toBe("invalid_version");
    expect(code(() => selectSet(reg, { version: "delimitation-1999" }))).toBe("unknown_version");
  });

  it("test-only sets are never selectable", () => {
    const r2: VersionRegistry = { ...reg, sets: [...reg.sets, { ...fixture.set, valid_from: "2040-01-01" }] };
    expect(() => selectSet(r2, { version: "delimitation-2029-test" })).toThrow(VersionError);
    expect(selectSet(r2, { asOf: "2050-01-01" }).id).toBe("delimitation-2029");
  });
});

describe("@E2E-107 effective-dated AC <-> district <-> PC lookups", () => {
  const row = (set: string | undefined, acNo: number, pcNo: number, d: string, from: string, to: string | null): AcLinkRow => ({
    state: "AP", acNo, eci: acNo, lgd: `L${set ?? "08"}${acNo}`, name: `AC${acNo}`, pcNo, reservation: null, validFrom: from, validTo: to, datesInferred: true, ...(set ? { set } : {}), districtLgd: d,
  });
  // legacy rows carry no set (= 2008); the 2029 set re-draws AC 1 into another PC and district
  const link = new AcLink([
    row(undefined, 1, 1, "D1", "2008-02-19", "2029-06-01"), row(undefined, 2, 1, "D1", "2008-02-19", "2029-06-01"), row(undefined, 3, 2, "D2", "2008-02-19", "2029-06-01"),
    row("delimitation-2029", 1, 2, "D2", "2029-06-01", null), row("delimitation-2029", 2, 1, "D1", "2029-06-01", null),
  ]).withRegistry(reg);

  it("returns each version's own PC and district for the same AC number", () => {
    expect(link.pcOf("AP", 1, { asOf: "2028-01-01" })).toBe(1);
    expect(link.districtOf("AP", 1, { asOf: "2028-01-01" })).toBe("D1");
    expect(link.pcOf("AP", 1, { version: "delimitation-2029" })).toBe(2);
    expect(link.districtOf("AP", 1, { asOf: "2029-06-01" })).toBe("D2");
    expect(link.acsOfPc("AP", 1, { asOf: "2028-01-01" })).toEqual([1, 2]);
    expect(link.acsOfPc("AP", 1, { version: "delimitation-2029" })).toEqual([2]);
    expect(link.acsOfDistrict("AP", "D2", { asOf: "2028-01-01" })).toEqual([3]);
    expect(link.acsOfDistrict("AP", "D2", { version: "delimitation-2029" })).toEqual([1]);
  });
  it("an AC that exists only in an older set is absent from the newer set (no fall-through)", () => {
    expect(link.rowIn("AP", 3, { asOf: "2028-01-01" })).not.toBeNull();
    expect(link.rowIn("AP", 3, { version: "delimitation-2029" })).toBeNull();
  });
  it("the existing byAcNo effective-date lookup is unchanged", () => {
    expect(link.byAcNo("AP", 3, "2028-01-01")?.pcNo).toBe(2);
  });
  it("without a registry only the legacy 2008 set exists", () => {
    const solo = new AcLink([row(undefined, 1, 1, "D1", "2008-02-19", null)]);
    expect(solo.pcOf("AP", 1)).toBe(1);
    expect(() => solo.pcOf("AP", 1, { version: "delimitation-2029" })).toThrow(VersionError);
  });
  it("the real ac-link.json resolves AC 1 of AP in the 2008 set with a district", () => {
    const real = AcLink.load(path.join(GEO, "ac-link.json")).withDistricts(JSON.parse(fs.readFileSync(path.join(GEO, "ac-units.json"), "utf8")).units).withRegistry(loadRegistry(GEO));
    expect(real.pcOf("AP", 1, { asOf: "2024-06-04" })).toBe(2);
    expect(real.districtOf("AP", 1)).toBeTruthy();
    expect(real.acsOfPc("AP", 2).length).toBeGreaterThan(3);
  });
});

describe("@E2E-107 registry and delimitation dry run", () => {
  it("the shipped registry is valid, current and its checksums match the files", () => {
    const r = loadRegistry(GEO)!;
    expect(validateRegistry(r, GEO)).toEqual([]);
    expect(r.sets.map(s => s.id)).toEqual(["delimitation-2008"]);
    expect(r.sets[0]).toMatchObject({ valid_from: "2008-02-19", valid_to: null });
    expect(r.sets[0].checksums["ac-AP.geojson"]).toBe(sha256Of(path.join(GEO, "ac-AP.geojson")));
  });
  it("detects overlaps, gaps, a missing open end and checksum drift", () => {
    expect(validateRegistry({ ...reg, sets: [{ ...set2008, valid_to: "2030-01-01" }, set2029] }).join()).toMatch(/overlap/);
    expect(validateRegistry({ ...reg, sets: [{ ...set2008, valid_to: "2028-01-01" }, set2029] }).join()).toMatch(/gap/);
    expect(validateRegistry({ ...reg, sets: [set2008, { ...set2029, valid_to: "2040-01-01" }] }).join()).toMatch(/open ended/);
    const drift = buildCurrentRegistry(GEO);
    drift.sets[0].checksums["ac-AP.geojson"] = "0".repeat(64);
    expect(validateRegistry(drift, GEO).join()).toMatch(/checksum mismatch/);
  });
  it("dry-runs the TEST ONLY 2029 fixture: structurally valid, planned, never installable", () => {
    const live = loadRegistry(GEO)!;
    const r = dryRunCandidate(live, fixture, "2026-11-23");
    expect(fixture.set.testOnly).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.installable).toBe(false);
    expect(r.plan.join("\n")).toMatch(/close delimitation-2008: valid_to null -> 2029-06-01/);
    expect(r.warnings.join()).toMatch(/TEST ONLY/);
  });
  it("rejects a candidate that mixes versions, miscounts seats or leaves an AC without a PC", () => {
    const live = loadRegistry(GEO)!;
    const mixed: CandidateBundle = { ...fixture, rows: fixture.rows.map((r, i) => (i === 0 ? { ...r, set: "delimitation-2008" } : r)) };
    expect(dryRunCandidate(live, mixed).errors.join()).toMatch(/mixed versions/);
    const short: CandidateBundle = { ...fixture, rows: fixture.rows.slice(1) };
    expect(dryRunCandidate(live, short).errors.join()).toMatch(/seats linked|missing/);
    const nopc: CandidateBundle = { ...fixture, rows: fixture.rows.map((r, i) => (i === 0 ? { ...r, pcNo: null } : r)) };
    expect(dryRunCandidate(live, nopc).errors.join()).toMatch(/no parliamentary/);
    const early: CandidateBundle = { ...fixture, set: { ...fixture.set, valid_from: "2001-01-01" } };
    expect(dryRunCandidate(live, early).errors.join()).toMatch(/must be after/);
    const dup: CandidateBundle = { ...fixture, set: { ...fixture.set, id: "delimitation-2008" } };
    expect(dryRunCandidate(live, dup).errors.join()).toMatch(/already exists/);
  });
  it("npm run geo:version:check passes on the repository and its fixture dry run", () => {
    const out = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/geo-version-check.ts", "--fixture"], { encoding: "utf8" });
    expect(out).toMatch(/registry ok/);
    expect(out).toMatch(/NOT installable \(test fixture\)/);
  });
});

describe("@E2E-107 ?version= and ?asOf= on boundary routes", () => {
  let server: Server, base: string, tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ver-"));
    const geo = path.join(tmp, "data", "generated", "geo");
    fs.mkdirSync(path.join(geo, "v2029"), { recursive: true });
    const fc = (n: number) => JSON.stringify({ type: "FeatureCollection", features: Array.from({ length: n }, (_, i) => ({ type: "Feature", properties: { acNo: i + 1 }, geometry: null })) });
    fs.writeFileSync(path.join(geo, "ac-AP.geojson"), fc(3));
    fs.writeFileSync(path.join(geo, "v2029", "ac-AP.geojson"), fc(5));
    fs.writeFileSync(path.join(geo, "versions.json"), JSON.stringify({ ...reg, sets: [{ ...set2008, valid_to: "2029-06-01" }, set2029] }));
    const app = express();
    app.use("/api/v1", createGeoApiRouter({ elections: [], census: [], demo: false, status: [] } as never, { baseDir: tmp }));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, version: r.headers.get("x-boundary-version"), body: await r.json().catch(() => null) }; };

  it("defaults to the set in force today and says which one it served", async () => {
    const r = await get("/geo/AP/ac.geojson");
    expect(r.status).toBe(200);
    expect(r.version).toBe("delimitation-2008");
    expect(r.body.features).toHaveLength(3);
  });
  it("serves each version's own file by id or by date", async () => {
    expect((await get("/geo/AP/ac.geojson?version=delimitation-2029")).body.features).toHaveLength(5);
    expect((await get("/geo/AP/ac.geojson?asOf=2029-06-01")).body.features).toHaveLength(5);
    const old = await get("/geo/AP/ac.geojson?asOf=2024-06-04");
    expect(old.body.features).toHaveLength(3);
    expect(old.version).toBe("delimitation-2008");
  });
  it("rejects conflicts, bad input and unknown sets; a set without that kind of file is a 404", async () => {
    expect((await get("/geo/AP/ac.geojson?version=delimitation-2008&asOf=2030-01-01")).body.code).toBe("version_mismatch");
    expect((await get("/geo/AP/ac.geojson?asOf=yesterday")).status).toBe(400);
    expect((await get("/geo/AP/ac.geojson?version=delimitation-1999")).status).toBe(404);
    expect((await get("/geo/AP/pc.geojson?version=delimitation-2029")).body.code).toBe("no_data");
  });
});
