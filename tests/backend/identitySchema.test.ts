import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identityMysqlDdl, identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, parseMysqlUrl, migrate, migrationStatus } from "../../server/data";
import { identityMysqlMigrations, identityMysqlSqlPath } from "../../server/data/schema/identity";
import { translateSqlite } from "../../server/data/schema/translate";
import { getStore } from "../../server/civic/core/stores";

/** S-250: the MySQL schema of the identity store is generated from the SQLite migrations and must keep the same tables, columns, keys and indexes. */
describe("identity store MySQL schema is current @E2E-250", () => {
  it("server/data/schema/identity.mysql.sql matches what the migrations produce (npm run backend:schema)", () => {
    expect(fs.readFileSync(identityMysqlSqlPath, "utf8").replace(/\r\n/g, "\n")).toBe(identityMysqlDdl());
  });
  it("covers every identity table except the migrations bookkeeping table", () => {
    const tables = identitySqliteObjects().filter((o) => o.type === "table" && o.name !== "migrations" && !o.name.startsWith("sqlite_")).map((o) => o.name).sort();
    const ddl = identityMysqlDdl();
    expect([...ddl.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`/g)].map((m) => m[1]).sort()).toEqual(tables);
    expect(tables.length).toBeGreaterThan(40);
  });
  it("refuses constructs it would silently change", () => {
    const t = (sql: string, type = "table") => translateSqlite([{ type, name: "x", tbl_name: "x", sql }]);
    expect(() => t("CREATE TABLE x (a TEXT PRIMARY KEY, b TEXT REFERENCES y(id))")).toThrow(/foreign keys/);
    expect(() => t("CREATE TABLE x (a TEXT PRIMARY KEY) WITHOUT ROWID")).toThrow(/WITHOUT ROWID/);
    expect(() => translateSqlite([{ type: "table", name: "x", tbl_name: "x", sql: "CREATE TABLE x (a TEXT PRIMARY KEY, b TEXT)" }, { type: "index", name: "i", tbl_name: "x", sql: "CREATE INDEX i ON x(b) WHERE b = 'q'" }])).toThrow(/partial index/);
    expect(() => t("CREATE TRIGGER x AFTER INSERT ON y BEGIN SELECT 1; END", "trigger")).toThrow(/trigger/);
  });
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  const fresh = async () => {
    const name = "pp_id_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  };

  describe("identity schema on MySQL 8.4 @E2E-250", () => {
    it("applies once, re-running does nothing, and a changed baseline is reported as drift", async () => {
      const { db, done } = await fresh();
      try {
        expect((await migrate(db, identityMysqlMigrations())).applied).toEqual(["identity_mysql_001_baseline"]);
        expect((await migrate(db, identityMysqlMigrations())).applied).toEqual([]);
        expect((await migrationStatus(db, [{ id: "identity_mysql_001_baseline", sql: { mysql: "SELECT 1" } }])).drift).toEqual(["identity_mysql_001_baseline"]);
      } finally { await done(); }
    });

    it("has the same tables, columns (name and order), nullability, primary keys and indexes as SQLite", async () => {
      const { db, done } = await fresh();
      try {
        await migrate(db, identityMysqlMigrations());
        identityMysqlDdl(); // migrates the SQLite identity store
        const lite = getStore("identity");
        const liteTables = (lite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('migrations') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
        const myTables = (await db.all<{ n: string }>("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> 'migrations' ORDER BY table_name")).map((r) => r.n);
        expect(myTables).toEqual(liteTables);
        const problems: string[] = [];
        for (const t of liteTables) {
          const lc = lite.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number; pk: number }[];
          const mc = await db.all<{ n: string; nullable: string }>("SELECT column_name AS n, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", [t]);
          if (lc.map((c) => c.name).join() !== mc.map((c) => c.n).join()) { problems.push(`${t}: columns differ`); continue; }
          for (const c of lc) {
            const m = mc.find((x) => x.n === c.name)!;
            if ((c.notnull === 1 || c.pk > 0) !== (m.nullable === "NO")) problems.push(`${t}.${c.name}: nullability differs`);
          }
          const lpk = lc.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join();
          const mpk = (await db.all<{ n: string }>("SELECT column_name AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'PRIMARY' ORDER BY seq_in_index", [t])).map((r) => r.n).join();
          if (lpk !== mpk) problems.push(`${t}: primary key ${lpk} vs ${mpk}`);
          const li = (lite.prepare(`PRAGMA index_list(${t})`).all() as { name: string; unique: number; origin: string }[]).filter((i) => i.origin !== "pk")
            .map((i) => `${i.unique ? "U" : "I"}:${(lite.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name).join()}`).sort();
          const rows = await db.all<{ idx: string; uniq: number; col: string }>("SELECT index_name AS idx, non_unique = 0 AS uniq, column_name AS col FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name <> 'PRIMARY' ORDER BY index_name, seq_in_index", [t]);
          const by = new Map<string, { u: boolean; cols: string[] }>();
          for (const r of rows) { const e = by.get(r.idx) ?? { u: Number(r.uniq) === 1, cols: [] }; e.cols.push(r.col); by.set(r.idx, e); }
          const mi = [...by.values()].map((e) => `${e.u ? "U" : "I"}:${e.cols.join()}`).sort();
          if (li.join("|") !== mi.join("|")) problems.push(`${t}: indexes ${li.join("|")} vs ${mi.join("|")}`);
        }
        expect(problems).toEqual([]);
      } finally { await done(); }
    });

    it("behaves like SQLite where it matters: exact-case text, CHECK, many NULL unique values, Telugu text, auto ids, reserved-word column", async () => {
      const { db, done } = await fresh();
      try {
        await migrate(db, identityMysqlMigrations());
        const person = (id: string, email: string | null, label = "x") => db.run("INSERT INTO persons (id, phone_hash, email_hash, label, created_at, eligible_from) VALUES (?, ?, ?, ?, ?, ?)", [id, id + "-p", email, label, "2026-11-27T00:00:00.000Z", "2026-11-27T00:00:00.000Z"]);
        await person("A1", null, "పౌరుడు 🙂");
        await person("a1", null); // exact case: a different id, as in SQLite
        await person("B", "e1"); await person("C", null);
        await expect(person("D", "e1")).rejects.toMatchObject({ kind: "unique" });
        expect((await db.get<{ label: string }>("SELECT label FROM persons WHERE id = ?", ["A1"]))!.label).toBe("పౌరుడు 🙂");
        expect((await db.all("SELECT id FROM persons WHERE id = 'a1'")).length).toBe(1);
        await expect(db.run("INSERT INTO enrolments (id, volunteer_id, context_kind, status, created_at, expires_at) VALUES ('e', 'v', 'k', 'bogus', 't', 't')")).rejects.toMatchObject({ kind: "check" });
        const r1 = await db.run("INSERT INTO notify_block_log (bucket, org_id, org_name, category, reason) VALUES ('b', null, 'o', 'c', 'r')");
        const r2 = await db.run("INSERT INTO notify_block_log (bucket, org_id, org_name, category, reason) VALUES ('b', null, 'o', 'c', 'r')");
        expect(Number(r2.lastId)).toBe(Number(r1.lastId) + 1);
        await db.run("INSERT INTO rate_events (`key`, ts) VALUES ('k', 1)");
        expect(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rate_events WHERE `key` = 'k'"))!.n)).toBe(1);
      } finally { await done(); }
    });
  });
}
