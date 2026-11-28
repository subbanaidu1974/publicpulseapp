import { SqliteDb, type Db } from "../../data";
import { migrate } from "./index";
import { getStore } from "./stores";

/**
 * The bridge between the legacy synchronous civic code and the async data layer (S-250). It is the ONE place outside the legacy files that is
 * allowed to touch the synchronous store handle (tests/backend/syncDbGuard.test.ts exempts it).
 *
 * `identityDb()` is an async `Db` over the SAME node:sqlite connection the legacy code uses, so a store that is half converted still has one
 * connection, one transaction state and one place the data lives. It is the SQLite engine only: running identity on MySQL needs every identity
 * module converted first (until then the rest of the code would keep writing to SQLite). Each module converted so far takes a `Db` so it is
 * tested on MySQL as well (tests/backend/*.repo.test.ts).
 *
 * Rule for code using this inside a transaction: do not await real I/O (network, disk, timers) between statements; legacy synchronous code
 * on the same connection could otherwise run in the middle of the transaction.
 */
let cached: { handle: unknown; db: Db } | null = null;
export function identityDb(): Db {
  migrate(); // idempotent and cheap once applied; creates the store the first time
  const handle = getStore("identity");
  if (!cached || cached.handle !== handle) cached = { handle, db: new SqliteDb(handle, false) };
  return cached.db;
}
