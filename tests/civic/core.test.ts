import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FileAnchorSink, anchorAuditHead, audit, auditPrivilegedRead, createSession, getDb, getKeys, getSms, migrate, registerMigration,
  requireAuth, resetDbForTests, setAnchorSink, smsOutbox, DevKeyProvider, verifyAuditChain, recordConsent, redactAuditFor, getStore } from "../../server/civic/core";

beforeEach(() => { resetDbForTests(); migrate(); });

describe("core: db and migrations", () => {
  it("migrate() is idempotent and registerMigration runs once per id", () => {
    registerMigration("core_test_001", "CREATE TABLE core_test (x INTEGER)");
    registerMigration("core_test_001", "CREATE TABLE core_test (x INTEGER)");
    migrate(); migrate();
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM migrations WHERE id = 'core_test_001'").get()).toEqual({ c: 1 });
    resetDbForTests(); migrate(); migrate(); // fresh memory db re-applies
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM core_test").get()).toEqual({ c: 0 });
  });
});

describe("core: keys and sms", () => {
  it("HMAC is deterministic per purpose, AES-GCM round-trips and rejects wrong purpose/tamper", () => {
    const k = getKeys();
    expect(k.hmac("phone", "x")).toBe(k.hmac("phone", "x"));
    expect(k.hmac("phone", "x")).not.toBe(k.hmac("other", "x"));
    const c = k.encrypt("phone", "+919876543210");
    expect(c).not.toContain("9876543210");
    expect(k.decrypt("phone", c)).toBe("+919876543210");
    expect(() => k.decrypt("other", c)).toThrow();
    expect(() => k.decrypt("phone", c.slice(0, -2) + "AA")).toThrow();
    expect(new DevKeyProvider("another-master").hmac("phone", "x")).not.toBe(k.hmac("phone", "x"));
  });
  it("production requires a master key and refuses the dev SMS provider", async () => {
    const env = { n: process.env.NODE_ENV, k: process.env.CIVIC_DEV_MASTER_KEY };
    try {
      delete process.env.CIVIC_DEV_MASTER_KEY;
      process.env.NODE_ENV = "production";
      expect(() => new DevKeyProvider()).toThrow();
      resetDbForTests();
      expect(() => getSms()).toThrow();
    } finally { process.env.NODE_ENV = env.n; if (env.k !== undefined) process.env.CIVIC_DEV_MASTER_KEY = env.k; }
  });
  it("dev SMS goes to the in-memory outbox", async () => {
    await getSms().send("+919876543210", "hello");
    expect(smsOutbox.at(-1)).toMatchObject({ to: "+919876543210", text: "hello" });
  });
});

describe("core: auth", () => {
  it("requireAuth returns JSON 401 without a valid bearer token and sets req.person with one", () => {
    getDb().prepare("INSERT INTO persons (id, tier, created_at, eligible_from) VALUES ('p1','T1','2026-01-01','2026-01-15')").run();
    const token = createSession("p1");
    const run = (auth?: string) => {
      let status = 200, body: unknown, nexted = false;
      const req = { headers: auth ? { authorization: auth } : {} } as never as import("express").Request;
      const res = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } } as never as import("express").Response;
      requireAuth(req, res, () => { nexted = true; });
      return { status, body, nexted, person: req.person };
    };
    expect(run()).toMatchObject({ status: 401, nexted: false });
    expect(run("Bearer nope")).toMatchObject({ status: 401 });
    expect(run("Bearer " + token)).toMatchObject({ nexted: true, person: { id: "p1", tier: "T1" } });
  });
});

