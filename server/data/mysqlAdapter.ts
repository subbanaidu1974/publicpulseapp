import mysql, { type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";
import { DbError, ident, type Db, type Param, type RunResult } from "./types";

export interface MysqlConfig {
  host: string; port?: number; user: string; password: string; database: string;
  /** Connections per instance (default 10). */
  poolSize?: number;
  /** TLS on (required in production; the default is on unless host is localhost or 127.0.0.1). */
  ssl?: boolean;
}

/** Parse mysql://user:pass@host:port/database (test and deployment configuration). */
export function parseMysqlUrl(url: string, database?: string): MysqlConfig {
  const u = new URL(url);
  return { host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: database ?? (u.pathname.replace(/^\//, "") || "mysql") };
}

function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  const err = e as { code?: string; errno?: number; message?: string };
  const code = err.errno ?? err.code;
  let kind: DbError["kind"] = "other";
  switch (err.errno) {
    case 1062: kind = "unique"; break;
    case 1451: case 1452: kind = "foreign_key"; break;
    case 1048: kind = "not_null"; break;
    case 3819: kind = "check"; break;
    case 1213: kind = "deadlock"; break;
    case 1205: kind = "lock_timeout"; break;
  }
  return new DbError(kind, String(err.message ?? e), code, e);
}

const bind = (p?: Param[]): (string | number | bigint | null)[] => (p ?? []).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));

function upsertSql(table: string, row: Record<string, Param>, keys: string[], update?: string[] | "none"): { sql: string; params: Param[] } {
  const cols = Object.keys(row).map(ident);
  if (!cols.length) throw new Error("upsert needs at least one column");
  for (const k of keys) if (!cols.includes(ident(k))) throw new Error(`upsert key "${k}" is not in the row`);
  const set = update === "none" ? null : (update ?? cols.filter((c) => !keys.includes(c))).map(ident);
  // "none" and an empty update list both become a no-op assignment of the first key to itself (not INSERT IGNORE, which would hide unrelated errors).
  const tail = !set || !set.length ? `${keys[0]} = ${ident(table)}.${keys[0]}` : set.map((c) => `${c} = new_row.${c}`).join(", ");
  return { sql: `INSERT INTO ${ident(table)} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) AS new_row ON DUPLICATE KEY UPDATE ${tail}`, params: cols.map((c) => row[c]) };
}

type Exec = Pool | PoolConnection;

async function run1(x: Exec, sql: string, p?: Param[]): Promise<RunResult> {
  try {
    const [r] = await x.query(sql, bind(p));
    const h = r as { affectedRows?: number; insertId?: number };
    return { changes: Number(h.affectedRows ?? 0), lastId: /^\s*insert/i.test(sql) && h.insertId ? Number(h.insertId) : null };
  } catch (e) { throw toDbError(e); }
}

/** A handle on ONE connection inside a transaction; tx() opens a savepoint. */
class MysqlTx implements Db {
  readonly engine = "mysql" as const;
  private sp = 0;
  constructor(private c: PoolConnection) {}
  async get<T>(sql: string, p?: Param[]) { const rows = await this.all<T>(sql, p); return rows[0]; }
  async all<T>(sql: string, p?: Param[]) { try { const [r] = await this.c.query(sql, bind(p)); return r as T[]; } catch (e) { throw toDbError(e); } }
  run(sql: string, p?: Param[]) { return run1(this.c, sql, p); }
  async exec(sql: string) { try { await this.c.query(sql); } catch (e) { throw toDbError(e); } }
  async upsert(table: string, row: Record<string, Param>, keys: string[], update?: string[] | "none") { const u = upsertSql(table, row, keys, update); return run1(this.c, u.sql, u.params); }
  forUpdate(sql: string) { return sql + " FOR UPDATE"; }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const name = "sp_" + this.sp++;
    await this.c.query("SAVEPOINT " + name);
    try { const r = await fn(this); await this.c.query("RELEASE SAVEPOINT " + name); return r; }
    catch (e) { try { await this.c.query("ROLLBACK TO SAVEPOINT " + name); } catch { /* connection gone */ } throw e; }
    finally { this.sp--; }
  }
  async close() { /* the owner releases */ }
}

