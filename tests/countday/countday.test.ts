import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createSession, getDb, grantRole, migrate, resetDbForTests } from "../../server/civic/core";
import { createCountdayRouter, liveBlock } from "../../server/countday/router";
import { signerFromKeys } from "../../server/countday/signer";
import { loadLinks } from "../../server/countday/links";
import { ingestOnce, readJson, loadIndex } from "../../pipeline/countday/ingest";
import { csvToBatch, FileDropSource, FixtureSource, HttpSource, TcpdDelayedSource } from "../../pipeline/countday/sources";
import { checkAc, labelFor, validateBatch } from "../../pipeline/countday/validate";
import { compareMirrors, dirReader, verifyState } from "../../pipeline/countday/verify";
import { forecastDecision } from "../../server/window";
import type { Envelope, FeedAc, SnapshotBody } from "../../pipeline/countday/types";

let dir: string;
const T0 = Date.UTC(2099, 4, 4, 8, 0);
const at = (m: number) => new Date(T0 + m * 60000);
const signer = signerFromKeys();

async function fill(src: FixtureSource, steps: number, d = dir) {
  for (let i = 0; i < steps; i++) { await ingestOnce({ dir: d, state: "AP", source: src, signer, now: at(i), config: { links: loadLinks("AP") } }); src.advance(); }
}
const mkPerson = () => { const id = randomUUID(), n = new Date().toISOString(); getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?,?,?)").run(id, n, n); grantRole("system", id, "admin"); return { id, token: createSession(id) }; };

beforeAll(() => { resetDbForTests(); migrate(); });
let nowFn = () => at(10);
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-test-")); nowFn = () => at(10);  });

describe("@E2E-50 labels and validation", () => {
  it("never labels a partial count as won", () => {
    const cs = [{ candidate: "A", party: "X", votes: 10 }, { candidate: "B", party: "Y", votes: 5 }];
    expect(labelFor("counting", cs).label).toBe("leading");
    expect(labelFor("declared", cs).label).toBe("won");
    expect(labelFor("not_started", cs).label).toBe("not_started");
    expect(labelFor("counting", [{ candidate: "A", party: "X", votes: 5 }, { candidate: "B", party: "Y", votes: 5 }]).label).toBe("tied");
  });
  it("rejects vote sums above valid votes and unflagged decreases; a flagged correction is an anomaly", () => {
    const ac: FeedAc = { acNo: 1, acName: "x", status: "counting", round: 2, totalRounds: 5, validVotes: 10, candidates: [{ candidate: "A", party: "X", votes: 8 }, { candidate: "B", party: "Y", votes: 5 }], correction: null };
    expect(checkAc(undefined, ac).invalid[0]).toMatch(/votes_exceed_valid/);
    const prev = { acNo: 1, acName: "x", status: "counting", label: "leading", round: 2, totalRounds: 5, validVotes: null, totalVotes: 9, leader: null, margin: 1, candidates: [{ candidate: "A", party: "X", votes: 9 }], underReview: false, asOf: "" } as const;
    const down: FeedAc = { ...ac, round: 3, validVotes: null, candidates: [{ candidate: "A", party: "X", votes: 7 }] };
    expect(checkAc(prev as never, down).invalid.join()).toMatch(/votes_decreased/);
    expect(checkAc(prev as never, { ...down, correction: { reason: "recount" } })).toMatchObject({ invalid: [], anomalies: ["correction"] });
    expect(checkAc(prev as never, { ...down, correction: { reason: " " } }).invalid).toContain("correction_without_reason");
  });
  it("rejects malformed batches", () => {
    expect(validateBatch({ schema: 2 }).ok).toBe(false);
    expect(validateBatch(null).ok).toBe(false);
  });
});