describe("core: audit log (S-42)", () => {
  it("@E2E-51 tampering with an entry breaks chain verification; deleting rows too", () => {
    audit("a", "x.one", "obj:1", { n: 1 }); audit("b", "x.two", "obj:2", { n: 2 }); audit("c", "x.three", "obj:3");
    expect(verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
    getStore("audit").prepare("UPDATE audit_log SET meta = '{\"n\":99}' WHERE seq = 2").run();
    expect(verifyAuditChain()).toMatchObject({ ok: false, brokenAt: 2 });
    resetDbForTests(); migrate();
    audit("a", "x.one", "obj:1"); audit("b", "x.two", "obj:2"); audit("c", "x.three", "obj:3");
    getStore("audit").prepare("UPDATE audit_log SET action = 'x.changed' WHERE seq = 2").run();
    expect(verifyAuditChain().ok).toBe(false);
    resetDbForTests(); migrate();
    audit("a", "x.one", "obj:1"); audit("b", "x.two", "obj:2"); audit("c", "x.three", "obj:3");
    getStore("audit").prepare("DELETE FROM audit_log WHERE seq = 2").run();
    expect(verifyAuditChain()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it("@E2E-51 a privileged read is itself logged", () => {
    auditPrivilegedRead("officer-7", "person:abc", "grievance review");
    const row = getStore("audit").prepare("SELECT actor, action, object, meta FROM audit_log WHERE action = 'read.sensitive'").get() as { actor: string; object: string; meta: string };
    expect(row.actor).toBe("officer-7");
    expect(row.object).toBe("person:abc");
    expect(JSON.parse(row.meta)).toEqual({ purpose: "grievance review" });
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-51 an external anchor detects truncation that leaves the chain internally valid", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "civic-anchor-"));
    setAnchorSink(new FileAnchorSink(path.join(dir, "anchors.jsonl")));
    for (let i = 0; i < 4; i++) audit("a", "step", "obj:" + i);
    const rec = anchorAuditHead();
    expect(rec!.seq).toBe(4);
    expect(verifyAuditChain().ok).toBe(true);
    getStore("audit").prepare("DELETE FROM audit_log WHERE seq > 2").run(); // attacker drops the tail; remaining chain is valid
    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.anchorMismatch).toBe(4);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("redaction replaces content but the chain still verifies; forging the redacted flag is caught", () => {
    audit("p9", "x", "person:p9", { a: 1 }); audit("other", "y", "obj");
    recordConsent("p9", "signup", "v1");
    expect(redactAuditFor("p9")).toBe(2);
    expect(verifyAuditChain().ok).toBe(true);
    expect(JSON.stringify(getStore("audit").prepare("SELECT * FROM audit_log").all())).not.toContain("p9");
    getStore("audit").prepare("UPDATE audit_log SET redacted = 1, actor = '[redacted]' WHERE seq = 2").run();
    expect(verifyAuditChain().ok).toBe(false);
  });
});

import express from "express";
import { grantRole, hasRole, listRoles, requireRole, revokeRole, runInTransaction } from "../../server/civic/core";

function mkPerson(id: string) {
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?, ?, ?)").run(id, new Date().toISOString(), new Date().toISOString());
}

describe("core: roles", () => {
  it("only system or an admin can grant; grants are audited, scoped and revocable", () => {
    mkPerson("admin1"); mkPerson("off1"); mkPerson("rando");
    expect(() => grantRole("rando", "off1", "officer")).toThrow();
    grantRole("system", "admin1", "admin");
    grantRole("admin1", "off1", "officer", "village:123");
    expect(hasRole("off1", "officer")).toBe(true);
    expect(hasRole("off1", "officer", "village:123")).toBe(true);
    expect(hasRole("off1", "officer", "village:999")).toBe(false);
    expect(hasRole("off1", "moderator")).toBe(false);
    grantRole("admin1", "off1", "moderator");
    expect(hasRole("off1", "moderator", "anywhere")).toBe(true); // unscoped covers all
    expect(listRoles("off1")).toEqual([{ role: "moderator", jurisdiction: null }, { role: "officer", jurisdiction: "village:123" }]);
    const rows = getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'role.%'").all() as { action: string }[];
    expect(rows.length).toBe(3);
    expect(() => revokeRole("rando", "off1", "officer")).toThrow();
    revokeRole("admin1", "off1", "officer");
    expect(hasRole("off1", "officer")).toBe(false);
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("requireRole returns 401 without a session, 403 without the role, passes with it", async () => {
    mkPerson("o2"); mkPerson("u2");
    grantRole("system", "o2", "officer");
    const app = express();
    app.get("/x", requireRole("officer"), (req, res) => res.json({ id: req.person!.id, roles: req.person!.roles }));
    const srv = await new Promise<import("http").Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      const url = `http://127.0.0.1:${(srv.address() as import("net").AddressInfo).port}/x`;
      const get = (t?: string) => fetch(url, { headers: t ? { authorization: "Bearer " + t } : {} });
      expect((await get()).status).toBe(401);
      expect((await get(createSession("u2"))).status).toBe(403);
      const ok = await get(createSession("o2"));
      expect(ok.status).toBe(200);
      expect((await ok.json()).roles).toEqual(["officer"]);
    } finally { srv.close(); }
  });
});

describe("core: transactions", () => {
  it("runInTransaction rolls back everything incl. audit rows on throw, and nests via savepoints", () => {
    const n = () => (getStore("audit").prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
    expect(() => runInTransaction(() => { audit("a", "x.one", "o"); throw new Error("fail"); })).toThrow("fail");
    expect(n()).toBe(0);
    runInTransaction(() => {
      audit("a", "x.keep", "o");
      expect(() => runInTransaction(() => { audit("a", "x.drop", "o"); throw new Error("inner"); })).toThrow("inner");
    });
    expect(n()).toBe(1);
    expect(verifyAuditChain().ok).toBe(true);
  });
});