export class MysqlDb implements Db {
  readonly engine = "mysql" as const;
  private pool: Pool;
  private opts: PoolOptions;
  constructor(cfg: MysqlConfig) {
    const local = cfg.host === "localhost" || cfg.host === "127.0.0.1";
    const opts: PoolOptions = {
      host: cfg.host, port: cfg.port ?? 3306, user: cfg.user, password: cfg.password, database: cfg.database,
      connectionLimit: cfg.poolSize ?? 10, waitForConnections: true, queueLimit: 200, connectTimeout: 10_000,
      charset: "utf8mb4", timezone: "Z",
      // CLIENT_FOUND_ROWS: an UPDATE that sets a column to its current value still counts as a matched row, as in SQLite.
      flags: ["+FOUND_ROWS"],
      // Counts and ids as numbers; no BigInt surprises. Timestamps are text columns (see types.ts), so nothing is converted.
      supportBigNumbers: true, bigNumberStrings: false, dateStrings: true, decimalNumbers: true,
      ssl: (cfg.ssl ?? !local) ? { rejectUnauthorized: true } : undefined,
    };
    this.opts = opts;
    this.pool = mysql.createPool(opts);
  }
  async get<T>(sql: string, p?: Param[]) { const rows = await this.all<T>(sql, p); return rows[0]; }
  async all<T>(sql: string, p?: Param[]) { try { const [r] = await this.pool.query(sql, bind(p)); return r as T[]; } catch (e) { throw toDbError(e); } }
  run(sql: string, p?: Param[]) { return run1(this.pool, sql, p); }
  async exec(sql: string) {
    // Multi-statement text needs its own connection with multipleStatements on.
    const c = await mysql.createConnection({ host: this.opts.host, port: this.opts.port, user: this.opts.user, password: this.opts.password, database: this.opts.database, charset: "utf8mb4", ssl: this.opts.ssl, multipleStatements: true });
    try { await c.query(sql); } catch (e) { throw toDbError(e); } finally { await c.end(); }
  }
  async upsert(table: string, row: Record<string, Param>, keys: string[], update?: string[] | "none") { const u = upsertSql(table, row, keys, update); return run1(this.pool, u.sql, u.params); }
  forUpdate(sql: string) { return sql + " FOR UPDATE"; }
  async tx<T>(fn: (tx: Db) => Promise<T>, opts: { retries?: number } = {}): Promise<T> {
    const attempts = Math.max(1, opts.retries ?? 3);
    for (let n = 1; ; n++) {
      let c: PoolConnection;
      try { c = await this.pool.getConnection(); } catch (e) { throw toDbError(e); }
      try {
        await c.query("START TRANSACTION");
        const r = await fn(new MysqlTx(c));
        await c.query("COMMIT");
        return r;
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch { /* connection gone */ }
        const de = toDbError(e);
        if ((de.kind === "deadlock" || de.kind === "lock_timeout") && n < attempts) { await new Promise((r) => setTimeout(r, 20 * n + Math.random() * 30)); continue; }
        throw de;
      } finally { c.release(); }
    }
  }
  /** Advisory lock for jobs that must run on one server at a time (migrations). Returns a release function, or null when not obtained in time. */
  async lock(name: string, seconds = 60): Promise<(() => Promise<void>) | null> {
    const c = await this.pool.getConnection();
    const [r] = await c.query("SELECT GET_LOCK(?, ?) AS got", [name, seconds]);
    if (!(r as { got: number }[])[0]?.got) { c.release(); return null; }
    return async () => { try { await c.query("SELECT RELEASE_LOCK(?)", [name]); } finally { c.release(); } };
  }
  async close() { await this.pool.end(); }
}