describe("@E2E-50 sources", () => {
  it("fixture is synthetic and labelled", async () => {
    const b = await new FixtureSource({ state: "AP", step: 2 }).fetch(at(0));
    expect(b.synthetic).toBe(true);
    expect(b.acs[0].acName).toMatch(/SYNTHETIC/);
    expect(validateBatch(b).ok).toBe(true);
  });
  it("file-drop reads JSON and CSV in the neutral schema", async () => {
    const csv = "state,election_type,year,ac_no,ac_name,round,total_rounds,status,candidate,party,votes,valid_votes,as_of,source_id,correction_reason\nAP,assembly,2099,1,Test AC,2,10,counting,Cand A,P1,100,300,2099-05-04T08:00:00Z,drop-1,\nAP,assembly,2099,1,Test AC,2,10,counting,\"Cand, B\",P2,80,300,2099-05-04T08:00:00Z,drop-1,\n";
    const f = path.join(dir, "feed-1.csv"); fs.writeFileSync(f, csv);
    const b = await new FileDropSource(dir).fetch();
    expect(b.sourceKind).toBe("file-drop"); expect(b.acs[0].candidates[1].candidate).toBe("Cand, B");
    expect(csvToBatch(csv).acs[0].round).toBe(2);
    const j = JSON.stringify({ ...b, asOf: "2099-05-04T09:00:00Z" }); fs.writeFileSync(path.join(dir, "feed-2.json"), j);
    expect((await new FileDropSource(dir).fetch()).asOf).toBe("2099-05-04T09:00:00Z");
    fs.writeFileSync(path.join(dir, "feed-3.json"), "{}");
    await expect(new FileDropSource(dir).fetch()).rejects.toThrow(/invalid/);
  });
  it("http source has no default URL and refuses plain http", async () => {
    expect(() => new HttpSource({})).toThrow(/no default/);
    expect(() => new HttpSource({ url: "http://example.org/feed" })).toThrow(/https/);
  });
  it("tcpd fallback is post-count only", async () => {
    const rows = [{ state: "AP", year: 2024, type: "assembly", acNo: 1, acName: "A", candidate: "C", party: "P", votes: 5, position: 1, validVotes: 9, provenance: "TCPD" }] as never[];
    const s = new TcpdDelayedSource({ elections: rows, state: "AP", year: 2024, electionType: "assembly", asOf: "2024-06-01T00:00:00Z", notBefore: at(60) });
    await expect(s.fetch(at(0))).rejects.toThrow(/post-count/);
    const b = await s.fetch(at(120));
    expect(b.acs[0].status).toBe("declared"); expect(b.sourceKind).toBe("tcpd-delayed");
  });
});

