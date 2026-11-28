import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { AdminStore, type NewRoleRequest } from "../../server/data/repos/admin";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Ninth identity module on the data layer (S-250): the admin second factor and the dual-control role-request queue. SQLite and, with MYSQL_TEST_URL, MySQL 8.4. */
const at = (n: number): string => `2026-11-28T10:00:${String(n).padStart(2, "0")}.000Z`;
const req = (n: number, o: Partial<NewRoleRequest> = {}): NewRoleRequest => ({ id: "r" + n, action: "grant", person_id: "p1", role: "officer", jurisdiction: "", department: "", reason: "ఒక కారణం 🙂 " + n, requested_by: "a1", at: at(n), expires_at: at(n + 30), ...o });

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`admin repository on ${label} @E2E-260`, { timeout: 60_000 }, () => {
    it("second factor: enrolment stores the secret and recovery hashes together, a restart replaces them, confirm moves the counter", async () => {
      const { db, done } = await make();
      try {
        const s = new AdminStore(db);
        expect(await s.mfaRow("a1")).toBeUndefined();
        await s.startEnrolment("a1", "enc1", at(1), ["h1", "h2", "h3"]);
        expect(await s.mfaRow("a1")).toEqual({ secret_enc: "enc1", confirmed: 0, last_counter: 0 });
        expect(await s.recoveryLeft("a1")).toBe(3);
        await s.startEnrolment("a1", "enc2", at(2), ["h4", "h5"]); // restart while unconfirmed
        expect(await s.mfaRow("a1")).toMatchObject({ secret_enc: "enc2", confirmed: 0 });
        expect(await s.recoveryLeft("a1")).toBe(2);
        await s.confirm("a1", 58_000_000);
        const r = (await s.mfaRow("a1"))!;
        expect(r).toEqual({ secret_enc: "enc2", confirmed: 1, last_counter: 58_000_000 });
        expect([typeof r.confirmed, typeof r.last_counter]).toEqual(["number", "number"]);
        expect(await s.recoveryLeft("nobody")).toBe(0);
      } finally { await done(); }
    });
    it("a failed enrolment write leaves the earlier one untouched (all or nothing)", async () => {
      const { db, done } = await make();
      try {
        const s = new AdminStore(db);
        await s.startEnrolment("a1", "enc1", at(1), ["h1", "h2"]);
        await expect(s.startEnrolment("a1", "enc2", at(2), ["dup", "dup"])).rejects.toMatchObject({ kind: "unique" });
        expect(await s.mfaRow("a1")).toMatchObject({ secret_enc: "enc1" });
        expect(await s.recoveryLeft("a1")).toBe(2);
      } finally { await done(); }
    });
    it("a code is accepted once: the counter only moves forward, and two at once cannot both win; a recovery code works once", async () => {
      const { db, done } = await make();
      try {
        const s = new AdminStore(db);
        await s.startEnrolment("a1", "enc", at(1), ["rc1", "rc2"]);
        await s.confirm("a1", 100);
        expect(await s.advanceCounter("a1", 101)).toBe(true);
        expect(await s.advanceCounter("a1", 101)).toBe(false);
        expect(await s.advanceCounter("a1", 90)).toBe(false);
        const both = await Promise.all([s.advanceCounter("a1", 105), s.advanceCounter("a1", 105)]);
        expect(both.filter(Boolean)).toHaveLength(1);
        expect((await s.mfaRow("a1"))!.last_counter).toBe(105);
        expect(await s.useRecovery("a1", "rc1", at(5))).toBe(true);
        expect(await s.useRecovery("a1", "rc1", at(6))).toBe(false);
        expect(await s.useRecovery("a1", "nope", at(6))).toBe(false);
        expect(await s.useRecovery("a2", "rc2", at(6))).toBe(false);
        expect(await s.recoveryLeft("a1")).toBe(1);
      } finally { await done(); }
    });
    it("role requests: filed pending, an identical open one is seen, they expire by time, lists are newest first, a rejection is recorded", async () => {
      const { db, done } = await make();
      try {
        const s = new AdminStore(db);
        await db.run("INSERT INTO persons (id, created_at, eligible_from) VALUES ('p1', ?, ?)", [at(0), at(0)]);
        await db.run("INSERT INTO persons (id, created_at, eligible_from, deleted_at) VALUES ('p2', ?, ?, ?)", [at(0), at(0), at(1)]);
        expect([await s.personExists("p1"), await s.personExists("p2"), await s.personExists("zz")]).toEqual([true, false, false]);
        await s.insertRequest(req(1)); await s.insertRequest(req(2, { action: "revoke", role: "moderator" })); await s.insertRequest(req(3, { jurisdiction: "AP-01" }));
        expect(await s.identicalPending("grant", "p1", "officer", "")).toBe(true);
        expect(await s.identicalPending("grant", "p1", "officer", "AP-02")).toBe(false);
        expect(await s.identicalPending("revoke", "p1", "officer", "")).toBe(false);
        expect((await s.request("r1"))!).toMatchObject({ status: "pending", reason: "ఒక కారణం 🙂 1", requested_by: "a1", decided_by: null });
        expect(await s.request("nope")).toBeUndefined();
        expect((await s.requests("pending")).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
        await s.expire(at(33)); // r1 (expires at 31) and r2 (32) lapse, r3 (33) too: "<= now"
        expect((await s.requests("pending"))).toEqual([]);
        expect((await s.requests("expired")).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
        await s.insertRequest(req(4)); await s.reject("r4", "a2", at(40));
        expect(await s.request("r4")).toMatchObject({ status: "rejected", decided_by: "a2", decided_at: at(40) });
        await expect(s.insertRequest(req(4))).rejects.toMatchObject({ kind: "unique" });
        await expect(db.run("UPDATE role_requests SET action = 'sideways' WHERE id = 'r4'")).rejects.toMatchObject({ kind: "check" });
      } finally { await done(); }
    });
    it("role holders: filtered by person and role, left out when the person is deleted, newest grant first", async () => {
      const { db, done } = await make();
      try {
        const s = new AdminStore(db);
        for (const [id, del] of [["p1", null], ["p2", null], ["p3", at(1)]] as const) await db.run("INSERT INTO persons (id, created_at, eligible_from, deleted_at) VALUES (?,?,?,?)", [id, at(0), at(0), del]);
        const role = (p: string, r: string, n: number) => db.run("INSERT INTO roles (person_id, role, jurisdiction, department, granted_by, granted_at) VALUES (?,?,?,?,?,?)", [p, r, "", "", "sys", at(n)]);
        await role("p1", "admin", 1); await role("p2", "officer", 5); await role("p1", "officer", 3); await role("p3", "admin", 9);
        expect((await s.roleHolders("", "")).map((r) => `${r.person_id}:${r.role}`)).toEqual(["p2:officer", "p1:officer", "p1:admin"]);
        expect((await s.roleHolders("p1", "")).map((r) => r.role)).toEqual(["officer", "admin"]);
        expect((await s.roleHolders("", "admin")).map((r) => r.person_id)).toEqual(["p1"]);
        expect(await s.roleHolders("p3", "")).toEqual([]);
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => ["admin_mfa", "admin_mfa_recovery", "role_requests", "persons", "roles"].includes(x.tbl_name));
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_ad_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
