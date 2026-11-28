import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { CoreStore } from "../../server/data/repos/core";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** The request-time part of the identity core on the data layer (S-250): session lookup and sliding refresh, session list and revoke, role reads. SQLite and, with MYSQL_TEST_URL, MySQL 8.4. */
const at = (n: number): string => `2026-11-28T10:${String(n).padStart(2, "0")}:00.000Z`;

async function seed(db: Db): Promise<void> {
  await db.run("INSERT INTO persons (id, tier, created_at, eligible_from) VALUES ('p1','T1',?,?)", [at(0), at(0)]);
  await db.run("INSERT INTO persons (id, tier, role, created_at, eligible_from) VALUES ('p2','T2','volunteer',?,?)", [at(0), at(0)]);
  await db.run("INSERT INTO persons (id, tier, created_at, eligible_from, deleted_at) VALUES ('p3','T1',?,?,?)", [at(0), at(0), at(1)]);
  const ses = (hash: string, person: string, id: string, created: number, exp: number, seen: number | null, label: string | null) =>
    db.run("INSERT INTO sessions (token_hash, person_id, created_at, expires_at, id, last_seen_at, label) VALUES (?,?,?,?,?,?,?)", [hash, person, at(created), at(exp), id, seen === null ? null : at(seen), label]);
  await ses("h1", "p1", "s1", 2, 40, 2, "Chrome తెలుగు");
  await ses("h2", "p1", "s2", 5, 50, null, null);
  await ses("h3", "p1", "s3", 1, 3, 1, "old");
  await ses("h4", "p3", "s4", 2, 40, 2, null);
  const role = (p: string, r: string, j: string) => db.run("INSERT INTO roles (person_id, role, jurisdiction, department, granted_by, granted_at) VALUES (?,?,?,?,?,?)", [p, r, j, "", "sys", at(1)]);
  await role("p1", "officer", "AP-01"); await role("p1", "officer", "AP-02"); await role("p1", "moderator", ""); await role("p3", "admin", "");
}

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`core request path on ${label} @E2E-261`, { timeout: 60_000 }, () => {
    it("a session token hash finds its live person; a deleted person's session finds nothing", async () => {
      const { db, done } = await make();
      try {
        await seed(db);
        const s = new CoreStore(db);
        expect(await s.authRow("h1")).toEqual({ id: "p1", tier: "T1", exp: at(40), sid: "s1", created: at(2), seen: at(2) });
        expect((await s.authRow("h2"))!.seen).toBeNull();
        expect(await s.authRow("h4")).toBeUndefined();
        expect(await s.authRow("nope")).toBeUndefined();
      } finally { await done(); }
    });
    it("the sliding refresh marks the session seen and only ever pushes the expiry out", async () => {
      const { db, done } = await make();
      try {
        await seed(db);
        const s = new CoreStore(db);
        await s.touch("h1", at(10), at(55));
        expect(await s.authRow("h1")).toMatchObject({ exp: at(55), seen: at(10) });
        await s.touch("h1", at(11), at(20)); // a nearer expiry never pulls it in
        expect(await s.authRow("h1")).toMatchObject({ exp: at(55), seen: at(11) });
        expect(await s.authRow("h2")).toMatchObject({ exp: at(50) });
      } finally { await done(); }
    });
    it("lists only live sessions, newest first, with no token or hash; revoking is per person", async () => {
      const { db, done } = await make();
      try {
        await seed(db);
        const s = new CoreStore(db);
        const l = await s.list("p1", at(10));
        expect(l.map((x) => x.id)).toEqual(["s2", "s1"]);
        expect(Object.keys(l[0]).sort()).toEqual(["created_at", "expires_at", "id", "label", "last_seen_at"]);
        expect(l[1].label).toBe("Chrome తెలుగు");
        expect(await s.revokeOne("p2", "s1")).toBe(false); // not theirs
        expect(await s.revokeOne("p1", "s1")).toBe(true);
        expect(await s.revokeOne("p1", "s1")).toBe(false);
        expect((await s.list("p1", at(10))).map((x) => x.id)).toEqual(["s2"]);
        await s.revokeAll("p1");
        expect(await s.list("p1", at(0))).toEqual([]);
        expect(await s.authRow("h4")).toBeUndefined();
      } finally { await done(); }
    });
    it("role reads: names once each, the volunteer flag counts, any-of checks ignore deleted people and scope", async () => {
      const { db, done } = await make();
      try {
        await seed(db);
        const s = new CoreStore(db);
        expect(await s.roleNames("p1")).toEqual(["moderator", "officer"]);
        expect(await s.roleNames("p2")).toEqual(["volunteer"]);
        expect(await s.roleNames("nobody")).toEqual([]);
        expect(await s.holdsAny("p1", ["admin", "officer"])).toBe(true);
        expect(await s.holdsAny("p1", ["admin"])).toBe(false);
        expect(await s.holdsAny("p1", [])).toBe(false);
        expect(await s.holdsAny("p2", ["volunteer"])).toBe(true);
        expect(await s.holdsAny("p2", ["officer"])).toBe(false);
        expect(await s.holdsAny("p3", ["admin"])).toBe(false); // deleted
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => ["persons", "sessions", "roles"].includes(x.tbl_name));
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_co_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
