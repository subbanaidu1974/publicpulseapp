import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { PhotoSubmissions, type NewPhotoSubmission } from "../../server/data/repos/photoSubmissions";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** First identity module on the data layer (S-250). The same repository tests run on SQLite and, when MYSQL_TEST_URL is set, MySQL 8.4. */
const sub = (n: number, o: Partial<NewPhotoSubmission> = {}): NewPhotoSubmission => ({
  id: "ph_" + String(n).padStart(16, "0"), created_at: `2026-11-27T10:00:${String(n).padStart(2, "0")}.000Z`, state: "TG", ac_no: 5, year: 2023, candidate: "అభ్యర్థి " + n,
  claimed_name: "A Person", relationship: "candidate", holder: "Photo: A Person 🙂", contact_enc: "enc:" + n, file: `ph_${n}.jpg`, mime: "image/jpeg", bytes: 1234, sha256: "ab".repeat(32), ...o,
});

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`photo submissions repository on ${label} @E2E-251`, () => {
    it("stores a submission as pending and reads it back with Telugu and emoji text intact", async () => {
      const { db, done } = await make();
      try {
        const r = new PhotoSubmissions(db);
        await r.insert(sub(1));
        const [row] = await r.list(null);
        expect(row).toMatchObject({ id: sub(1).id, status: "pending", candidate: "అభ్యర్థి 1", holder: "Photo: A Person 🙂", decided_at: null, decided_by: null, note: null });
        expect(Number(row.ac_no)).toBe(5); expect(Number(row.bytes)).toBe(1234);
        expect(await r.approved()).toEqual([]);
        expect(await r.approvedFile(sub(1).id)).toBeNull();
      } finally { await done(); }
    });
    it("a duplicate id is refused", async () => {
      const { db, done } = await make();
      try { const r = new PhotoSubmissions(db); await r.insert(sub(1)); await expect(r.insert(sub(1))).rejects.toMatchObject({ kind: "unique" }); } finally { await done(); }
    });
    it("deciding approves or rejects, reports a missing id, and an unchanged re-decision still counts as found", async () => {
      const { db, done } = await make();
      try {
        const r = new PhotoSubmissions(db);
        await r.insert(sub(1)); await r.insert(sub(2)); await r.insert(sub(3));
        expect(await r.decide(sub(1).id, "approved", "admin1", "looks right", "2026-11-27T11:00:00.000Z")).toBe(true);
        expect(await r.decide(sub(1).id, "approved", "admin1", "looks right", "2026-11-27T11:00:00.000Z")).toBe(true);
        expect(await r.decide(sub(2).id, "approved", "admin1", null, "2026-11-27T12:00:00.000Z")).toBe(true);
        expect(await r.decide(sub(3).id, "rejected", "admin1", "blurry", "2026-11-27T12:30:00.000Z")).toBe(true);
        expect(await r.decide("ph_missing", "approved", "admin1", null, "2026-11-27T13:00:00.000Z")).toBe(false);
        expect((await r.approved()).map((x) => x.id)).toEqual([sub(2).id, sub(1).id]); // newest decision first
        expect(await r.approvedFile(sub(2).id)).toBe("ph_2.jpg");
        expect(await r.approvedFile(sub(3).id)).toBeNull(); // rejected is never served
        expect((await r.list("rejected")).map((x) => x.id)).toEqual([sub(3).id]);
        expect((await r.list("pending")).length).toBe(0);
        expect((await r.fileAndMime(sub(1).id))).toEqual({ file: "ph_1.jpg", mime: "image/jpeg" });
        expect(await r.fileAndMime("nope")).toBeUndefined();
      } finally { await done(); }
    });
    it("lists newest first, caps the page, and the database refuses an unknown status", async () => {
      const { db, done } = await make();
      try {
        const r = new PhotoSubmissions(db);
        for (let i = 1; i <= 5; i++) await r.insert(sub(i));
        expect((await r.list(null, 3)).map((x) => x.id)).toEqual([sub(5).id, sub(4).id, sub(3).id]);
        await expect(db.run("UPDATE photo_submissions SET status = 'bogus' WHERE id = ?", [sub(1).id])).rejects.toMatchObject({ kind: "check" });
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name === "photo_submissions");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_ph_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
