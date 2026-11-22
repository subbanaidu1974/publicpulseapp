/**
 * Encrypted online backup of the four civic stores (S-68, S-74): one encrypted file per store plus one manifest. Usage: tsx scripts/backup.ts [--dir data/backups] [--keep 14]
 * Env: CIVIC_DB (or CIVIC_IDENTITY_DB / CIVIC_ISSUES_DB / CIVIC_SURVEY_DB / CIVIC_AUDIT_DB), CIVIC_BACKUP_KEY (required in production), CIVIC_BACKUP_DIR, CIVIC_BACKUP_KEEP. Never prints key material.
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
  for (const [store, e] of Object.entries(r.manifest.stores)) {
    console.log(`backup: ${store.padEnd(8)} ${e.file} (${e.bytes} bytes, sha256 ${e.sha256.slice(0, 16)}...) rows=${Object.values(e.tables).reduce((a, b) => a + b, 0)}`);
  }
  console.log(`backup: manifest ${path.basename(r.manifestFile)} rotated=${r.rotated.length}`);
} catch (e) {
  console.error("backup: FAILED:", (e as Error).message);
  process.exit(1);
}
