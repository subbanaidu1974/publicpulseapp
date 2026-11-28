import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { VideoStore, type NewVideo } from "../../server/data/repos/videocast";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Sixth identity module on the data layer (S-250): video broadcasts. Runs on SQLite and, when MYSQL_TEST_URL is set, MySQL 8.4. */
const at = (n: number): string => `2026-11-28T10:00:${String(n).padStart(2, "0")}.000Z`;
const vid = (n: number, o: Partial<NewVideo> = {}): NewVideo => ({ id: "v" + n, title_en: "Explainer " + n, title_te: "వివరణ 🙂 " + n, note_en: null, note_te: null, media_url: `https://media.example.org/${n}.mp4`, kind: "video", credit: "People Pulse", created_by: "a1", at: at(n), publish_at: null, library: 0, transcript: null, ...o });

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`video broadcasts repository on ${label} @E2E-257`, { timeout: 60_000 }, () => {
    it("stores an item as pending with numbers as numbers and Telugu text intact; a duplicate id is refused", async () => {
      const { db, done } = await make();
      try {
        const s = new VideoStore(db);
        await s.insert(vid(1, { library: 1, transcript: "text" }));
        const r = (await s.get("v1"))!;
        expect(r).toMatchObject({ status: "pending", title_te: "వివరణ 🙂 1", library: 1, views: 0, live_at: null });
        expect([typeof r.library, typeof r.views]).toEqual(["number", "number"]);
        expect(await s.get("nope")).toBeUndefined();
        expect(await s.pendingCount()).toBe(1);
        await expect(s.insert(vid(1))).rejects.toMatchObject({ kind: "unique" });
        await expect(s.insert(vid(2, { kind: "film" }))).rejects.toBeDefined(); // the CHECK on kind
        expect((await s.listAdmin()).map((x) => x.id)).toEqual(["v1"]);
      } finally { await done(); }
    });
    it("approve, reject and recall only move an item from the right state; the live list shows listed items newest first", async () => {
      const { db, done } = await make();
      try {
        const s = new VideoStore(db);
        for (const n of [1, 2, 3, 4]) await s.insert(vid(n));
        await s.approve("v1", "b1", at(20), at(21)); await s.approve("v2", "b1", at(20), at(25)); await s.approve("v3", "b1", at(20), at(40));
        await s.reject("v4", "b1", at(20)); await s.reject("v1", "b1", at(22)); // v1 is live: not rejected
        expect((await s.get("v1"))).toMatchObject({ status: "live", decided_by: "b1", live_at: at(21) });
        expect((await s.get("v4"))!.status).toBe("rejected");
        expect((await s.live(at(30), 30)).map((x) => x.id)).toEqual(["v2", "v1"]); // v3 is scheduled
        expect((await s.live(at(30), 1)).length).toBe(1);
        await s.recall("v1", "b1", at(31), "wrong video"); await s.recall("v4", "b1", at(31), "x");
        expect(await s.get("v1")).toMatchObject({ status: "recalled", recall_note: "wrong video" });
        expect((await s.get("v4"))!.status).toBe("rejected");
        expect(await s.pendingCount()).toBe(0);
      } finally { await done(); }
    });
    it("a play counts only on a live, listed item; corrections list withdrawn items that had been live", async () => {
      const { db, done } = await make();
      try {
        const s = new VideoStore(db);
        for (const n of [1, 2, 3]) await s.insert(vid(n));
        await s.approve("v1", "b1", at(20), at(21)); await s.approve("v2", "b1", at(20), at(50));
        expect(await s.countView("v1", at(30))).toBe(true);
        expect(await s.countView("v1", at(30))).toBe(true);
        expect(await s.countView("v2", at(30))).toBe(false); // scheduled
        expect(await s.countView("v3", at(30))).toBe(false); // pending
        expect((await s.get("v1"))!.views).toBe(2);
        await s.recall("v1", "b1", at(35), "withdrawn");
        await s.recall("v2", "b1", at(36), "never seen"); // live_at (at 50) is after decided_at: members never saw it
        const c = await s.corrections("2026-11-21T00:00:00.000Z");
        expect(c.map((x) => x.id)).toEqual(["v1"]);
        expect(c[0]).toMatchObject({ recall_note: "withdrawn", title_te: "వివరణ 🙂 1" });
        expect(await s.corrections("2026-12-01T00:00:00.000Z")).toEqual([]);
      } finally { await done(); }
    });
    it("silence windows: held items move to the end, ending a window releases them, only active windows are listed", async () => {
      const { db, done } = await make();
      try {
        const s = new VideoStore(db);
        await s.insert(vid(1)); await s.insert(vid(2));
        await s.approve("v1", "b1", at(1), at(10)); await s.approve("v2", "b1", at(1), at(55));
        await s.insertWindow({ id: "w1", label: "Polling day", starts_at: at(5), ends_at: at(50), created_by: "a1", at: at(2) });
        await s.insertWindow({ id: "w2", label: "Other", starts_at: at(0), ends_at: at(3), created_by: "a2", at: at(2) });
        expect((await s.activeWindows()).map((w) => w.id)).toEqual(["w2", "w1"]);
        await s.holdUntil(at(5), at(50));
        expect((await s.get("v1"))!.live_at).toBe(at(50));
        expect((await s.get("v2"))!.live_at).toBe(at(55));
        expect(await s.openWindow("w1")).toMatchObject({ created_by: "a1", ends_at: at(50) });
        await s.endWindow("w1", "b1", at(20));
        expect(await s.openWindow("w1")).toBeUndefined();
        await s.release(at(50), at(20), at(20));
        expect((await s.get("v1"))!.live_at).toBe(at(20));
        expect((await s.activeWindows()).map((w) => w.id)).toEqual(["w2"]);
      } finally { await done(); }
    });
    it("counts the signed-up people without the deleted ones", async () => {
      const { db, done } = await make();
      try {
        const p = (id: string, del: string | null) => db.run("INSERT INTO persons (id, created_at, eligible_from, deleted_at) VALUES (?,?,?,?)", [id, at(0), at(0), del]);
        await p("p1", null); await p("p2", null); await p("p3", at(1));
        expect(await new VideoStore(db).registeredUsers()).toBe(2);
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name.startsWith("vcast_") || x.tbl_name === "persons");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_vc_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
