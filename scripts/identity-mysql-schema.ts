import fs from "node:fs";
import path from "node:path";
process.env.CIVIC_DB = ":memory:";
const { identityMysqlDdl } = await import("./identity-schema-lib");

// Regenerates server/data/schema/identity.mysql.sql from the migrations the code registers (S-250). `--check` only verifies it is current.
const file = path.resolve(import.meta.dirname, "../server/data/schema/identity.mysql.sql");
const ddl = identityMysqlDdl();
const norm = (s: string) => s.replace(/\r\n/g, "\n");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(file) || norm(fs.readFileSync(file, "utf8")) !== ddl) { console.error("identity.mysql.sql is stale: run npm run backend:schema"); process.exit(1); }
  console.log("identity MySQL schema current");
} else { fs.writeFileSync(file, ddl); console.log("wrote " + (ddl.match(/CREATE TABLE/g) ?? []).length + " tables"); }
