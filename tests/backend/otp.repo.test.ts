import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { OtpStore } from "../../server/data/repos/otp";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** One-time codes on the data layer (S-250, S-161 key versions): SQLite and, with MYSQL_TEST_URL, MySQL 8.4. */
const at = (n: number): string => `2026-11-28T10:${String(n).padStart(2, "0")}:00.000Z`;

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`one-time codes on ${label} @E2E-262`, { timeout: 60_000 }, () => {
    it("a stored code is found under any active key version, newest first; a new one replaces the old and resets the tries", async () => {
      const { db, done } = await make();
      try {
        const s = new OtpStore(db);
        const cands = ["new", "old"]; // newest key version first
        expect(await s.row(cands, "signup")).toBeUndefined();
        await db.run("INSERT INTO otps (phone_hash, purpose, code_hash, expires_at, attempts) VALUES ('old','signup','c-old',?,2)", [at(5)]); // written before a rotation
        expect(await s.row(cands, "signup")).toEqual({ phone_hash: "old", code_hash: "c-old", expires_at: at(5), attempts: 2 });
        await s.store(cands, "signup", "c-new", at(9)); // always under the newest; the old-version row goes
        expect(await s.row(cands, "signup")).toEqual({ phone_hash: "new", code_hash: "c-new", expires_at: at(9), attempts: 0 });
        expect(await db.get("SELECT 1 AS x FROM otps WHERE phone_hash = 'old'")).toBeUndefined();
        await s.wrongTry("new", "signup"); await s.wrongTry("new", "signup");
        expect((await s.row(cands, "signup"))!.attempts).toBe(2);
        await s.store(cands, "signup", "c-newer", at(12)); // a fresh code resets the tries
        expect(await s.row(cands, "signup")).toMatchObject({ code_hash: "c-newer", attempts: 0 });
      } finally { await done(); }
    });
    it("purposes are separate: a signup code is not a recovery code", async () => {
      const { db, done } = await make();
      try {
        const s = new OtpStore(db);
        await s.store(["h"], "signup", "a", at(5)); await s.store(["h"], "recovery", "b", at(6)); await s.store(["h"], "enrol", "c", at(7));
        expect((await s.row(["h"], "recovery"))!.code_hash).toBe("b");
        await s.discard(["h"], "signup");
        expect(await s.row(["h"], "signup")).toBeUndefined();
        expect((await s.row(["h"], "enrol"))!.code_hash).toBe("c");
      } finally { await done(); }
    });
    it("a code is spent once: of two requests using it at the same moment only one wins", async () => {
      const { db, done } = await make();
      try {
        const s = new OtpStore(db);
        await s.store(["h"], "signup", "a", at(5));
        const wins = await Promise.all([s.spend("h", "signup"), s.spend("h", "signup"), s.spend("h", "signup")]);
        expect(wins.filter(Boolean)).toHaveLength(1);
        expect(await s.row(["h"], "signup")).toBeUndefined();
        expect(await s.spend("h", "signup")).toBe(false);
      } finally { await done(); }
    });
    it("discarding drops the code under every key version and leaves other people's alone", async () => {
      const { db, done } = await make();
      try {
        const s = new OtpStore(db);
        await db.run("INSERT INTO otps (phone_hash, purpose, code_hash, expires_at, attempts) VALUES ('old','signup','x',?,0)", [at(5)]);
        await s.store(["other"], "signup", "y", at(5));
        await s.discard(["new", "old"], "signup");
        expect(await s.row(["new", "old"], "signup")).toBeUndefined();
        expect(await s.row(["other"], "signup")).toBeDefined();
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name === "otps");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_ot_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
