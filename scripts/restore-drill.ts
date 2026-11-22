/**
 * Restore drill (S-68). Usage: tsx scripts/restore-drill.ts [--file data/backups/civic-....db.enc] [--dir data/backups]
 * Restores the newest (or given) backup into a temp DB, compares row counts with the manifest and runs verifyAuditChain on it.
 * Exit 0 only when everything matches. Never prints key material. Run with the SAME key provider as the source (audit digests are keyed).
 */
import "dotenv/config";
import path from "node:path";
import { latestBackup, resolveBackupKey, restoreDrill } from "../server/civic/backup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = path.resolve(arg("dir") || process.env.CIVIC_BACKUP_DIR || "data/backups");
const file = arg("file") ? path.resolve(arg("file")!) : latestBackup(dir);
if (!file) { console.error(`restore-drill: no backup found in ${dir}`); process.exit(1); }
try {
  const r = restoreDrill({ file, key: resolveBackupKey() });
  if (r.ok) {
    console.log(`restore-drill: OK ${path.basename(file)} tables=${Object.keys(r.tables).length} auditChecked=${r.audit?.checked ?? 0}`);
  } else {
    console.error(`restore-drill: FAILED ${path.basename(file)}`);
    r.problems.forEach((p) => console.error("  - " + p));
    process.exit(1);
  }
} catch (e) {
  console.error("restore-drill: FAILED:", (e as Error).message);
  process.exit(1);
}
