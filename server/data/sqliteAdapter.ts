import { DatabaseSync } from "node:sqlite";
import { DbError, ident, type Db, type Param, type RunResult } from "./types";

function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  const err = e as { message?: string; code?: string; errcode?: number; errstr?: string };
  const m = String(err.message ?? e);
  const code = err.errstr || err.code;
  let kind: DbError["kind"] = "other";
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(m)) kind = "unique";
  else if (/FOREIGN KEY constraint failed/i.test(m)) kind = "foreign_key";
  else if (/NOT NULL constraint failed/i.test(m)) kind = "not_null";
  else if (/CHECK constraint failed/i.test(m)) kind = "check";
  else if (/database is locked|SQLITE_BUSY/i.test(m)) kind = "lock_timeout";
  return new DbError(kind, m, code, e);
}

const bind = (p?: Param[]): (string | number | bigint | null)[] => (p ?? []).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));

/** Core statements on one DatabaseSync handle, no locking (the caller serialises). */
class Conn {
  constructor(public h: DatabaseSync) {}
  get<T>(sql: string, p?: Param[]): T | undefined { try { return this.h.prepare(sql).get(...bind(p)) as T | undefined; } catch (e) { throw toDbError(e); } }
  all<T>(sql: string, p?: Param[]): T[] { try { return this.h.prepare(sql).all(...bind(p)) as T[]; } catch (e) { throw toDbError(e); } }
  run(sql: string, p?: Param[]): RunResult {
    try {
      const r = this.h.prepare(sql).run(...bind(p));
      return { changes: Number(r.changes), lastId: /^\s*insert/i.test(sql) ? Number(r.lastInsertRowid) : null };
    } catch (e) { throw toDbError(e); }
  }
  exec(sql: string): void { try { this.h.exec(sql); } catch (e) { throw toDbError(e); } }
}

function upsertSql(table: string, row: Record<string, Param>, keys: string[], update?: string[] | "none"): { sql: string; params: Param[] } {
  const cols = Object.keys(row).map(ident);
  if (!cols.length) throw new Error("upsert needs at least one column");
  for (const k of keys) if (!cols.includes(ident(k))) throw new Error(`upsert key "${k}" is not in the row`);
  const set = update === "none" ? null : (update ?? cols.filter((c) => !keys.includes(c))).map(ident);
  const tail = !set || !set.length ? "DO NOTHING" : "DO UPDATE SET " + set.map((c) => `${c} = excluded.${c}`).join(", ");
  return { sql: `INSERT INTO ${ident(table)} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT (${keys.map(ident).join(", ")}) ${tail}`, params: cols.map((c) => row[c]) };
}

/** A handle for use inside a transaction: statements run directly on the (already locked) connection; tx() opens a savepoint. */
class SqliteTx implements Db {
  readonly engine = "sqlite" as const;
  private sp = 0;
  constructor(private c: Conn) {}
  async get<T>(sql: string, p?: Param[]) { return this.c.get<T>(sql, p); }
  async all<T>(sql: string, p?: Param[]) { return this.c.all<T>(sql, p); }
  async run(sql: string, p?: Param[]) { return this.c.run(sql, p); }
  async exec(sql: string) { this.c.exec(sql); }
  async upsert(table: string, row: Record<string, Param>, keys: string[], update?: string[] | "none") { const u = upsertSql(table, row, keys, update); return this.c.run(u.sql, u.params); }
  forUpdate(sql: string) { return sql; }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const name = "sp_" + this.sp++;
    this.c.exec("SAVEPOINT " + name);
    try { const r = await fn(this); this.c.exec("RELEASE " + name); return r; }
    catch (e) { try { this.c.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* already gone */ } throw e; }
    finally { this.sp--; }
  }
  async close() { /* the owner closes */ }
}

/** SQLite engine. All calls go through one queue, so a transaction is never interleaved with another statement on the same handle. */
export class SqliteDb implements Db {
  readonly engine = "sqlite" as const;
  private c: Conn;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(handle: DatabaseSync, private owns = true) { this.c = new Conn(handle); }
  /** Open (or create) a database file, or ":memory:". Foreign keys on; WAL for files. */
  static open(file: string): SqliteDb {
    const h = new DatabaseSync(file);
    h.exec("PRAGMA foreign_keys = ON;");
    if (file !== ":memory:") h.exec("PRAGMA journal_mode = WAL;");
    return new SqliteDb(h);
  }
  private queue<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next as Promise<T>;
  }
  get<T>(sql: string, p?: Param[]) { return this.queue(() => this.c.get<T>(sql, p)); }
  all<T>(sql: string, p?: Param[]) { return this.queue(() => this.c.all<T>(sql, p)); }
  run(sql: string, p?: Param[]) { return this.queue(() => this.c.run(sql, p)); }
  exec(sql: string) { return this.queue(() => this.c.exec(sql)); }
  async upsert(table: string, row: Record<string, Param>, keys: string[], update?: string[] | "none") { const u = upsertSql(table, row, keys, update); return this.queue(() => this.c.run(u.sql, u.params)); }
  forUpdate(sql: string) { return sql; }
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      this.c.exec("BEGIN IMMEDIATE");
      try { const r = await fn(new SqliteTx(this.c)); this.c.exec("COMMIT"); return r; }
      catch (e) { try { this.c.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
    });
  }
  async close() { await this.tail; if (this.owns) { try { this.c.h.close(); } catch { /* ignore */ } } }
}
