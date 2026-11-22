import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import {
  HttpWitnessAnchorSink, anchorAuditHead, anchorStatus, audit, auditHead, auditPublicEntries, canonicalJson, getAnchorSink, getDb, getStore, migrate, resetDbForTests,
  setAnchorSink, verifyAuditChain,
} from "../../server/civic/core";
import { auditRouter } from "../../server/civic/admin/routes";

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/audit", auditRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/audit`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); });

const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as Record<string, any> }; };
const sleepTick = () => new Promise((r) => setTimeout(r, 20));

/** A fake witness: records POSTs, can fail the first N, and serves its latest anchor on GET. */
function fakeWitness(failFirst = 0, secret = "s3") {
  const received: { body: any; sig: string; stamp: string }[] = [];
  let calls = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    if (init.method === "GET") {
      const last = received.at(-1)?.body;
      return new Response(JSON.stringify(last ?? {}), { status: last ? 200 : 404 });
    }
    calls++;
    if (calls <= failFirst) return new Response("nope", { status: 503 });
    const h = init.headers as Record<string, string>;
    const expect = "sha256=" + crypto.createHmac("sha256", secret).update(h["x-civic-timestamp"] + "." + String(init.body)).digest("hex");
    if (h["x-civic-signature"] !== expect) return new Response("bad sig", { status: 401 });
    received.push({ body: JSON.parse(String(init.body)), sig: h["x-civic-signature"], stamp: h["x-civic-timestamp"] });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, received, calls: () => calls };
}

describe("public audit views (S-144)", () => {
  it("@E2E-159 /audit/head exposes the latest hash, count and anchor info; /audit/entries is redacted", async () => {
    audit("person-secret-1", "household_invite_sent", "invite-abc", { phone: "do-not-leak" });
    audit("person-secret-2", "role.grant", "person:xyz", { role: "admin" });
    const head = await get("/head");
    const h = auditHead()!;
    expect(head.body.head.hash).toBe(h.hash);
    expect(head.body.count).toBe(2);
    expect(head.body.anchor).toMatchObject({ sink: "none", configured: false });
    const e = await get("/entries?from=1");
    const text = JSON.stringify(e.body);
    for (const leak of ["person-secret", "invite-abc", "do-not-leak", "xyz", "admin"]) expect(text).not.toContain(leak);
    expect(e.body.entries.map((x: any) => x.class)).toEqual(["household", "role"]);
    expect(e.body.entries[0].hour).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/);
    expect(e.body.entries[1].prev_hash).toBe(e.body.entries[0].hash);
    for (let i = 0; i < 5; i++) audit("a", "x.y", "o");
    const page = auditPublicEntries(1, 3);
    expect(page.entries).toHaveLength(3); expect(page.next_from).toBe(4);
    expect((await get("/entries?from=4&limit=500")).body.next_from).toBeNull();
  });
});

