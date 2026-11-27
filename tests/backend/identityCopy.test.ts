import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { copyTables, MysqlDb, migrate, parseMysqlUrl, SqliteDb, verifyTables, type Db } from "../../server/data";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** S-250: moving the identity rows from the SQLite store to MySQL, and proving the copy is complete and unchanged. */
const TABLES = ["persons", "consents", "rate_events", "notify_block_log", "enrolments", "roles"];

async function liteIdentity(): Promise<Db> {
  const db = SqliteDb.open(":memory:");
  const objs = identitySqliteObjects().filter((o) => o.name !== "migrations" && !o.name.startsWith("sqlite_"));
  for (const o of [...objs.filter((x) => x.type === "table"), ...objs.filter((x) => x.type === "index")]) await db.exec(o.sql);
  return db;
}

async function seed(db: Db): Promise<void> {
  await db.tx(async (tx) => {
    for (let i = 0; i < 530; i++) { // more than two copy batches
      await tx.run("INSERT INTO persons (id, phone_hash, email_hash, label, failed_pins, created_at, eligible_from) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["p" + String(i).padStart(4, "0"), "h" + i, i % 3 === 0 ? "e" + i : null, i % 5 === 0 ? "పౌరుడు " + i + " 🙂" : i % 7 === 0 ? "" : null, i % 11, "2026-11-27T00:00:00.000Z", "2026-11-27T00:00:00.000Z"]);
      await tx.run("INSERT INTO consents (id, person_id, purpose, version, ts) VALUES (?, ?, 'signup', '1', ?)", ["c" + i, "p" + String(i).padStart(4, "0"), "2026-11-27T00:00:00.000Z"]);
    }
    for (let i = 0; i < 40; i++) await tx.run("INSERT INTO rate_events (key, ts) VALUES (?, ?)", ["k" + (i % 4), 1700000000000 + i]);
    await tx.run("INSERT INTO notify_block_log (bucket, org_id, org_name, category, reason) VALUES ('b', NULL, 'o', 'c', 'r')");
    await tx.run("INSERT INTO notify_block_log (bucket, org_id, org_name, category, reason) VALUES ('b', 'o1', 'ఆర్గ్', 'c', 'r')");
  });
}

describe("copy and verify (S-250) @E2E-250", () => {
  it("copies every row to another database, verifies it, and notices a changed, missing or extra row", async () => {
    const a = await liteIdentity(); const b = await liteIdentity();
    try {
      await seed(a);
      const r = await copyTables(a, b, TABLES);
      expect(r.rows).toBe(530 * 2 + 40 + 2);
      expect((await verifyTables(a, b, TABLES)).ok).toBe(true);
      await b.run("UPDATE persons SET label = 'changed' WHERE id = 'p0001'");
      const v1 = await verifyTables(a, b, TABLES);
      expect(v1.ok).toBe(false);
      expect(v1.tables.filter((t) => !t.same).map((t) => t.table)).toEqual(["persons"]);
      await b.run("UPDATE persons SET label = (SELECT label FROM persons WHERE id = 'p0001') WHERE id = 'p0001'");
      await a.run("UPDATE persons SET label = 'changed' WHERE id = 'p0001'");
      expect((await verifyTables(a, b, TABLES)).ok).toBe(true);
      await b.run("DELETE FROM consents WHERE id = 'c5'");
      await b.run("INSERT INTO rate_events (key, ts) VALUES ('extra', 1)");
      expect((await verifyTables(a, b, TABLES)).tables.filter((t) => !t.same).map((t) => t.table).sort()).toEqual(["consents", "rate_events"]);
    } finally { await a.close(); await b.close(); }
  });

  it("refuses a target that already has rows and a target with different columns", async () => {
    const a = await liteIdentity(); const b = await liteIdentity();
    try {
      await seed(a); await copyTables(a, b, ["consents", "persons"]);
      await expect(copyTables(a, b, ["persons"])).rejects.toThrow(/already has rows/);
      await b.exec("DROP TABLE roles; CREATE TABLE roles (person_id TEXT, other TEXT)");
      await expect(copyTables(a, b, ["roles"])).rejects.toThrow(/different columns|does not exist/);
      await expect(copyTables(a, b, ["nope"])).rejects.toThrow();
    } finally { await a.close(); await b.close(); }
  });
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  describe("copy from the SQLite identity store into MySQL (S-250) @E2E-250", () => {
    it("moves the rows with Telugu text, NULLs, empty strings and auto ids intact, and the digests match", async () => {
      const name = "pp_cp_" + crypto.randomBytes(5).toString("hex");
      const u = parseMysqlUrl(URL_);
      const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
      await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      const my = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
      const lite = await liteIdentity();
      try {
        await migrate(my, identityMysqlMigrations());
        await seed(lite);
        const r = await copyTables(lite, my, TABLES);
        expect(r.rows).toBe(530 * 2 + 40 + 2);
        const v = await verifyTables(lite, my, TABLES);
        expect(v.tables.filter((t) => !t.same)).toEqual([]);
        expect(v.ok).toBe(true);
        expect((await my.get<{ label: string }>("SELECT label FROM persons WHERE id = 'p0005'"))!.label).toBe("పౌరుడు 5 🙂");
        expect((await my.get<{ label: string | null }>("SELECT label FROM persons WHERE id = 'p0007'"))!.label).toBe("");
        expect((await my.get<{ label: string | null }>("SELECT label FROM persons WHERE id = 'p0001'"))!.label).toBeNull();
        expect((await my.all<{ id: number }>("SELECT id FROM notify_block_log ORDER BY id")).map((x) => Number(x.id))).toEqual([1, 2]);
        await my.run("UPDATE persons SET label = 'tampered' WHERE id = 'p0010'");
        expect((await verifyTables(lite, my, TABLES)).tables.filter((t) => !t.same).map((t) => t.table)).toEqual(["persons"]);
        // a key longer than the VARCHAR(190) column is refused loudly and nothing from that table is kept
        await lite.run("INSERT INTO roles (person_id, role, jurisdiction, granted_by, granted_at) VALUES (?, 'r', '', 'g', 't')", ["x".repeat(300)]);
        await expect(copyTables(lite, my, ["roles"])).rejects.toThrow(/roles failed after/);
        expect(Number((await my.get<{ n: number }>("SELECT COUNT(*) AS n FROM roles"))!.n)).toBe(0);
      } finally { await lite.close(); await my.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); }
    });
  });
}