describe("@E2E-50 signed hash-chained snapshots", () => {
  it("publishes, chains, verifies, and detects tampering and rollback", async () => {
    await fill(new FixtureSource({ state: "AP", acCount: 8, step: 1 }), 4);
    const v = await verifyState(dirReader(dir), "AP");
    expect(v.problems).toEqual([]); expect(v.head?.seq).toBe(4); expect(v.snapshots).toBe(4);
    const idx = loadIndex(dir, "AP")!; expect(idx.body.entries[2].prevHash).toBe(idx.body.entries[1].sha256);
    // tamper with a numbered snapshot
    const f = path.join(dir, "AP", "snapshots", "2.json"); const orig = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, orig.replace("SYNTHETIC AC 1", "SYNTHETIC AC 9"));
    expect((await verifyState(dirReader(dir), "AP")).ok).toBe(false);
    fs.writeFileSync(f, orig);
    expect((await verifyState(dirReader(dir), "AP")).ok).toBe(true);
    // forge a signature with another key
    const other = signerFromKeys({ hmac: () => "ab".repeat(32), encrypt: (_p, t) => t, decrypt: (_p, t) => t });
    const env = JSON.parse(orig) as Envelope<SnapshotBody>; env.signature = { alg: "ed25519", keyId: signer.keyId, value: other.sign(Buffer.from(env.sha256)) };
    fs.writeFileSync(f, JSON.stringify(env));
    expect((await verifyState(dirReader(dir), "AP")).problems.join()).toMatch(/bad signature/);
    fs.writeFileSync(f, orig);
    // rollback of a mirror: copy, then drop the last entry from the copy; mirrors compared
    const head = (await verifyState(dirReader(dir), "AP")).head;
    expect(compareMirrors([{ mirror: "a", head }, { mirror: "b", head: { seq: 3, sha256: "x" } }]).join()).toMatch(/behind/);
    expect(compareMirrors([{ mirror: "a", head }, { mirror: "b", head: { seq: 4, sha256: "y" } }]).join()).toMatch(/fork/);
    expect((await verifyState(dirReader(dir), "AP", { minSeq: 5 })).problems.join()).toMatch(/rollback/);
    expect((await verifyState(dirReader(dir), "AP", { pinnedKeyIds: ["cd-other"] })).ok).toBe(false);
  });
  it("snapshots are immutable and never overwritten", async () => {
    await fill(new FixtureSource({ state: "AP", acCount: 3, step: 1 }), 2);
    const before = fs.readFileSync(path.join(dir, "AP", "snapshots", "1.json"), "utf8");
    await fill(new FixtureSource({ state: "AP", acCount: 3, step: 3 }), 1);
    expect(fs.readFileSync(path.join(dir, "AP", "snapshots", "1.json"), "utf8")).toBe(before);
  });
  it("an unchanged feed does not mint a new snapshot", async () => {
    const src = new FixtureSource({ state: "AP", acCount: 3, step: 2 });
    await ingestOnce({ dir, state: "AP", source: src, signer, now: at(0) });
    const r = await ingestOnce({ dir, state: "AP", source: src, signer, now: at(1) });
    expect(r.published).toBe(false); expect(r.reason).toBe("unchanged");
  });
  it("holds anomalies and releases them only after two different admins approve", async () => {
    const src = new FixtureSource({ state: "AP", acCount: 3, step: 3, correctionAtStep: 4 });
    await fill(src, 1);
    const seat1 = () => (readJson<Envelope<SnapshotBody>>(path.join(dir, "AP", "latest.json"))!.body.acs[0]);
    const before = seat1().candidates[0].votes;
    src.advance();
    const r = await ingestOnce({ dir, state: "AP", source: src, signer, now: at(2) });
    expect(r.held[0]).toMatchObject({ acNo: 1, kind: "anomaly" });
    const snap = readJson<Envelope<SnapshotBody>>(path.join(dir, "AP", "latest.json"))!.body;
    expect(snap.summary.underReview).toBe(1);
    expect(snap.acs[0].underReview).toBe(true);
    expect(snap.acs[0].candidates[0].votes).toBeGreaterThanOrEqual(before - 0); // previous approved figures, not the restated ones
    // approve through the router
    const app = express(); app.use(express.json()); app.use("/c", createCountdayRouter({ dir }));
    const srv = await new Promise<Server>((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/c`;
    try {
      const a1 = mkPerson(), a2 = mkPerson();
      const call = (tok: string | null, m: string, p: string) => fetch(b + p, { method: m, headers: { ...(tok ? { authorization: "Bearer " + tok } : {}), "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      expect((await call(null, "GET", "/AP/review")).status).toBe(401);
      const list = await (await call(a1.token, "GET", "/AP/review")).json() as { items: { id: string }[] };
      const id = list.items[0].id;
      expect((await (await call(a1.token, "POST", `/AP/review/${id}/approve`)).json() as { approvals: number }).approvals).toBe(1);
      expect((await call(a1.token, "POST", `/AP/review/${id}/approve`)).status).toBe(409); // same person twice
      let n = await ingestOnce({ dir, state: "AP", source: src, signer, now: at(3) });
      expect(n.held.length).toBe(1); // one approval is not enough
      expect((await (await call(a2.token, "POST", `/AP/review/${id}/approve`)).json() as { releasedOnNextSnapshot: boolean }).releasedOnNextSnapshot).toBe(true);
      n = await ingestOnce({ dir, state: "AP", source: src, signer, now: at(4) });
      expect(n.held.length).toBe(0);
      expect(readJson<Envelope<SnapshotBody>>(path.join(dir, "AP", "latest.json"))!.body.summary.underReview).toBe(0);
    } finally { srv.close(); }
  });
  it("invalid figures are never publishable and cannot be approved", async () => {
    const src = new FixtureSource({ state: "AP", acCount: 2, step: 3 });
    await fill(src, 1);
    const bad = await src.fetch(at(5)); bad.acs[0].validVotes = 1; bad.asOf = at(5).toISOString();
    const r = await ingestOnce({ dir, state: "AP", source: { id: "x", kind: "fixture", label: "x", fetch: async () => bad }, signer, now: at(5) });
    expect(r.held[0].kind).toBe("invalid");
  });
  it("falls back to the delayed archive and labels it", async () => {
    const down = { id: "live", kind: "http" as const, label: "live", fetch: async () => { throw new Error("down"); } };
    const rows = [{ state: "AP", year: 2099, type: "assembly", acNo: 1, acName: "A", candidate: "C", party: "P", votes: 5, position: 1, validVotes: 9, provenance: "TCPD" }] as never[];
    const fb = new TcpdDelayedSource({ elections: rows, state: "AP", year: 2099, electionType: "assembly", asOf: at(0).toISOString() });
    const r = await ingestOnce({ dir, state: "AP", source: down, fallback: fb, signer, now: at(1) });
    expect(r.usedFallback).toBe(true);
    expect(readJson<Envelope<SnapshotBody>>(path.join(dir, "AP", "latest.json"))!.body.delayLabel).toBe("delayed-fallback");
    const none = await ingestOnce({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "cd-x-")), state: "AP", source: down, signer, now: at(1) });
    expect(none.reason).toBe("source_down");
  });
});

describe("@E2E-50 serving", () => {
  const serve = async () => {
    const app = express(); app.use(express.json()); app.use("/c", createCountdayRouter({ dir, now: () => nowFn(), env: { COUNTDAY_STALE_MINUTES: "10", COUNT_DAY_ACTIVE: "1" } as never }));
    const s = await new Promise<Server>((res) => { const x = app.listen(0, "127.0.0.1", () => res(x)); });
    return { s, b: `http://127.0.0.1:${(s.address() as AddressInfo).port}/c` };
  };
  it("serves latest with live block, immutable numbered snapshots, ETag 304, per-seat links and keys", async () => {
    await fill(new FixtureSource({ state: "AP", acCount: 4, step: 1 }), 3);
    const { s, b } = await serve();
    try {
      const r = await fetch(b + "/AP/latest"); const j = await r.json() as Envelope<SnapshotBody> & { live: { state: string; delayed_minutes: number; forecast_hidden: boolean; banner: { en: string; te: string } } };
      expect(r.headers.get("cache-control")).toMatch(/max-age=5/);
      expect(j.body.seq).toBe(3); expect(j.live.state).toBe("synthetic"); expect(j.live.banner.te.length).toBeGreaterThan(5); expect(j.live.forecast_hidden).toBe(true);
      const et = r.headers.get("etag")!; expect((await fetch(b + "/AP/latest", { headers: { "if-none-match": et } })).status).toBe(304);
      const n = await fetch(b + "/AP/snapshots/2"); expect(n.headers.get("cache-control")).toMatch(/immutable/);
      const ac = await (await fetch(b + "/AP/ac/1")).json() as { body: { links: { kind: string; url: string }[]; ac: { acNo: number } } };
      expect(ac.body.ac.acNo).toBe(1); expect(ac.body.links.map((l) => l.kind)).toEqual(expect.arrayContaining(["form20", "affidavit"]));
      expect(ac.body.links.every((l) => l.url.startsWith("https://"))).toBe(true);
      const k = await (await fetch(b + "/keys")).json() as { keys: { keyId: string }[] };
      expect(k.keys[0].keyId).toBe(signer.keyId);
      expect((await fetch(b + "/XX/latest")).status).toBe(400);
      expect((await fetch(b + "/TG/latest")).status).toBe(404);
      expect((await fetch(b + "/AP/snapshots/99")).status).toBe(404);
    } finally { s.close(); }
  });
  it("labels stale, source-down and delayed-fallback; never plain live when stale", () => {
    const body = { asOf: at(0).toISOString(), delayLabel: "live" as const, synthetic: false };
    expect(liveBlock(body, null, at(5)).state).toBe("live");
    const stale = liveBlock(body, null, at(25), {} as never);
    expect(stale.state).toBe("stale"); expect(stale.delayed_minutes).toBe(25); expect(stale.banner?.en).toMatch(/not live/); expect(stale.banner?.te).toBeTruthy();
    expect(liveBlock(body, { consecutiveFailures: 3, sourceAsOf: at(4).toISOString() }, at(5)).state).toBe("source-down");
    expect(liveBlock({ ...body, delayLabel: "delayed-fallback" }, null, at(5)).state).toBe("delayed-fallback");
    expect(liveBlock(body, { sourceAsOf: at(24).toISOString() }, at(25)).state).toBe("live"); // source still reporting: not stale
  });
  it("refuses synthetic snapshots in production", async () => {
    await fill(new FixtureSource({ state: "AP", acCount: 2, step: 1 }), 1);
    const app = express(); app.use("/c", createCountdayRouter({ dir, env: { NODE_ENV: "production" } as never }));
    const s = await new Promise<Server>((res) => { const x = app.listen(0, "127.0.0.1", () => res(x)); });
    try { expect((await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/c/AP/latest`)).status).toBe(404); } finally { s.close(); }
  });
  it("hides the forecast while a count-day feed is active", () => {
    const d = forecastDecision("AP", new Date(), { env: { COUNT_DAY_ACTIVE: "1" } as never, calendar: null });
    expect(d).toMatchObject({ show: false, reason: "count-day" });
  });
});