describe("anchor sinks (S-144)", () => {
  it("@E2E-159 the HTTP witness POSTs a signed head, retries on failure and records acknowledgement", async () => {
    const w = fakeWitness(2);
    const sink = new HttpWitnessAnchorSink("http://witness.test/anchor", "s3", { fetchFn: w.fetchFn, baseDelayMs: 1, retries: 4 });
    setAnchorSink(sink);
    audit("a", "step", "o");
    const rec = anchorAuditHead()!;
    await sleepTick(); await sleepTick();
    expect(w.calls()).toBe(3); // two 503s, then accepted
    expect(w.received[0].body).toEqual({ seq: rec.seq, hash: rec.hash, ts: rec.ts });
    expect(sink.list()).toEqual([{ seq: rec.seq, hash: rec.hash, ts: rec.ts }]);
    expect(sink.pendingCount()).toBe(0);
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-159 undeliverable anchors stay pending and are re-sent later; a forged signature is rejected by the witness", async () => {
    const dead = fakeWitness(99);
    const sink = new HttpWitnessAnchorSink("http://witness.test/anchor", "s3", { fetchFn: dead.fetchFn, baseDelayMs: 1, retries: 2 });
    setAnchorSink(sink);
    audit("a", "step", "o");
    anchorAuditHead();
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.list()).toEqual([]);
    expect(sink.pendingCount()).toBe(1);
    const alive = fakeWitness(0);
    const sink2 = new HttpWitnessAnchorSink("http://witness.test/anchor", "s3", { fetchFn: alive.fetchFn, baseDelayMs: 1 });
    setAnchorSink(sink2);
    expect(await sink2.retryPending()).toBe(1);
    expect(sink2.list()).toHaveLength(1);
    const wrong = new HttpWitnessAnchorSink("http://witness.test/anchor", "other-secret", { fetchFn: alive.fetchFn, baseDelayMs: 1, retries: 1 });
    expect(await wrong.deliver({ seq: 1, hash: "x", ts: "t" })).toBe(false);
  });

  it("@E2E-159 CIVIC_ANCHOR_URL selects the HTTP witness", () => {
    process.env.CIVIC_ANCHOR_URL = "http://witness.test/a";
    try { setAnchorSink(null); expect(getAnchorSink().kind).toBe("http"); } finally { delete process.env.CIVIC_ANCHOR_URL; setAnchorSink(null); }
  });

  it("@E2E-159 tamper detection against the anchor: a rewritten chain is caught locally and by the witness copy via /audit/verify", async () => {
    const w = fakeWitness();
    setAnchorSink(new HttpWitnessAnchorSink("http://witness.test/anchor", "s3", { fetchFn: w.fetchFn, baseDelayMs: 1 }));
    for (let i = 0; i < 4; i++) audit("a", "step", "obj:" + i);
    anchorAuditHead();
    await sleepTick();
    expect(anchorStatus()).toMatchObject({ sink: "http", anchor_matches_chain: true, unanchored_entries: 0, chain_ok: true });
    const ok = await get("/verify");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, witness: { reachable: true, matches_local: true } });
    // Attacker with DB access and the audit key rewrites entry 3 AND recomputes the rest of the chain so it is internally consistent...
    const d = getStore("audit");
    const rows = d.prepare("SELECT * FROM audit_log ORDER BY seq").all() as any[];
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    let prev = rows[1].hash;
    for (const r of rows.slice(2)) {
      const meta = r.seq === 3 ? "{\"forged\":true}" : r.meta;
      const metaD = r.seq === 3 ? (await import("../../server/civic/core")).getKeys().hmac("audit", meta) : r.meta_d;
      const hash = sha(prev + canonicalJson({ seq: r.seq, ts: r.ts, action: r.action, actor_d: r.actor_d, object_d: r.object_d, meta_d: metaD }));
      d.prepare("UPDATE audit_log SET meta = ?, meta_d = ?, prev_hash = ?, hash = ? WHERE seq = ?").run(meta, metaD, prev, hash, r.seq);
      prev = hash;
    }
    // internally consistent, but the anchored hash no longer matches
    expect(verifyAuditChain()).toMatchObject({ ok: false, anchorMismatch: 4 });
    const st = anchorStatus();
    expect(st.anchor_matches_chain).toBe(false);
    const bad = await get("/verify");
    expect(bad.status).toBe(409);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.witness.matches_local).toBe(false);
  });

  it("@E2E-159 verify reports an unreachable witness without failing the local checks", async () => {
    const down = { fetchFn: (async () => { throw new Error("offline"); }) as unknown as typeof fetch };
    setAnchorSink(new HttpWitnessAnchorSink("http://witness.test/anchor", "s3", { fetchFn: down.fetchFn, baseDelayMs: 1, retries: 1 }));
    audit("a", "step", "o");
    const v = await get("/verify");
    expect(v.body.witness).toEqual({ reachable: false });
    expect(v.body.chain_ok).toBe(true);
  });
});
