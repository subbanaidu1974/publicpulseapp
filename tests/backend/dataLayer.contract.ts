import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DbError, migrate, migrationStatus, type Db, type Migration } from "../../server/data";

/**
 * Contract suite for the data layer (S-248, S-249). The same tests run on SQLite (always) and MySQL (when MYSQL_TEST_URL is set), so a
 * behaviour that differs between engines fails here before any store is ported. Tag: @E2E-247.
 */
export function runContract(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`data layer contract: ${label} @E2E-247`, () => {
    let db: Db; let done: () => Promise<void>;
    beforeEach(async () => {
      ({ db, done } = await make());
      await db.exec(`
        CREATE TABLE item (id VARCHAR(36) NOT NULL PRIMARY KEY, name VARCHAR(100) NOT NULL, qty INT NOT NULL DEFAULT 0, ts VARCHAR(24) NOT NULL, flag TINYINT NOT NULL DEFAULT 0, note TEXT,
          CONSTRAINT item_qty_ok CHECK (qty >= 0));
        CREATE TABLE child (id VARCHAR(36) NOT NULL PRIMARY KEY, item_id VARCHAR(36) NOT NULL, FOREIGN KEY (item_id) REFERENCES item(id));
        CREATE TABLE counter (id INT NOT NULL PRIMARY KEY, n INT NOT NULL);
        INSERT INTO counter (id, n) VALUES (1, 0);
      `);
    });
    afterEach(async () => { await done(); });

    it("inserts, reads one row, reads many, and reports changes", async () => {
      const ins = await db.run("INSERT INTO item (id, name, qty, ts) VALUES (?, ?, ?, ?)", ["a", "alpha", 1, "2026-11-27T10:00:00.000Z"]);
      expect(ins.changes).toBe(1);
      await db.run("INSERT INTO item (id, name, qty, ts) VALUES (?, ?, ?, ?)", ["b", "beta", 2, "2026-11-27T11:00:00.000Z"]);
      expect(await db.get<{ name: string }>("SELECT name FROM item WHERE id = ?", ["a"])).toEqual({ name: "alpha" });
      expect(await db.get("SELECT name FROM item WHERE id = ?", ["zz"])).toBeUndefined();
      expect((await db.all<{ id: string }>("SELECT id FROM item ORDER BY id")).map((r) => r.id)).toEqual(["a", "b"]);
      expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM item"))!.c).toBe(2);
    });

    it("UPDATE and DELETE report matched rows, even when a value does not change (CLIENT_FOUND_ROWS)", async () => {
      await db.run("INSERT INTO item (id, name, qty, ts) VALUES ('a', 'alpha', 1, '2026-11-27T10:00:00.000Z')");
      expect((await db.run("UPDATE item SET qty = 1 WHERE id = 'a'")).changes).toBe(1);
      expect((await db.run("UPDATE item SET qty = 5 WHERE id = 'nope'")).changes).toBe(0);
      expect((await db.run("DELETE FROM item WHERE id = 'a'")).changes).toBe(1);
    });

    it("upsert updates on a duplicate key, or does nothing when asked", async () => {
      const row = { id: "a", name: "alpha", qty: 1, ts: "2026-11-27T10:00:00.000Z" };
      await db.upsert("item", row, ["id"]);
      await db.upsert("item", { ...row, name: "changed", qty: 9 }, ["id"]);
      expect(await db.get("SELECT name, qty FROM item WHERE id = 'a'")).toEqual({ name: "changed", qty: 9 });
      await db.upsert("item", { ...row, name: "ignored" }, ["id"], "none");
      expect((await db.get<{ name: string }>("SELECT name FROM item WHERE id = 'a'"))!.name).toBe("changed");
      await db.upsert("item", { ...row, name: "partial", qty: 77 }, ["id"], ["name"]);
      expect(await db.get("SELECT name, qty FROM item WHERE id = 'a'")).toEqual({ name: "partial", qty: 9 });
    });

    it("refuses an unsafe identifier in upsert", async () => {
      await expect(db.upsert("item; DROP TABLE item", { id: "x" }, ["id"])).rejects.toThrow(/unsafe SQL identifier/);
    });

    it("reports constraint failures with a portable kind", async () => {
      await db.run("INSERT INTO item (id, name, qty, ts) VALUES ('a', 'alpha', 1, 'x')");
      const kind = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof DbError ? e.kind : "plain:" + String(e); } };
      expect(await kind(db.run("INSERT INTO item (id, name, qty, ts) VALUES ('a', 'dup', 1, 'x')"))).toBe("unique");
      expect(await kind(db.run("INSERT INTO item (id, name, qty, ts) VALUES ('c', NULL, 1, 'x')"))).toBe("not_null");
      expect(await kind(db.run("INSERT INTO item (id, name, qty, ts) VALUES ('d', 'neg', -1, 'x')"))).toBe("check");
      expect(await kind(db.run("INSERT INTO child (id, item_id) VALUES ('k', 'missing')"))).toBe("foreign_key");
    });

    it("text round-trips: Telugu, emoji, quotes; ISO timestamps sort as text; case of values is kept", async () => {
      const names = ["సాక్షి టీవీ", "తెలంగాణ 🎥", "O'Brien \"x\"", "MixedCase"];
      const ts = ["2026-11-27T09:00:00.000Z", "2026-11-27T10:00:00.000Z", "2026-11-26T23:59:59.999Z", "2026-11-28T00:00:00.000Z"];
      for (let i = 0; i < names.length; i++) await db.run("INSERT INTO item (id, name, qty, ts, note) VALUES (?, ?, ?, ?, ?)", ["id" + i, names[i], i, ts[i], JSON.stringify({ n: names[i] })]);
      expect((await db.all<{ name: string }>("SELECT name FROM item ORDER BY id")).map((r) => r.name)).toEqual(names);
      expect((await db.all<{ ts: string }>("SELECT ts FROM item ORDER BY ts")).map((r) => r.ts)).toEqual([...ts].sort());
      expect((await db.all<{ id: string }>("SELECT id FROM item WHERE ts >= ? AND ts < ? ORDER BY id", ["2026-11-27T00:00:00.000Z", "2026-11-28T00:00:00.000Z"])).map((r) => r.id)).toEqual(["id0", "id1"]);
      expect(JSON.parse((await db.get<{ note: string }>("SELECT note FROM item WHERE id = 'id1'"))!.note)).toEqual({ n: names[1] });
    });

    it("booleans bind as 0 and 1", async () => {
      await db.run("INSERT INTO item (id, name, qty, ts, flag) VALUES (?, 'f', 0, 'x', ?)", ["t", true]);
      await db.run("INSERT INTO item (id, name, qty, ts, flag) VALUES (?, 'f', 0, 'x', ?)", ["f", false]);
      expect((await db.all<{ id: string; flag: number }>("SELECT id, flag FROM item ORDER BY id")).map((r) => [r.id, Number(r.flag)])).toEqual([["f", 0], ["t", 1]]);
    });

    it("a transaction commits all its statements, or none when it throws", async () => {
      await db.tx(async (tx) => { await tx.run("INSERT INTO item (id, name, qty, ts) VALUES ('a', 'a', 1, 'x')"); await tx.run("INSERT INTO item (id, name, qty, ts) VALUES ('b', 'b', 1, 'x')"); });
      expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM item"))!.c).toBe(2);
      await expect(db.tx(async (tx) => { await tx.run("INSERT INTO item (id, name, qty, ts) VALUES ('c', 'c', 1, 'x')"); throw new Error("boom"); })).rejects.toThrow("boom");
      expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM item"))!.c).toBe(2);
      await expect(db.tx(async (tx) => { await tx.run("INSERT INTO item (id, name, qty, ts) VALUES ('d', 'd', 1, 'x')"); await tx.run("INSERT INTO item (id, name, qty, ts) VALUES ('d', 'dup', 1, 'x')"); })).rejects.toBeInstanceOf(DbError);
      expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM item"))!.c).toBe(2);
    });

    it("a nested transaction is a savepoint: its rollback keeps the outer work", async () => {
      await db.tx(async (tx) => {
        await tx.run("INSERT INTO item (id, name, qty, ts) VALUES ('outer', 'o', 1, 'x')");
        await expect(tx.tx(async (inner) => { await inner.run("INSERT INTO item (id, name, qty, ts) VALUES ('inner', 'i', 1, 'x')"); throw new Error("inner fails"); })).rejects.toThrow("inner fails");
        await tx.tx(async (inner) => { await inner.run("INSERT INTO item (id, name, qty, ts) VALUES ('inner2', 'i2', 1, 'x')"); });
      });
      expect((await db.all<{ id: string }>("SELECT id FROM item ORDER BY id")).map((r) => r.id)).toEqual(["inner2", "outer"]);
    });

    it("concurrent read-modify-write transactions with forUpdate never lose an update", async () => {
      const N = 25;
      await Promise.all(Array.from({ length: N }, () => db.tx(async (tx) => {
        const r = await tx.get<{ n: number }>(tx.forUpdate("SELECT n FROM counter WHERE id = 1"));
        await tx.run("UPDATE counter SET n = ? WHERE id = 1", [Number(r!.n) + 1]);
      }, { retries: 10 })));
      expect(Number((await db.get<{ n: number }>("SELECT n FROM counter WHERE id = 1"))!.n)).toBe(N);
    });

    it("one-per-person style rule: concurrent duplicate inserts leave exactly one row and the rest fail as unique", async () => {
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => db.run("INSERT INTO item (id, name, qty, ts) VALUES ('same', 's', 1, 'x')")));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected" && (r.reason as DbError).kind === "unique")).toHaveLength(9);
    });

    describe("migrations", () => {
      const M: Migration[] = [
        { id: "001_make", sql: "CREATE TABLE IF NOT EXISTS widget (id VARCHAR(36) NOT NULL PRIMARY KEY, label VARCHAR(50) NOT NULL)" },
        { id: "002_more", sql: "CREATE TABLE IF NOT EXISTS gadget (id VARCHAR(36) NOT NULL PRIMARY KEY)" },
      ];
      it("applies in order once, stores checksums, and re-running does nothing", async () => {
        expect((await migrate(db, M)).applied).toEqual(["001_make", "002_more"]);
        expect((await migrate(db, M)).applied).toEqual([]);
        const st = await migrationStatus(db, M);
        expect([st.registered, st.applied, st.pending, st.drift]).toEqual([2, 2, [], []]);
        expect(((await db.get<{ checksum: string }>("SELECT checksum FROM migrations WHERE id = '001_make'"))!.checksum)).toMatch(/^[0-9a-f]{64}$/);
        await db.run("INSERT INTO widget (id, label) VALUES ('w', 'ok')");
      });
      it("picks up only new migrations later", async () => {
        await migrate(db, M.slice(0, 1));
        expect((await migrate(db, M)).applied).toEqual(["002_more"]);
      });
      it("refuses an edited applied migration (drift) unless told to allow it", async () => {
        await migrate(db, M);
        const edited = [{ id: "001_make", sql: "CREATE TABLE IF NOT EXISTS widget (id VARCHAR(36) NOT NULL PRIMARY KEY, label VARCHAR(80) NOT NULL)" }, M[1]];
        expect((await migrationStatus(db, edited)).drift).toEqual(["001_make"]);
        await expect(migrate(db, edited)).rejects.toThrow(/drift/);
        await expect(migrate(db, edited, { allowDrift: true })).resolves.toBeTruthy();
      });
      it("a failing migration names its id and is not recorded", async () => {
        const bad: Migration[] = [{ id: "001_bad", sql: "CREATE TABLE nope (" }];
        await expect(migrate(db, bad)).rejects.toThrow(/migration 001_bad failed/);
        expect((await migrationStatus(db, bad)).pending).toEqual(["001_bad"]);
      });
      it("an engine-specific migration is skipped on the other engine", async () => {
        const only: Migration[] = [{ id: "001_x", sql: { sqlite: "CREATE TABLE only_sqlite (id VARCHAR(10) PRIMARY KEY)", mysql: "CREATE TABLE only_mysql (id VARCHAR(10) PRIMARY KEY)" } }, { id: "002_y", sql: { sqlite: "CREATE TABLE sq_only (id VARCHAR(10) PRIMARY KEY)" } }];
        const r = await migrate(db, only);
        expect(r.applied).toEqual(db.engine === "sqlite" ? ["001_x", "002_y"] : ["001_x"]);
        await db.run(`INSERT INTO ${db.engine === "sqlite" ? "only_sqlite" : "only_mysql"} (id) VALUES ('a')`);
      });
    });
  });
}
