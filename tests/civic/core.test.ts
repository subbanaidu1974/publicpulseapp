import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FileAnchorSink, anchorAuditHead, audit, auditPrivilegedRead, createSession, getDb, getKeys, getSms, migrate, registerMigration,
  requireAuth, resetDbForTests, setAnchorSink, smsOutbox, DevKeyProvider, verifyAuditChain, recordConsent, redactAuditFor,
} from "../../server/civic/core";

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
    getDb().prepare("UPDATE audit_log SET meta = '{\"n\":99}' WHERE seq = 2").run();
    expect(verifyAuditChain()).toMatchObject({ ok: false, brokenAt: 2 });
    resetDbForTests(); migrate();
    audit("a", "x.one", "obj:1"); audit("b", "x.two", "obj:2"); audit("c", "x.three", "obj:3");
    getDb().prepare("UPDATE audit_log SET action = 'x.changed' WHERE seq = 2").run();
    expect(verifyAuditChain().ok).toBe(false);
    resetDbForTests(); migrate();
    audit("a", "x.one", "obj:1"); audit("b", "x.two", "obj:2"); audit("c", "x.three", "obj:3");
    getDb().prepare("DELETE FROM audit_log WHERE seq = 2").run();
    expect(verifyAuditChain()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it("@E2E-51 a privileged read is itself logged", () => {
    auditPrivilegedRead("officer-7", "person:abc", "grievance review");
    const row = getDb().prepare("SELECT actor, action, object, meta FROM audit_log WHERE action = 'read.sensitive'").get() as { actor: string; object: string; meta: string };
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
    getDb().prepare("DELETE FROM audit_log WHERE seq > 2").run(); // attacker drops the tail; remaining chain is valid
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
    expect(JSON.stringify(getDb().prepare("SELECT * FROM audit_log").all())).not.toContain("p9");
    getDb().prepare("UPDATE audit_log SET redacted = 1, actor = '[redacted]' WHERE seq = 2").run();
    expect(verifyAuditChain().ok).toBe(false);
  });
});
