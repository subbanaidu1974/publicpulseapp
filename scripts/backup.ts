/**
 * Encrypted online backup of the civic DB (S-68). Usage: tsx scripts/backup.ts [--dir data/backups] [--keep 14]
 * Env: CIVIC_DB, CIVIC_BACKUP_KEY (required in production), CIVIC_BACKUP_DIR, CIVIC_BACKUP_KEEP. Never prints key material.
 */
import "dotenv/config";
import path from "node:path";
import { migrate } from "../server/civic/core";
import { createBackup, resolveBackupKey } from "../server/civic/backup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const key = resolveBackupKey();
  if (!process.env.CIVIC_BACKUP_KEY) console.warn("backup: CIVIC_BACKUP_KEY not set; using the public DEV key (non-production only, no confidentiality)");
  const dir = path.resolve(arg("dir") || process.env.CIVIC_BACKUP_DIR || "data/backups");
  const keep = Number(arg("keep") || process.env.CIVIC_BACKUP_KEEP) || 14;
  migrate();
  const r = createBackup({ dir, key, keep });
  console.log(`backup: wrote ${path.basename(r.file)} (${r.manifest.bytes} bytes, sha256 ${r.manifest.sha256.slice(0, 16)}...) rows=${Object.values(r.manifest.tables).reduce((a, b) => a + b, 0)} rotated=${r.rotated.length}`);
} catch (e) {
  console.error("backup: FAILED:", (e as Error).message);
  process.exit(1);
}
