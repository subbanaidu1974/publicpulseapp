import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiRouter, loadDatasets } from "../../server/api";
import { boundaryVersionForYear, buildHistory, openHistoryDb, recordCorrection, recordRefreshRevision } from "../../server/history/store";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "history-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (root: string, rel: string, v: unknown) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), JSON.stringify(v)); };

/** A tiny synthetic data root so interval and revision behaviour is exact and independent of the real data. */
function fixture(name: string, holder: { person: string; start: string } = { person: "A One", start: "2019-06-01" }) {
  const root = path.join(tmp, name);
  const row = (party: string, candidate: string, votes: number, position: number, year = 2019) =>
    ({ state: "AP", year, type: "assembly", acNo: 7, acName: "TESTPUR", candidate, party, votes, position, validVotes: 1000, electors: 1500, provenance: "TCPD" });
  write(root, "data/generated/elections.json", { results: [row("TDP", "X", 500, 1), row("YSRCP", "Y", 380, 2), row("NOTA", "None of the Above", 20, 5), row("TDP", "X2", 450, 1, 2024)] });
  write(root, "data/generated/geo/versions.json", { sets: [{ id: "delimitation-2008", valid_from: "2008-02-19", valid_to: null }] });
  write(root, "data/reference/parties.json", { parties: [{ code: "TDP", aliases: ["TELUGU DESAM"], name: { en: "Telugu Desam Party", te: null } }] });
  write(root, "data/reference/alliances.json", { records: [{ key: "AP-2019-assembly", groups: [{ name: "Grouping A", parties: ["TDP"], kind: "pre-poll" }] }] });
  write(root, "data/reference/people/office-holders.json", { asOf: "2026-01-01", records: [{ id: "AP-cm", state: "AP", role: "Chief Minister", person: holder.person, start: holder.start, sources: ["https://example.org/a", "https://example.org/b"] }] });
  write(root, "data/reference/history/byelections.json", { records: [{ id: "AP-assembly-7-2021", state: "AP", type: "assembly", acNo: 7, seat: "TESTPUR", date: "2021", kind: "by-election", winner: "Z", party: "TDP", margin: 10, verified: true, sources: ["f.csv"] }] });
  write(root, "data/reference/history/party-switches.json", { records: [] });
  return root;
}

