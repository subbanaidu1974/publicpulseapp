import fs from "node:fs";
import path from "node:path";
import type { Migration } from "../migrate";

/**
 * MySQL schema of the identity store (S-250). The DDL file is GENERATED from the SQLite migrations by scripts/identity-mysql-schema.ts
 * (npm run backend:schema) and tests/backend/identitySchema.test.ts fails when it is stale. This is one baseline for the not-yet-live database:
 * once a production MySQL exists (S-256), changes become new migrations after this one and the baseline is never regenerated again.
 */
export const identityMysqlSqlPath = path.join(import.meta.dirname ?? __dirname, "identity.mysql.sql");
export const identityMysqlMigrations = (): Migration[] => [{ id: "identity_mysql_001_baseline", sql: { mysql: fs.readFileSync(identityMysqlSqlPath, "utf8").replace(/\r\n/g, "\n") } }];
