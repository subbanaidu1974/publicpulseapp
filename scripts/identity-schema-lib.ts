import "../server/civic/index"; // registers every migration of every store...
import "../server/people-api"; // ...including the identity tables registered by modules outside server/civic
import "../server/photo-submissions";
import { getStore, migrateStore } from "../server/civic/core/stores";
import { translateSqlite, type SqliteObject } from "../server/data/schema/translate";

/** What SQLite reports for a freshly migrated identity store (in memory under CIVIC_DB=:memory: or vitest). */
export function identitySqliteObjects(): SqliteObject[] {
  migrateStore("identity");
  return getStore("identity").prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").all() as unknown as SqliteObject[];
}

/** The MySQL DDL for the identity store, derived from the SQLite store the code really creates. */
export function identityMysqlDdl(): string {
  return translateSqlite(identitySqliteObjects());
}