describe("history store build", () => {
  it("projects results with boundary version, share, NOTA and winner margin", () => {
    const root = fixture("a"), dbPath = path.join(tmp, "a.db");
    const r = buildHistory({ root, dbPath });
    expect(r.counts.elections).toBe(2);
    expect(r.counts.results).toBe(4);
    const db = openHistoryDb(dbPath, { readOnly: true });
    const win = db.prepare("SELECT * FROM results WHERE candidate = 'X'").get() as Record<string, unknown>;
    expect(win).toMatchObject({ share_pct: 50, margin: 120, party_code: "TDP", is_nota: 0 });
    expect(db.prepare("SELECT is_nota, margin FROM results WHERE party = 'NOTA'").get()).toMatchObject({ is_nota: 1, margin: null });
    expect(db.prepare("SELECT boundary_version FROM elections WHERE year = 2019").get()).toMatchObject({ boundary_version: "delimitation-2008" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM party_alliances").get()).toMatchObject({ n: 1 });
    db.close();
  });

  it("is idempotent: a second build adds no revisions and no duplicate rows", () => {
    const root = fixture("b"), dbPath = path.join(tmp, "b.db");
    const first = buildHistory({ root, dbPath });
    expect(first.revisions.length).toBeGreaterThan(0);
    const again = buildHistory({ root, dbPath });
    expect(again.revisions).toHaveLength(0);
    expect(again.counts).toEqual(first.counts);
  });

  it("records a linked revision with a diff summary when a dataset changes, and keeps history across rebuilds", () => {
    const root = fixture("c"), dbPath = path.join(tmp, "c.db");
    buildHistory({ root, dbPath, now: new Date("2026-01-01T00:00:00Z") });
    write(root, "data/reference/history/byelections.json", { records: [] });
    const r = buildHistory({ root, dbPath, trigger: "refresh", now: new Date("2026-02-01T00:00:00Z") });
    expect(r.revisions.map((x) => x.dataset)).toEqual(["history-byelections"]);
    const db = openHistoryDb(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT * FROM dataset_revisions WHERE dataset = 'history-byelections' ORDER BY id").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[1].previous_revision_id).toBe(rows[0].id);
    expect(rows[1].trigger).toBe("refresh");
    expect(JSON.parse(rows[1].diff_summary as string)).toMatchObject({ rowsBefore: 1, rowsAfter: 0, rowDelta: -1 });
    db.close();
  });

  it("dataset_revisions and manual_corrections are append-only; --reset starts clean", () => {
    const root = fixture("d"), dbPath = path.join(tmp, "d.db");
    buildHistory({ root, dbPath });
    const db = openHistoryDb(dbPath);
    expect(() => db.exec("DELETE FROM dataset_revisions")).toThrow(/append-only/);
    expect(() => db.exec("UPDATE dataset_revisions SET dataset = 'x'")).toThrow(/append-only/);
    expect(() => recordCorrection(db, { actor: "editor", table: "results", key: "k", field: "votes", reason: " " })).toThrow();
    const id = recordCorrection(db, { actor: "editor", table: "results", key: "AP-2019-assembly#7", field: "votes", oldValue: "500", newValue: "501", reason: "typo", sourceUrl: "https://example.org" });
    expect(id).toBeGreaterThan(0);
    expect(() => db.exec("DELETE FROM manual_corrections")).toThrow(/append-only/);
    db.close();
    const r = buildHistory({ root, dbPath, reset: true });
    expect(r.counts.dataset_revisions).toBe(r.revisions.length);
  });

  it("office holders keep validity intervals: a changed slot closes the old holder at the new start", () => {
    const root = fixture("e"), dbPath = path.join(tmp, "e.db");
    buildHistory({ root, dbPath });
    write(root, "data/reference/people/office-holders.json", { records: [{ id: "AP-cm", state: "AP", role: "Chief Minister", person: "B Two", start: "2024-06-12", sources: ["https://example.org/c"] }] });
    buildHistory({ root, dbPath });
    const db = openHistoryDb(dbPath, { readOnly: true });
    const all = db.prepare("SELECT person, start_date, end_date, current FROM office_holders ORDER BY start_date").all();
    expect(all).toEqual([
      { person: "A One", start_date: "2019-06-01", end_date: "2024-06-12", current: 0 },
      { person: "B Two", start_date: "2024-06-12", end_date: null, current: 1 },
    ]);
    db.close();
  });

  it("maps years to boundary versions", () => {
    const sets = [{ id: "d2008", valid_from: "2008-02-19", valid_to: "2028-12-31" }, { id: "d2029", valid_from: "2029-01-01", valid_to: null }];
    expect(boundaryVersionForYear(sets, 2024)).toBe("d2008");
    expect(boundaryVersionForYear(sets, 2034)).toBe("d2029");
    expect(boundaryVersionForYear(sets, 1999)).toBeNull();
  });

  it("refresh hook never throws, and skips when no database exists", () => {
    const root = fixture("f");
    const prev = process.env.HISTORY_DB; process.env.HISTORY_DB = path.join(tmp, "f-missing.db");
    try {
      expect(recordRefreshRevision(root, {})).toMatchObject({ ok: true, skipped: "no history database" });
      expect(recordRefreshRevision(root, { HISTORY_AUTO_RECORD: "0" })).toMatchObject({ skipped: "disabled" });
      expect(recordRefreshRevision(root, { HISTORY_AUTO_RECORD: "1" })).toMatchObject({ ok: true });
      fs.writeFileSync(process.env.HISTORY_DB, "not a database");
      expect(recordRefreshRevision(root, {}).ok).toBe(false); // failure is reported, not thrown
    } finally { if (prev === undefined) delete process.env.HISTORY_DB; else process.env.HISTORY_DB = prev; }
  });
});

describe("history API", () => {
  let server: Server, base: string, dbPath: string;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: (await r.json().catch(() => null)) as any }; };
  beforeAll(() => {
    const root = fixture("api");
    dbPath = path.join(tmp, "api.db");
    buildHistory({ root, dbPath });
    process.env.HISTORY_DB = dbPath;
    const app = express();
    app.use("/api/v1", createApiRouter(loadDatasets()));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => { server.close(); delete process.env.HISTORY_DB; });

  it("lists revisions, filtered by dataset, with cache headers (not shadowed by /history/:state)", async () => {
    const all = await get("/history/revisions");
    expect(all.status).toBe(200);
    expect(all.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(all.body.revisions.length).toBeGreaterThan(0);
    const one = await get("/history/revisions?dataset=people-office-holders");
    expect(one.body.revisions.every((r: any) => r.dataset === "people-office-holders")).toBe(true);
    expect(one.body.revisions[0]).toMatchObject({ rows: 1 });
    expect((await get("/history/datasets")).body.datasets.length).toBeGreaterThan(0);
    expect((await get("/history/revisions?limit=abc")).status).toBe(400);
    expect((await get("/history/revisions?dataset=a%20b")).body.code).toBe("bad_dataset");
  });

  it("serves a constituency across elections with boundary version, unranked beyond finishing position", async () => {
    const r = await get("/history/constituency/AP/7");
    expect(r.status).toBe(200);
    expect(r.body.elections.map((e: any) => e.year)).toEqual([2019, 2024]);
    expect(r.body.elections[0]).toMatchObject({ boundaryVersion: "delimitation-2008" });
    expect(r.body.elections[0].results[0]).toMatchObject({ candidate: "X", margin: 120, sharePct: 50 });
    expect((await get("/history/constituency/AP/999")).status).toBe(404);
    expect((await get("/history/constituency/XX/7")).status).toBe(400);
    expect((await get("/history/constituency/AP/abc")).body.code).toBe("bad_ac_no");
  });

  it("answers who held office on a date", async () => {
    expect((await get("/history/office-holders?asOf=2026-06-01&state=AP")).body.holders.map((h: any) => h.person)).toEqual(["A One"]);
    expect((await get("/history/office-holders?asOf=2019-05-31")).body.holders).toEqual([]);
    expect((await get("/history/office-holders?asOf=2026-02-30")).status).toBe(400);
  });

  it("gives seats per election for a party code", async () => {
    const r = await get("/history/party/tdp/seats-over-time?state=AP");
    expect(r.status).toBe(200);
    expect(r.body.points.map((p: any) => [p.year, p.seatsWon])).toEqual([[2019, 1], [2024, 1]]);
    expect(r.body.points[0].alliance).toBe("Grouping A");
    expect((await get("/history/party/NOPE/seats-over-time")).status).toBe(404);
  });

  it("returns 503 JSON when the store is not built", async () => {
    process.env.HISTORY_DB = path.join(tmp, "absent.db");
    const r = await get("/history/revisions");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("history_unavailable");
    process.env.HISTORY_DB = dbPath;
  });
});

describe("history store on the real data", () => {
  it("builds from the repository JSON", () => {
    const r = buildHistory({ root: process.cwd(), dbPath: path.join(tmp, "real.db") });
    expect(r.counts.results).toBeGreaterThan(10000);
    expect(r.counts.elections).toBeGreaterThan(5);
    expect(r.counts.office_holders).toBeGreaterThan(0);
  });
});
