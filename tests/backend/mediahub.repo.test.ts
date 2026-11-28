import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { MediaHubStore } from "../../server/data/repos/mediahub";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Seventh identity module on the data layer (S-250): the media hub. Runs on SQLite and, when MYSQL_TEST_URL is set, MySQL 8.4. */
const at = (n: number): string => `2026-11-28T10:00:${String(n).padStart(2, "0")}.000Z`;
const src = (id: string, o: Record<string, string | number | null> = {}) => ({ id, kind: "news", name_en: "Outlet " + id, name_te: "అవుట్‌లెట్ 🙂", site_url: "https://x.example/", feed_url: "https://x.example/feed", allow: "headline", state: "BOTH", created_by: "a1", created_at: at(1), ...o });
const news = (n: number, source: string, o: { link?: string; published?: string } = {}) => ({ id: "n" + n, source_id: source, title: "Headline " + n, link: o.link ?? `https://x.example/story-${n}`, snippet: null, published_at: o.published ?? at(n), fetched_at: at(n) });

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`media hub repository on ${label} @E2E-258`, { timeout: 60_000 }, () => {
    it("sources: added switched off, permission recorded, switched on and off, numbers as numbers, Telugu intact, newest first", async () => {
      const { db, done } = await make();
      try {
        const s = new MediaHubStore(db);
        await s.insertSource(src("s1")); await s.insertSource(src("s2", { created_at: at(5) }));
        expect(await s.source("s1")).toMatchObject({ enabled: 0, health_ok: null, name_te: "అవుట్‌లెట్ 🙂", permission_note: null });
        expect(await s.source("nope")).toBeUndefined();
        expect(await s.sourceExists("s1")).toBe(true);
        await expect(s.insertSource(src("s1"))).rejects.toMatchObject({ kind: "unique" });
        await s.setPermission("s1", "Written OK from the editor", "2026-11-01", "ed@x.example", "a2");
        await s.enable("s1", "b1", at(9));
        const r = (await s.source("s1"))!;
        expect(r).toMatchObject({ enabled: 1, enabled_by: "b1", permission_by: "a2" });
        expect(typeof r.enabled).toBe("number");
        expect((await s.allSources()).map((x) => x.id)).toEqual(["s2", "s1"]);
        expect((await s.enabledNewsSources()).map((x) => x.id)).toEqual(["s1"]);
        await s.disable("s1");
        expect((await s.enabledNewsSources())).toEqual([]);
        await s.insertSource(src("l1", { kind: "live", feed_url: null, stream_url: "https://s.example/a.m3u8", enabled: 1 }));
        await s.setHealth("l1", true, at(7));
        expect((await s.enabledLive())[0]).toMatchObject({ id: "l1", health_ok: 1, health_at: at(7) });
        expect(typeof (await s.enabledLive())[0].health_ok).toBe("number");
      } finally { await done(); }
    });
    it("fetching: due sources, a fetch mark, ok and error marks, a story seen again is not added twice, old news is deleted", async () => {
      const { db, done } = await make();
      try {
        const s = new MediaHubStore(db);
        await s.insertSource(src("s1", { enabled: 1 })); await s.insertSource(src("s2", { enabled: 1, feed_url: null })); await s.insertSource(src("s3"));
        expect(await s.dueIds(at(30))).toEqual(["s1"]);
        await s.markFetch("s1", at(40));
        expect(await s.dueIds(at(30))).toEqual([]);
        expect(await s.dueIds(at(50))).toEqual(["s1"]);
        await s.markError("s1", "the source answered 500");
        expect(await s.source("s1")).toMatchObject({ last_error: "the source answered 500", last_fetch_at: at(40) });
        await s.markOk("s1", at(41));
        expect(await s.source("s1")).toMatchObject({ last_error: null, last_ok_at: at(41) });
        expect(await s.addNewsIfNew(news(1, "s1"))).toBe(true);
        expect(await s.addNewsIfNew({ ...news(2, "s1"), link: news(1, "s1").link })).toBe(false);
        expect(await s.addNewsIfNew(news(3, "s2"))).toBe(true);
        await s.insertNews(news(4, "s1", { published: "2026-11-01T00:00:00.000Z" }));
        await s.deleteNewsBefore("2026-11-20T00:00:00.000Z");
        expect(await s.newsExists("n4")).toBe(false);
        expect(await s.newsExists("n1")).toBe(true);
        await s.refreshNews({ ...news(9, "s1"), link: news(1, "s1").link, title: "Updated", published_at: at(55) });
        expect(await s.newsTitle("n1")).toBe("Updated");
        await s.clearFeed("s1", at(56));
        expect(await s.source("s1")).toMatchObject({ feed_url: null, last_ok_at: at(56) });
      } finally { await done(); }
    });
    it("the news list: enabled sources only, visible items only, state filter, headlines and videos read apart, newest first", async () => {
      const { db, done } = await make();
      try {
        const s = new MediaHubStore(db);
        await s.insertSource(src("ap", { enabled: 1, state: "AP" })); await s.insertSource(src("tg", { enabled: 1, state: "TG" })); await s.insertSource(src("off", { enabled: 0 })); await s.insertSource(src("both", { enabled: 1 }));
        const yt = "https://www.youtube.com/watch?v=abcdefghijk";
        await s.insertNews(news(1, "ap")); await s.insertNews(news(2, "tg")); await s.insertNews(news(3, "off")); await s.insertNews(news(4, "both"));
        await s.insertNews(news(5, "ap", { link: yt })); await s.insertNews(news(6, "ap", { published: "2026-11-01T00:00:00.000Z" }));
        const since = "2026-11-21T00:00:00.000Z";
        expect((await s.newsRows(since, null, false, 100)).map((r) => r.id)).toEqual(["n4", "n2", "n1"]);
        expect((await s.newsRows(since, "AP", false, 100)).map((r) => r.id)).toEqual(["n4", "n1"]);
        expect((await s.newsRows(since, "TG", false, 100)).map((r) => r.id)).toEqual(["n4", "n2"]);
        expect((await s.newsRows(since, null, true, 100)).map((r) => r.id)).toEqual(["n5"]);
        expect((await s.newsRows(since, null, false, 1)).length).toBe(1);
        expect((await s.newsRows(since, null, false, 100))[2]).toMatchObject({ sid: "ap", name_en: "Outlet ap", name_te: "అవుట్‌లెట్ 🙂" });
        await s.hideNews("n4");
        expect((await s.newsRows(since, null, false, 100)).map((r) => r.id)).toEqual(["n2", "n1"]);
        expect(await s.newsClickable("n1")).toBe(true);
        expect(await s.newsClickable("n4")).toBe(false);
        expect(await s.newsClickable("n3")).toBe(false);
      } finally { await done(); }
    });
    it("clicks: the first makes the row, later ones add to it, per day, totals as numbers; names are looked up", async () => {
      const { db, done } = await make();
      try {
        const s = new MediaHubStore(db);
        await s.insertSource(src("s1", { enabled: 1 })); await s.insertNews(news(1, "s1"));
        await s.insertSource(src("l1", { kind: "live", feed_url: null, enabled: 1 }));
        expect(await s.liveClickable("l1")).toBe(true);
        expect(await s.liveClickable("s1")).toBe(false);
        await Promise.all([s.bump("news", "n1", "2026-11-27"), s.bump("news", "n1", "2026-11-27")]);
        await s.bump("news", "n1", "2026-11-28"); await s.bump("live", "l1", "2026-11-28");
        const c = await s.counts();
        const n1 = c.find((x) => x.item_id === "n1")!;
        expect(n1).toMatchObject({ kind: "news", total: 3, last_day: "2026-11-28" });
        expect(typeof n1.total).toBe("number");
        expect(c.find((x) => x.item_id === "l1")!.total).toBe(1);
        expect(await s.newsTitle("n1")).toBe("Headline 1");
        expect(await s.sourceName("l1")).toBe("Outlet l1");
        expect(await s.sourceName("zz")).toBeUndefined();
      } finally { await done(); }
    });
    it("reports: one per person per item, listed open first, resolving closes every open one on the item; videos counted for the numbers", async () => {
      const { db, done } = await make();
      try {
        const s = new MediaHubStore(db);
        await s.insertSource(src("s1", { enabled: 1 })); await s.insertNews(news(1, "s1"));
        const rep = (id: string, reporter: string, n: number) => s.addReport({ id, kind: "news", item_id: "n1", reason: "wrong", note: n ? "note ఇది" : null, reporter, at: at(n) });
        expect(await rep("r1", "h1", 1)).toBe(true);
        expect(await rep("r2", "h1", 2)).toBe(false);
        expect(await rep("r3", "h2", 3)).toBe(true);
        expect(await s.addReport({ id: "r4", kind: "live", item_id: "n1", reason: "wrong", note: null, reporter: "h1", at: at(4) })).toBe(true);
        expect(await s.openReport("r1")).toEqual({ kind: "news", item_id: "n1" });
        expect(await s.openReport("nope")).toBeUndefined();
        await s.closeReports("news", "n1", "a1", at(9), "takedown");
        expect(await s.openReport("r1")).toBeUndefined();
        expect(await s.openReport("r3")).toBeUndefined();
        expect(await s.openReport("r4")).toBeDefined();
        const list = await s.reports();
        expect(list.map((r) => r.id)).toEqual(["r4", "r3", "r1"]);
        expect(list[2]).toMatchObject({ status: "resolved", resolution: "takedown", note: "note ఇది" });
        expect(await s.liveExists("n1")).toBe(false);
        expect(await s.videoExists("v1")).toBe(false);
        await db.run("INSERT INTO vcast_videos (id,title_en,media_url,kind,credit,status,created_by,created_at,views) VALUES ('v1','T','https://m.example/a.mp4','video','c','live','a1',?,12)", [at(1)]);
        expect(await s.videoExists("v1")).toBe(true);
        expect(await s.countedVideos()).toEqual([{ id: "v1", title_en: "T", views: 12 }]);
      } finally { await done(); }
    });
    it("development preview: switches candidates on with a note, only unrecorded ones, and puts them back without touching an admin's", async () => {
      const { db, done } = await make();
      try {
        const s = new MediaHubStore(db);
        await s.insertSource(src("cand-1")); await s.insertSource(src("cand-2", { permission_note: "real permission", permission_date: "2026-10-01", contact: "c@x.example" })); await s.insertSource(src("other"));
        await s.previewOn(at(5), "PREVIEW ONLY", "2026-11-28");
        expect(await s.source("cand-1")).toMatchObject({ enabled: 1, enabled_by: "preview-setting", permission_note: "PREVIEW ONLY", contact: "preview@example.invalid" });
        expect(await s.source("cand-2")).toMatchObject({ enabled: 0, permission_note: "real permission" });
        expect(await s.source("other")).toMatchObject({ enabled: 0 });
        await s.previewOff();
        expect(await s.source("cand-1")).toMatchObject({ enabled: 0, enabled_by: null, permission_note: null, contact: null });
        expect(await s.source("cand-2")).toMatchObject({ permission_note: "real permission" });
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name.startsWith("mhub_") || x.tbl_name === "vcast_videos");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_mh_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
