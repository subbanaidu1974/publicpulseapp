import crypto from "node:crypto";
import { MysqlDb } from "./mysqlAdapter";
import type { Db } from "./types";

/**
 * Migration runner on the data layer (S-249). Same model as the legacy runner in server/civic/core/stores.ts: ordered ids, one `migrations`
 * table per store, a sha256 checksum of each applied migration's SQL, drift detection, idempotent re-runs. Additions:
 *  - a migration is per engine (`sql` is the text for that engine; give `{ sqlite, mysql }` when the DDL differs);
 *  - on MySQL the run holds an advisory lock (GET_LOCK) so only one server migrates at a time;
 *  - MySQL DDL commits implicitly, so a failed migration cannot be rolled back there: write migrations as expand steps that are safe to
 *    re-run (CREATE TABLE IF NOT EXISTS ...), and a failure stops the run with the migration id so it can be fixed and re-run.
 * Expand then contract: a migration that adds comes first; code switches; a later migration removes. Never edit an applied migration.
 */
export interface Migration { id: string; sql: string | { sqlite?: string; mysql?: string } }

export const checksumOf = (sql: string): string => crypto.createHash("sha256").update(sql).digest("hex");

function sqlFor(m: Migration, engine: Db["engine"]): string | null {
  if (typeof m.sql === "string") return m.sql;
  return m.sql[engine] ?? null;
}

export interface MigrationStatus { registered: number; applied: number; pending: string[]; drift: string[] }

const TABLE = "CREATE TABLE IF NOT EXISTS migrations (id VARCHAR(190) NOT NULL PRIMARY KEY, applied_at VARCHAR(24) NOT NULL, checksum CHAR(64) NOT NULL)";

export async function migrationStatus(db: Db, list: Migration[]): Promise<MigrationStatus> {
  await db.run(TABLE);
  const rows = await db.all<{ id: string; checksum: string }>("SELECT id, checksum FROM migrations");
  const have = new Map(rows.map((r) => [r.id, r.checksum]));
  const mine = list.filter((m) => sqlFor(m, db.engine) !== null);
  return {
    registered: mine.length, applied: rows.length,
    pending: mine.filter((m) => !have.has(m.id)).map((m) => m.id),
    drift: mine.filter((m) => have.has(m.id) && have.get(m.id) !== checksumOf(sqlFor(m, db.engine)!)).map((m) => m.id),
  };
}

export async function migrate(db: Db, list: Migration[], opts: { allowDrift?: boolean; lockName?: string } = {}): Promise<{ applied: string[] }> {
  let release: (() => Promise<void>) | null = null;
  if (db instanceof MysqlDb) {
    release = await db.lock(opts.lockName ?? "pp_migrate", 60);
    if (!release) throw new Error("another server is running migrations (could not get the migration lock in 60 seconds)");
  }
  try {
    const st = await migrationStatus(db, list);
    if (st.drift.length && !opts.allowDrift) throw new Error(`migration drift: applied migration(s) changed after being applied: ${st.drift.join(", ")} (never edit an applied migration; add a new one)`);
    const applied: string[] = [];
    for (const m of list) {
      const sql = sqlFor(m, db.engine);
      if (sql === null || !st.pending.includes(m.id)) continue;
      try {
        if (db.engine === "sqlite") {
          await db.tx(async (tx) => { await tx.exec(sql); await tx.run("INSERT INTO migrations (id, applied_at, checksum) VALUES (?, ?, ?)", [m.id, new Date().toISOString(), checksumOf(sql)]); });
        } else {
          await db.exec(sql);
          await db.run("INSERT INTO migrations (id, applied_at, checksum) VALUES (?, ?, ?)", [m.id, new Date().toISOString(), checksumOf(sql)]);
        }
      } catch (e) {
        throw new Error(`migration ${m.id} failed: ${(e as Error).message}`);
      }
      applied.push(m.id);
    }
    return { applied };
  } finally { if (release) await release(); }
}
