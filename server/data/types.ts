/**
 * Async data-access layer (S-248). One small interface, two engines: SQLite (node:sqlite, fast local and unit tests) and MySQL (mysql2,
 * CI and production). Code written against `Db` runs on both; the shared contract suite (tests/backend/dataLayer.contract.ts) proves it.
 *
 * Rules that keep SQL portable (docs/backend/DATA_MODEL_MYSQL.md section 3):
 *  - `?` placeholders only; identifiers are plain lower_snake_case.
 *  - Timestamps are 24-character ISO UTC strings in VARCHAR(24) columns ("2026-11-27T10:00:00.000Z"): they sort and compare as text on both engines.
 *  - JSON is stored as TEXT. Booleans are 0/1 integers. Ids are app-generated strings.
 *  - Use `upsert()` instead of INSERT OR IGNORE / OR REPLACE / ON CONFLICT, and `forUpdate()` to lock a row read inside a transaction.
 *  - A store is reached through exactly one path: the legacy synchronous handle (server/civic/core) or this layer, never both at once.
 */
export type Param = string | number | bigint | null | boolean;

export interface RunResult {
  /** Rows matched by an UPDATE or DELETE (MySQL runs with CLIENT_FOUND_ROWS so this matches SQLite), rows inserted by an INSERT. */
  changes: number;
  /** Auto-increment id of an INSERT, else null. */
  lastId: number | null;
}

export type DbErrorKind = "unique" | "foreign_key" | "not_null" | "check" | "deadlock" | "lock_timeout" | "other";

/** Every engine error is rethrown as this, with a portable `kind`, so callers never match engine error text. */
export class DbError extends Error {
  constructor(public kind: DbErrorKind, message: string, public code?: string | number, public cause_?: unknown) { super(message); this.name = "DbError"; }
}

export interface Db {
  readonly engine: "sqlite" | "mysql";
  /** One row or undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  run(sql: string, params?: Param[]): Promise<RunResult>;
  /** Several statements at once (DDL, migrations). No parameters. */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` in one transaction. A call made inside `fn` on the `tx` handle joins it; calling `tx.tx()` opens a SAVEPOINT. Any throw rolls
   * back. The outermost transaction retries on deadlock or lock timeout (default 3 attempts), so `fn` must be safe to run again.
   */
  tx<T>(fn: (tx: Db) => Promise<T>, opts?: { retries?: number }): Promise<T>;
  /** Insert one row; on a duplicate of `keys` update `update` columns (default: every non-key column), or do nothing when `update` is "none". */
  upsert(table: string, row: Record<string, Param>, keys: string[], update?: string[] | "none"): Promise<RunResult>;
  /** Append the engine's row-lock clause to a SELECT (MySQL: FOR UPDATE; SQLite: nothing, a write transaction is already exclusive). */
  forUpdate(sql: string): string;
  close(): Promise<void>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier "${name}"`);
  return name;
}
