import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { MysqlDb, SqliteDb, parseMysqlUrl, DbError } from "../../server/data";
import { runContract } from "./dataLayer.contract";

// SQLite: always. MySQL: when MYSQL_TEST_URL is set (npm run db:mysql:up starts one; CI starts one as a service), e.g. mysql://root:pp_root@127.0.0.1:3307
runContract("sqlite", async () => { const db = SqliteDb.open(":memory:"); return { db, done: () => db.close() }; });

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  const makeMysql = async () => {
    const name = "pp_t_" + crypto.randomBytes(5).toString("hex");
    const root = await mysql.createConnection({ host: parseMysqlUrl(URL_).host, port: parseMysqlUrl(URL_).port, user: parseMysqlUrl(URL_).user, password: parseMysqlUrl(URL_).password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 12 });
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  };
  runContract("mysql", makeMysql);

  describe("mysql only @E2E-247", () => {
    it("a deadlock between two transactions is retried and both finish", async () => {
      const { db, done } = await makeMysql();
      try {
        await db.exec("CREATE TABLE d (id INT NOT NULL PRIMARY KEY, v INT NOT NULL); INSERT INTO d VALUES (1, 0), (2, 0);");
        let attempts = 0;
        const gate = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const a = db.tx(async (tx) => { attempts++; await tx.run("UPDATE d SET v = v + 1 WHERE id = 1"); await gate(150); await tx.run("UPDATE d SET v = v + 1 WHERE id = 2"); }, { retries: 5 });
        const b = db.tx(async (tx) => { attempts++; await tx.run("UPDATE d SET v = v + 1 WHERE id = 2"); await gate(150); await tx.run("UPDATE d SET v = v + 1 WHERE id = 1"); }, { retries: 5 });
        await Promise.all([a, b]);
        const rows = await db.all<{ id: number; v: number }>("SELECT id, v FROM d ORDER BY id");
        expect(rows.map((r) => Number(r.v))).toEqual([2, 2]);
        expect(attempts).toBeGreaterThanOrEqual(3); // at least one transaction ran again after the deadlock
      } finally { await done(); }
    });
    it("no retry budget means the deadlock error surfaces as kind deadlock", async () => {
      const { db, done } = await makeMysql();
      try {
        await db.exec("CREATE TABLE d (id INT NOT NULL PRIMARY KEY, v INT NOT NULL); INSERT INTO d VALUES (1, 0), (2, 0);");
        const gate = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const run = (first: number, second: number) => db.tx(async (tx) => { await tx.run("UPDATE d SET v = v + 1 WHERE id = ?", [first]); await gate(150); await tx.run("UPDATE d SET v = v + 1 WHERE id = ?", [second]); }, { retries: 1 });
        const res = await Promise.allSettled([run(1, 2), run(2, 1)]);
        const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(failed).toHaveLength(1);
        expect((failed[0].reason as DbError).kind).toBe("deadlock");
      } finally { await done(); }
    });
    it("the migration lock lets only one server migrate at a time", async () => {
      const { db, done } = await makeMysql();
      try {
        const rel = await db.lock("pp_test_lock", 1);
        expect(rel).toBeTruthy();
        const second = await db.lock("pp_test_lock", 1);
        expect(second).toBeNull();
        await rel!();
        const third = await db.lock("pp_test_lock", 1);
        expect(third).toBeTruthy();
        await third!();
      } finally { await done(); }
    });
    it("the connection is utf8mb4 and the session time zone is UTC", async () => {
      const { db, done } = await makeMysql();
      try {
        const r = await db.get<{ cs: string; tz: string }>("SELECT @@character_set_connection AS cs, @@session.time_zone AS tz");
        expect(r!.cs).toBe("utf8mb4");
        expect(["+00:00", "UTC", "SYSTEM"]).toContain(r!.tz);
      } finally { await done(); }
    });
  });
} else {
  describe("data layer on MySQL", () => { it.skip("skipped: set MYSQL_TEST_URL (see docs/backend/README.md) to run the contract suite on MySQL", () => undefined); });
}
