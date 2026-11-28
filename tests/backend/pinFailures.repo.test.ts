import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { PinFailureStore } from "../../server/data/repos/pinFailures";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Sign-in lockout state on the data layer (S-59, S-250): SQLite and, with MYSQL_TEST_URL, MySQL 8.4. */
const at = (n: number): string => `2026-11-28T10:${String(n).padStart(2, "0")}:00.000Z`;

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`pin failures on ${label} @E2E-263`, { timeout: 60_000 }, () => {
    it("a wrong-PIN streak is kept per person and source, locks, and a good PIN clears it and remembers the source", async () => {
      const { db, done } = await make();
      try {
        const s = new PinFailureStore(db);
        expect(await s.row("p1", "src")).toBeUndefined();
        await s.failure("p1", "src", 1, null, at(1));
        await s.failure("p1", "src", 5, at(31), at(2));
        expect(await s.row("p1", "src")).toEqual({ failed: 5, locked_until: at(31), ok_at: null });
        expect(await s.row("p1", "other")).toBeUndefined(); // a stranger's source does not touch the owner's
        expect(await s.lockedAnywhere("p1", at(10))).toBe(true);
        expect(await s.lockedAnywhere("p1", at(40))).toBe(false); // the lock has run out
        expect(await s.lockedAnywhere("p2", at(10))).toBe(false);
        await s.success("p1", "src", at(35));
        expect(await s.row("p1", "src")).toEqual({ failed: 0, locked_until: null, ok_at: at(35) });
        expect(typeof (await s.row("p1", "src"))!.failed).toBe("number");
      } finally { await done(); }
    });
    it("a later wrong PIN keeps the time of the earlier good sign-in", async () => {
      const { db, done } = await make();
      try {
        const s = new PinFailureStore(db);
        await s.success("p1", "src", at(3));
        await s.failure("p1", "src", 1, null, at(4));
        expect(await s.row("p1", "src")).toEqual({ failed: 1, locked_until: null, ok_at: at(3) });
      } finally { await done(); }
    });
    it("a source counts as known only after a good sign-in as one of the listed people", async () => {
      const { db, done } = await make();
      try {
        const s = new PinFailureStore(db);
        await s.failure("p1", "src", 2, null, at(1));
        expect(await s.knownSource("src", ["p1"])).toBe(false);
        await s.success("p1", "src", at(2));
        expect(await s.knownSource("src", ["p1"])).toBe(true);
        expect(await s.knownSource("src", ["p1", "p2"])).toBe(true);
        expect(await s.knownSource("src", ["p2"])).toBe(false);
        expect(await s.knownSource("src", [])).toBe(false);
        expect(await s.knownSource("elsewhere", ["p1"])).toBe(false);
      } finally { await done(); }
    });
    it("clearing a person drops every source of theirs and nobody else's", async () => {
      const { db, done } = await make();
      try {
        const s = new PinFailureStore(db);
        await s.failure("p1", "a", 1, null, at(1)); await s.failure("p1", "b", 1, null, at(1)); await s.failure("p2", "a", 1, null, at(1));
        await s.clearPerson("p1");
        expect([await s.row("p1", "a"), await s.row("p1", "b")]).toEqual([undefined, undefined]);
        expect(await s.row("p2", "a")).toBeDefined();
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name === "pin_failures");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_pf_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
