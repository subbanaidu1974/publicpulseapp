import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { PeopleRequests, type NewPeopleRequest } from "../../server/data/repos/peopleRequests";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Second identity module on the data layer (S-250): correction and takedown requests. Runs on SQLite and, when MYSQL_TEST_URL is set, MySQL 8.4. */
const req = (n: number, o: Partial<NewPeopleRequest> = {}): NewPeopleRequest => ({
  id: "req_" + n, created_at: `2026-11-27T10:00:${String(n).padStart(2, "0")}.000Z`, kind: "takedown", page: "/members/TG", target_kind: "photo", target_key: "TG-assembly-" + n,
  reason: "ఈ ఫోటో తప్పు 🙂 this photo is wrong", contact_enc: "enc:" + n, sla_days: 7, sla_due: "2026-12-04T10:00:00.000Z", ...o,
});
const AT = "2026-11-27T12:00:00.000Z";

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`people requests repository on ${label} @E2E-252`, () => {
    it("stores a request as open, keeps Telugu text, and refuses a duplicate id or an unknown kind", async () => {
      const { db, done } = await make();
      try {
        const r = new PeopleRequests(db);
        await r.insertRequest(req(1));
        expect(await r.getRequest("req_1")).toMatchObject({ status: "open", kind: "takedown", reason: "ఈ ఫోటో తప్పు 🙂 this photo is wrong", resolved_at: null, resolution: null });
        expect(await r.getRequest("nope")).toBeUndefined();
        await expect(r.insertRequest(req(1))).rejects.toMatchObject({ kind: "unique" });
        await expect(r.insertRequest(req(2, { kind: "bogus" }))).rejects.toMatchObject({ kind: "check" });
        await r.insertRequest(req(3, { target_kind: null, target_key: null, contact_enc: null, kind: "correction" }));
        expect(await r.getRequest("req_3")).toMatchObject({ target_kind: null, contact_enc: null });
      } finally { await done(); }
    });
    it("lists newest first, filters by status, and closing a request is visible in the list", async () => {
      const { db, done } = await make();
      try {
        const r = new PeopleRequests(db);
        for (let i = 1; i <= 3; i++) await r.insertRequest(req(i));
        expect((await r.listRequests()).map((x) => x.id)).toEqual(["req_3", "req_2", "req_1"]);
        await r.closeRequest("req_2", "resolved", AT, "removed");
        expect((await r.listRequests("open")).map((x) => x.id)).toEqual(["req_3", "req_1"]);
        expect(await r.listRequests("resolved")).toMatchObject([{ id: "req_2", resolved_at: AT, resolution: "removed" }]);
        expect(await r.listRequests("rejected")).toEqual([]);
      } finally { await done(); }
    });
    it("a photo takedown hides at once pending review and a repeat keeps one flag", async () => {
      const { db, done } = await make();
      try {
        const r = new PeopleRequests(db);
        await r.hidePendingReview("TG-assembly-5", "req_1", AT);
        await r.hidePendingReview("TG-assembly-5", "req_2", "2026-11-27T13:00:00.000Z");
        const t = await r.listTakedowns();
        expect(t.length).toBe(1);
        expect(t[0]).toMatchObject({ target_kind: "photo", target_key: "TG-assembly-5", request_id: "req_2", state: "pending-review", created_at: AT, updated_at: "2026-11-27T13:00:00.000Z" });
        expect(Number(t[0].active)).toBe(1);
        expect((await r.hiddenKeys()).has("photo|TG-assembly-5")).toBe(true);
      } finally { await done(); }
    });
    it("an admin confirms, a repeat request never downgrades a confirmed flag, and lifting stops hiding", async () => {
      const { db, done } = await make();
      try {
        const r = new PeopleRequests(db);
        await r.hidePendingReview("k", "req_1", AT);
        await r.confirmForRequest("photo", "k", "req_1", "2026-11-27T13:00:00.000Z");
        expect((await r.listTakedowns())[0]).toMatchObject({ state: "confirmed", request_id: "req_1" });
        await r.hidePendingReview("k", "req_2", "2026-11-27T14:00:00.000Z");
        expect((await r.listTakedowns())[0]).toMatchObject({ state: "confirmed", request_id: "req_2" });
        await r.lift("photo", "k", "2026-11-27T15:00:00.000Z");
        expect((await r.hiddenKeys()).size).toBe(0);
        expect(Number((await r.listTakedowns())[0].active)).toBe(0);
        await r.lift("photo", "never-flagged", AT); // nothing to lift is not an error
      } finally { await done(); }
    });
    it("an admin can set and clear a takedown directly, and the flag list is newest first, capped by kind rules in the database", async () => {
      const { db, done } = await make();
      try {
        const r = new PeopleRequests(db);
        await r.setTakedown("office-holder", "oh1", true, AT);
        await r.setTakedown("field", "f1", true, "2026-11-27T13:00:00.000Z");
        expect([...(await r.hiddenKeys())].sort()).toEqual(["field|f1", "office-holder|oh1"]);
        await r.setTakedown("field", "f1", false, "2026-11-27T14:00:00.000Z");
        expect([...(await r.hiddenKeys())]).toEqual(["office-holder|oh1"]);
        expect((await r.listTakedowns()).map((x) => x.target_key)).toEqual(["f1", "oh1"]);
        await expect(r.setTakedown("bogus", "x", true, AT)).rejects.toMatchObject({ kind: "check" });
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name === "people_requests" || x.tbl_name === "people_takedowns");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_pr_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
