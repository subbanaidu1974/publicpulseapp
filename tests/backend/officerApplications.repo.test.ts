import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { OfficerApplications, type NewApplication } from "../../server/data/repos/officerApplications";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Third identity module on the data layer (S-250): officer applications. Runs on SQLite and, when MYSQL_TEST_URL is set, MySQL 8.4. */
const app = (n: number, o: Partial<NewApplication> = {}): NewApplication => ({
  id: "app-" + n, person_id: "p1", details_enc: "enc:" + n, email_domain: "ap.gov.in", department: "రోడ్లు 🙂 Roads", designation: "", jurisdiction: "",
  letter_ref: "media:m" + n, at: `2026-11-27T10:00:${String(n).padStart(2, "0")}.000Z`, ...o,
});
const T = "2026-11-27T12:00:00.000Z";

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`officer applications repository on ${label} @E2E-253`, () => {
    it("stores an application as submitted with numbers as numbers, Telugu text intact and a duplicate id refused", async () => {
      const { db, done } = await make();
      try {
        const r = new OfficerApplications(db);
        await r.insert(app(1));
        const row = (await r.get("app-1"))!;
        expect(row).toMatchObject({ status: "submitted", department: "రోడ్లు 🙂 Roads", domain_check: "pass", designation: "", email_confirmed_at: null, email_code_hash: null, role_request_id: null });
        expect([row.letter_checked, row.email_code_tries, row.email_sends]).toEqual([0, 0, 0]);
        expect(typeof row.email_sends).toBe("number");
        expect(await r.get("nope")).toBeUndefined();
        await expect(r.insert(app(1))).rejects.toMatchObject({ kind: "unique" });
      } finally { await done(); }
    });
    it("lists a person's applications newest first and a status queue oldest first, and finds an open one", async () => {
      const { db, done } = await make();
      try {
        const r = new OfficerApplications(db);
        await r.insert(app(1)); await r.insert(app(2)); await r.insert(app(3, { person_id: "p2" }));
        expect((await r.forPerson("p1")).map((x) => x.id)).toEqual(["app-2", "app-1"]);
        expect((await r.byStatus("submitted")).map((x) => x.id)).toEqual(["app-1", "app-2", "app-3"]);
        expect(await r.hasOpen("p1")).toBe(true);
        await r.setStatus("app-1", "withdrawn", T); await r.setStatus("app-2", "rejected", T);
        expect(await r.hasOpen("p1")).toBe(false);
        expect(await r.hasOpen("nobody")).toBe(false);
        expect((await r.get("app-1"))).toMatchObject({ status: "withdrawn", updated_at: T });
      } finally { await done(); }
    });
    it("e-mail code: send counts and resets tries, wrong tries are counted and burn the code, confirming clears it, a failed send voids it", async () => {
      const { db, done } = await make();
      try {
        const r = new OfficerApplications(db);
        await r.insert(app(1));
        await r.saveEmailCode("app-1", "hash1", "2026-11-27T12:15:00.000Z", T);
        await r.saveEmailCode("app-1", "hash2", "2026-11-27T12:30:00.000Z", "2026-11-27T12:16:00.000Z");
        expect(await r.get("app-1")).toMatchObject({ email_code_hash: "hash2", email_code_expires: "2026-11-27T12:30:00.000Z", email_sends: 2, email_code_tries: 0, email_sent_at: "2026-11-27T12:16:00.000Z" });
        await r.wrongCode("app-1", 1, false);
        expect(await r.get("app-1")).toMatchObject({ email_code_tries: 1, email_code_hash: "hash2" });
        await r.wrongCode("app-1", 5, true);
        expect(await r.get("app-1")).toMatchObject({ email_code_tries: 5, email_code_hash: null, email_code_expires: null });
        await r.saveEmailCode("app-1", "hash3", "2026-11-27T13:00:00.000Z", T);
        await r.voidEmailCode("app-1");
        expect(await r.get("app-1")).toMatchObject({ email_code_hash: null, email_sent_at: null, email_sends: 3 });
        await r.saveEmailCode("app-1", "hash4", "2026-11-27T13:00:00.000Z", T);
        await r.confirmEmail("app-1", "2026-11-27T12:05:00.000Z");
        expect(await r.get("app-1")).toMatchObject({ email_confirmed_at: "2026-11-27T12:05:00.000Z", email_code_hash: null, email_code_expires: null });
      } finally { await done(); }
    });
    it("verify files the role request link, and reject closes a pending role request but never one already decided", async () => {
      const { db, done } = await make();
      try {
        const r = new OfficerApplications(db);
        const rr = (id: string, status: string) => db.run("INSERT INTO role_requests (id, action, person_id, role, reason, requested_by, status, created_at, expires_at) VALUES (?, 'grant', 'p1', 'officer', 'r', 'admin1', ?, ?, ?)", [id, status, T, "2026-12-27T12:00:00.000Z"]);
        await r.insert(app(1)); await r.insert(app(2));
        await rr("rr-1", "pending"); await rr("rr-2", "approved");
        await r.markVerified("app-1", "rr-1", "admin1", T, "ok");
        expect(await r.get("app-1")).toMatchObject({ status: "awaiting_second_admin", role_request_id: "rr-1", reviewed_by: "admin1", review_note: "ok", letter_checked: 1 });
        expect((await r.awaiting()).map((x) => x.id)).toEqual(["app-1"]);
        expect((await r.awaiting("p1")).length).toBe(1);
        expect((await r.awaiting("p2")).length).toBe(0);
        expect(await r.roleRequest("rr-1")).toMatchObject({ status: "pending", decided_by: null, expires_at: "2026-12-27T12:00:00.000Z" });
        await r.rejectRoleRequest("rr-1", "admin2", T);
        await r.rejectRoleRequest("rr-2", "admin2", T); // already approved: untouched
        expect(await r.roleRequest("rr-1")).toMatchObject({ status: "rejected", decided_by: "admin2" });
        expect(await r.roleRequest("rr-2")).toMatchObject({ status: "approved", decided_by: null });
        expect(await r.roleRequest("none")).toBeUndefined();
        await r.markRejected("app-1", "admin2", T, "letter does not match");
        expect(await r.get("app-1")).toMatchObject({ status: "rejected", reviewed_by: "admin2", review_note: "letter does not match" });
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name === "officer_application" || x.tbl_name === "role_requests");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_of_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
