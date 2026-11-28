import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { HouseholdStore } from "../../server/data/repos/households";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Eighth identity module on the data layer (S-250): households. Runs on SQLite and, when MYSQL_TEST_URL is set, MySQL 8.4. */
const T = 1_800_000_000_000; // epoch milliseconds, beyond 32 bits: BIGINT on MySQL

const adult = (n: number, hh = "h1", person = "p" + n) => ({ id: "m" + n, household_id: hh, person_id: person, relation: "spouse", consent_id: "c" + n, at: T + n });
const invite = (n: number, hash: string | null, o: { hh?: string; at?: number; expires?: number } = {}) => ({ id: "i" + n, household_id: o.hh ?? "h1", phone_hash: hash as string, relation: "parent", at: o.at ?? T + n, expires_at: o.expires ?? T + 1000 + n });

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`households repository on ${label} @E2E-259`, { timeout: 60_000 }, () => {
    it("a household has one head; members are found from either side; times and counts come back as numbers", async () => {
      const { db, done } = await make();
      try {
        const s = new HouseholdStore(db);
        await s.insertHousehold("h1", "head1", T);
        await expect(s.insertHousehold("h1", "head2", T)).rejects.toMatchObject({ kind: "unique" });
        await s.insertAdult(adult(1));
        expect(await s.byHead("head1")).toMatchObject({ id: "h1", created_at: T });
        expect(typeof (await s.byHead("head1"))!.created_at).toBe("number");
        expect(await s.byHead("p1")).toBeUndefined();
        expect(await s.memberHouseholdId("p1")).toBe("h1");
        expect(await s.memberHouseholdId("nobody")).toBeUndefined();
        expect(await s.headOf("h1")).toBe("head1");
        expect(await s.headOf("zz")).toBeUndefined();
        expect(await s.acceptedMemberId("h1", "p1")).toBe("m1");
        expect(await s.acceptedMemberId("h1", "p9")).toBeUndefined();
        expect((await s.household("h1"))!.head_person_id).toBe("head1");
        await expect(s.insertAdult(adult(2, "h2", "p1"))).rejects.toMatchObject({ kind: "unique" }); // a person is in one household only
      } finally { await done(); }
    });
    it("dependents hold no person and need a year of birth; the cap count, the roster order and erasure at 18 work", async () => {
      const { db, done } = await make();
      try {
        const s = new HouseholdStore(db);
        await s.insertHousehold("h1", "head1", T);
        await s.insertAdult(adult(1));
        await s.insertDependent({ id: "d1", household_id: "h1", relation: "son", year_of_birth: 2012, consent_id: "c", at: T + 2 });
        await s.insertDependent({ id: "d2", household_id: "h1", relation: "ward", year_of_birth: 2020, consent_id: "c", at: T + 3 });
        expect(await s.dependentCount("h1")).toBe(2);
        expect((await s.members("h1")).map((m) => [m.id, m.status, m.person_id, m.year_of_birth])).toEqual([["m1", "accepted", "p1", null], ["d1", "dependent", null, 2012], ["d2", "dependent", null, 2020]]);
        await expect(db.run("INSERT INTO hh_member (id, household_id, person_id, relation, status, year_of_birth, created_at) VALUES ('bad','h1','p5','son','dependent',2015,?)", [T])).rejects.toMatchObject({ kind: "check" });
        await expect(db.run("INSERT INTO hh_member (id, household_id, person_id, relation, status, created_at) VALUES ('bad2','h1',NULL,'son','accepted',?)", [T])).rejects.toMatchObject({ kind: "check" });
        const due = await s.dependentsBornBy(2012);
        expect(due).toEqual([{ id: "d1", household_id: "h1" }]);
        await s.deleteMember("d1");
        expect(await s.dependentCount("h1")).toBe(1);
        expect(await s.member("d2", "h1")).toMatchObject({ relation: "ward" });
        expect(await s.member("d2", "other")).toBeUndefined();
      } finally { await done(); }
    });
    it("invites: only a keyed hash is stored; a lookup under several key versions finds it; decide clears the hash; expiry clears it too", async () => {
      const { db, done } = await make();
      try {
        const s = new HouseholdStore(db);
        await s.insertHousehold("h1", "head1", T);
        await s.insertInvite(invite(1, "hashA")); await s.insertInvite(invite(2, "hashB")); await s.insertInvite(invite(3, "hashC", { expires: T + 50 }));
        expect(await s.pendingInviteFor("h1", ["old", "hashA"])).toBe(true);
        expect(await s.pendingInviteFor("h1", ["old"])).toBe(false);
        expect(await s.pendingInviteFor("other", ["hashA"])).toBe(false);
        expect(await s.pendingInviteCount("h1")).toBe(3);
        expect((await s.pendingInvites("h1")).map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
        expect(typeof (await s.pendingInvites("h1"))[0].expires_at).toBe("number");
        await s.markDeclined("i1"); await s.markReported("i2");
        expect(await s.invite("i1")).toMatchObject({ status: "declined", phone_hash: null });
        expect(await s.invite("i2")).toMatchObject({ status: "reported", phone_hash: null });
        await s.expireStale(T + 100);
        expect(await s.invite("i3")).toMatchObject({ status: "expired", phone_hash: null });
        expect(await s.inviteState("i3")).toEqual({ status: "expired", expires_at: T + 50 });
        expect(await s.pendingInviteCount("h1")).toBe(0);
        await s.insertInvite(invite(4, "hashD"));
        await s.markAccepted("i4", "p4");
        expect(await s.invite("i4")).toMatchObject({ status: "accepted", accepted_person_id: "p4", phone_hash: null });
        await s.insertInvite(invite(5, "hashE")); await s.deleteInvite("i5");
        expect(await s.invite("i5")).toBeUndefined();
        await expect(s.insertInvite(invite(4, "x"))).rejects.toMatchObject({ kind: "unique" });
      } finally { await done(); }
    });
    it("cool-down: a decline blocks the one household, a report blocks every household, a repeat restarts the clock, elapsed ones are dropped", async () => {
      const { db, done } = await make();
      try {
        const s = new HouseholdStore(db);
        await s.startCooldown("hashA", "h1", T + 1000, "declined");
        await s.startCooldown("hashB", "*", T + 2000, "reported");
        expect(await s.cooldownUntil(["hashA"], "h1", T)).toBe(T + 1000);
        expect(typeof (await s.cooldownUntil(["hashA"], "h1", T))).toBe("number");
        expect(await s.cooldownUntil(["hashA"], "h2", T)).toBeUndefined();
        expect(await s.cooldownUntil(["x", "hashB"], "h2", T)).toBe(T + 2000);
        await s.startCooldown("hashA", "h1", T + 5000, "reported"); // same key: replaced, not duplicated
        expect(await s.cooldownUntil(["hashA"], "h1", T)).toBe(T + 5000);
        expect(Number((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM hh_invite_cooldown"))!.c)).toBe(2);
        await s.expireStale(T + 3000);
        expect(await s.cooldownUntil(["hashB"], "h2", T)).toBeUndefined();
        expect(await s.cooldownUntil(["hashA"], "h1", T)).toBe(T + 5000);
      } finally { await done(); }
    });
    it("head transfer: one proposal per household can wait, it expires, and decisions are recorded", async () => {
      const { db, done } = await make();
      try {
        const s = new HouseholdStore(db);
        await s.insertHousehold("h1", "head1", T);
        await s.insertTransfer({ id: "t1", household_id: "h1", from_person: "head1", to_person: "p1", at: T, expires_at: T + 500 });
        expect(await s.pendingTransfer("h1")).toMatchObject({ id: "t1", from_person: "head1", to_person: "p1", expires_at: T + 500 });
        expect(await s.transfer("t1")).toMatchObject({ status: "pending", created_at: T });
        await s.expireStale(T + 600);
        expect(await s.pendingTransfer("h1")).toBeUndefined();
        expect((await s.transfer("t1"))!.status).toBe("expired");
        await s.insertTransfer({ id: "t2", household_id: "h1", from_person: "head1", to_person: "p1", at: T + 700, expires_at: T + 9000 });
        await s.setTransferStatus("t2", "declined");
        expect((await s.transfer("t2"))!.status).toBe("declined");
        await expect(db.run("UPDATE hh_transfer SET status = 'weird' WHERE id = 't2'")).rejects.toMatchObject({ kind: "check" });
      } finally { await done(); }
    });
    it("transactions: handing over the head and dissolving a household are all-or-nothing; the PIN write reaches the person row", async () => {
      const { db, done } = await make();
      try {
        const s = new HouseholdStore(db);
        await s.insertHousehold("h1", "head1", T); await s.insertAdult(adult(1)); await s.insertDependent({ id: "d1", household_id: "h1", relation: "son", year_of_birth: 2015, consent_id: null, at: T + 2 });
        await s.insertInvite(invite(1, "hashA"));
        // a hand-over that fails half way leaves everything as it was
        await expect(db.tx(async (t) => {
          const x = new HouseholdStore(t);
          await x.deleteMember("m1"); await x.setHead("h1", "p1");
          await x.insertAdult(adult(9, "h1", "p9")); await x.insertAdult(adult(10, "h1", "p9")); // the second repeats a person: unique
        })).rejects.toMatchObject({ kind: "unique" });
        expect(await s.headOf("h1")).toBe("head1");
        expect(await s.acceptedMemberId("h1", "p1")).toBe("m1");
        expect(await s.acceptedMemberId("h1", "p9")).toBeUndefined();
        await db.tx(async (t) => { const x = new HouseholdStore(t); await x.deleteMember("m1"); await x.setHead("h1", "p1"); await x.insertAdult(adult(2, "h1", "head1")); });
        expect(await s.headOf("h1")).toBe("p1");
        expect(await s.acceptedMemberId("h1", "head1")).toBe("m2");
        await db.tx((t) => new HouseholdStore(t).dissolve("h1"));
        expect(await s.household("h1")).toBeUndefined();
        expect(await s.members("h1")).toEqual([]);
        expect(await s.invite("i1")).toBeUndefined();
        await db.run("INSERT INTO persons (id, created_at, eligible_from) VALUES ('p7', ?, ?)", ["2026-11-28T10:00:00.000Z", "2026-11-28T10:00:00.000Z"]);
        await s.setPin("p7", "salt1", "hash1");
        expect(await db.get("SELECT pin_salt, pin_hash FROM persons WHERE id = 'p7'")).toEqual({ pin_salt: "salt1", pin_hash: "hash1" });
        await s.insertHousehold("h2", "headX", T); await s.insertAdult(adult(11, "h2", "p11"));
        await s.deleteMemberOf("p11", "h2");
        expect(await s.members("h2")).toEqual([]);
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name.startsWith("hh_") || x.tbl_name === "persons");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_hh_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
