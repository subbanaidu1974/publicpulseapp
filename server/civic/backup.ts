/**
 * Encrypted backups and restore drill (S-68, S-74).
 *
 * The civic data is four SEPARATE stores (identity, issues, survey, audit; docs/STORES.md), so a backup is a SET of four encrypted files plus
 * one manifest, taken one store after the other (each store's file is internally consistent; the set is not a single point in time, which is
 * by design: no cross-store joins exist to be inconsistent):
 *   civic-<stamp>.<store>.db.enc   "PPBK1" (5 bytes) | iv (12) | AES-256-GCM ciphertext | tag (16).  AAD = "PPBK1".
 *   civic-<stamp>.manifest.json    { version: 2, createdAt, auditHead, stores: { <store>: { file, bytes, sha256 (of the .enc), plainBytes, tables{name:rows} } } }
 * Pre-split single-file backups (civic-<stamp>.db.enc, manifest version 1) can still be decrypted with restoreBackup(); starting the app on a
 * restored single file imports it into the four stores (server/civic/core/legacy.ts).
 * The key (CIVIC_BACKUP_KEY) is 32 bytes as 64 hex chars or base64. It is never logged, printed or written to the manifest.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STORE_NAMES, backupStoreTo, misplacedTables, resetDbForTests, verifyAuditChain, type AuditVerification, type StoreName } from "./core";

const MAGIC = Buffer.from("PPBK1");
const IV_LEN = 12, TAG_LEN = 16;

export interface StoreBackup {
  file: string;
  bytes: number;
  sha256: string;
  plainBytes: number;
  tables: Record<string, number>;
}
export interface Manifest {
  version: 2;
  createdAt: string;
  stores: Record<StoreName, StoreBackup>;
  auditHead: { seq: number; hash: string } | null;
}

const isProd = (env: NodeJS.ProcessEnv) => env.NODE_ENV === "production" || env.CIVIC_ENV === "production";

/** Parse the backup key. Throws (without echoing the value) when missing in production or malformed. */
export function resolveBackupKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (env.CIVIC_BACKUP_KEY || "").trim();
  if (!raw) {
    if (isProd(env)) throw new Error("CIVIC_BACKUP_KEY is required in production (32 bytes, hex or base64; generate with: openssl rand -hex 32)");
    // Non-production only: a fixed, publicly known key so dev/CI round trips work. Offers no confidentiality.
    return crypto.createHash("sha256").update("people-pulse-dev-backup-key-NOT-SECRET").digest();
  }
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else { const b = Buffer.from(raw, "base64"); if (b.length === 32 && b.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "")) key = b; }
  if (!key) throw new Error("CIVIC_BACKUP_KEY must be 32 bytes as 64 hex characters or base64 (value not shown)");
  return key;
}

export function encryptBuffer(plain: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, ct, c.getAuthTag()]);
}

/** Throws "backup authentication failed" on a wrong key or any modified byte. */
export function decryptBuffer(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a People Pulse backup file");
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(MAGIC.length + IV_LEN, blob.length - TAG_LEN);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(MAGIC);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new Error("backup authentication failed (wrong key or file was modified)");
  }
}

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

function countTables(file: string): { tables: Record<string, number>; head: Manifest["auditHead"] } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as { name: string }[]).map((r) => r.name);
    const tables: Record<string, number> = {};
    for (const n of names) tables[n] = (db.prepare(`SELECT COUNT(*) AS c FROM "${n.replace(/"/g, '""')}"`).get() as unknown as { c: number }).c;
    const h = names.includes("audit_log") ? (db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as unknown as { seq: number; hash: string } | undefined) : undefined;
    return { tables, head: h ? { seq: h.seq, hash: h.hash } : null };
  } finally { db.close(); }
}

const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const ENC_RE = /^civic-(\d{8}T\d{6}Z)\.(?:(identity|issues|survey|audit)\.)?db\.enc$/;
const manifestName = (stamp: string) => `civic-${stamp}.manifest.json`;

/** Snapshot every store (via getStore) into encrypted files + one manifest in `dir`, then rotate to the `keep` newest sets. */
export function createBackup(opts: { dir: string; key: Buffer; keep?: number; now?: Date }): {
  file: string; files: Record<StoreName, string>; manifestFile: string; manifest: Manifest; rotated: string[];
} {
  const now = opts.now ?? new Date();
  fs.mkdirSync(opts.dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-bk-"));
  const stamp = stampOf(now);
  try {
    const stores = {} as Record<StoreName, StoreBackup>;
    const files = {} as Record<StoreName, string>;
    let auditHead: Manifest["auditHead"] = null;
    for (const store of STORE_NAMES) {
      const snap = path.join(tmpDir, `${store}.db`);
      backupStoreTo(store, snap);
      const plain = fs.readFileSync(snap);
      const { tables, head } = countTables(snap);
      if (store === "audit") auditHead = head;
      const blob = encryptBuffer(plain, opts.key);
      const name = `civic-${stamp}.${store}.db.enc`;
      fs.writeFileSync(path.join(opts.dir, name), blob, { mode: 0o600, flag: "wx" });
      files[store] = path.join(opts.dir, name);
      stores[store] = { file: name, bytes: blob.length, sha256: sha256(blob), plainBytes: plain.length, tables };
    }
    const manifest: Manifest = { version: 2, createdAt: now.toISOString(), stores, auditHead };
    const manifestFile = path.join(opts.dir, manifestName(stamp));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    const rotated = rotateBackups(opts.dir, opts.keep ?? 14);
    return { file: files.identity, files, manifestFile, manifest, rotated };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Backup sets in a directory, oldest first: stamp -> files. Handles pre-split single-file sets too. */
function sets(dir: string): { stamp: string; encs: string[] }[] {
  const by = new Map<string, string[]>();
  for (const f of fs.readdirSync(dir)) {
    const m = ENC_RE.exec(f);
    if (m) by.set(m[1], [...(by.get(m[1]) ?? []), f]);
  }
  return [...by.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([stamp, encs]) => ({ stamp, encs }));
}

/** Keep the newest `keep` backup sets (by timestamped name); delete older .enc files and their manifests. Returns deleted file names. */
export function rotateBackups(dir: string, keep: number): string[] {
  const all = sets(dir);
  const drop = all.slice(0, Math.max(0, all.length - Math.max(1, keep)));
  const gone: string[] = [];
  for (const d of drop) {
    for (const f of d.encs) { fs.rmSync(path.join(dir, f), { force: true }); gone.push(f); }
    fs.rmSync(path.join(dir, manifestName(d.stamp)), { force: true });
  }
  return gone;
}

/** The newest backup set: its manifest file (pre-split single-file sets: the .enc file), or null. */
export function latestBackup(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const all = sets(dir);
  if (!all.length) return null;
  const last = all[all.length - 1];
  const mf = path.join(dir, manifestName(last.stamp));
  return fs.existsSync(mf) ? mf : path.join(dir, last.encs[0]);
}

function manifestPathFor(file: string): string {
  if (/\.manifest\.json$/.test(file)) return file;
  const m = ENC_RE.exec(path.basename(file));
  return m ? path.join(path.dirname(file), manifestName(m[1])) : file.replace(/\.db\.enc$/, ".manifest.json");
}

/** The v2 manifest of a set (given its manifest file or any of its .enc files), or null when missing or from a pre-split single-file backup. */
export function readManifest(file: string): Manifest | null {
  const mf = manifestPathFor(file);
  if (!fs.existsSync(mf)) return null;
  const j = JSON.parse(fs.readFileSync(mf, "utf8")) as { version?: number };
  return j.version === 2 ? (j as Manifest) : null;
}

/** Verify one .enc file against its set's manifest sha256 (when a manifest lists it) and decrypt. Throws on any mismatch. */
export function openBackup(encFile: string, key: Buffer): { plain: Buffer; manifest: Manifest | null } {
  const blob = fs.readFileSync(encFile);
  const manifest = readManifest(encFile);
  const entry = manifest ? Object.values(manifest.stores).find((e) => e.file === path.basename(encFile)) : undefined;
  if (entry && sha256(blob) !== entry.sha256) throw new Error("backup file does not match its manifest sha256 (tampered or truncated)");
  return { plain: decryptBuffer(blob, key), manifest };
}

/** Decrypt ONE backup file to `dest` (must not exist). For a v2 set use restoreBackupSet. Also restores pre-split single-file backups. */
export function restoreBackup(opts: { file: string; key: Buffer; dest: string }): Manifest | null {
  if (fs.existsSync(opts.dest)) throw new Error("restore destination already exists; refusing to overwrite");
  const { plain, manifest } = openBackup(opts.file, opts.key);
  fs.mkdirSync(path.dirname(path.resolve(opts.dest)), { recursive: true });
  fs.writeFileSync(opts.dest, plain, { mode: 0o600, flag: "wx" });
  return manifest;
}

/** Decrypt a whole v2 set into `destDir` as <store>.db (none may exist). `file` is the manifest or any .enc of the set. */
export function restoreBackupSet(opts: { file: string; key: Buffer; destDir: string }): { manifest: Manifest; files: Record<StoreName, string> } {
  const manifest = readManifest(opts.file);
  if (!manifest) throw new Error("no store-set manifest found next to this backup (a pre-split single-file backup: use restoreBackup and start the app on the restored file)");
  const dir = path.dirname(manifestPathFor(opts.file));
  const files = {} as Record<StoreName, string>;
  for (const store of STORE_NAMES) {
    files[store] = path.join(opts.destDir, `${store}.db`);
    if (fs.existsSync(files[store])) throw new Error("restore destination already exists; refusing to overwrite");
  }
  fs.mkdirSync(opts.destDir, { recursive: true });
  const plains = STORE_NAMES.map((store) => openBackup(path.join(dir, manifest.stores[store].file), opts.key).plain); // verify everything before writing anything
  STORE_NAMES.forEach((store, i) => fs.writeFileSync(files[store], plains[i], { mode: 0o600, flag: "wx" }));
  return { manifest, files };
}

export interface DrillReport { ok: boolean; problems: string[]; audit: AuditVerification | null; tables: Record<string, number>; manifest: Manifest | null }

const STORE_ENV: Record<StoreName, string> = { identity: "CIVIC_IDENTITY_DB", issues: "CIVIC_ISSUES_DB", survey: "CIVIC_SURVEY_DB", audit: "CIVIC_AUDIT_DB" };

/**
 * Restore the whole set to a temporary directory, compare per-table row counts of every store with the manifest, check that no store holds
 * another store's tables, and run verifyAuditChain on the restored audit store.
 * NOTE: verifyAuditChain works on the process-wide handles, so the drill temporarily repoints the four store env vars at the restored copies and
 * restores the previous handles/env afterwards. Run it in its own process (scripts/restore-drill.ts) against production keys.
 */
export function restoreDrill(opts: { file: string; key: Buffer }): DrillReport {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-drill-"));
  const prev: Record<string, string | undefined> = {};
  for (const v of Object.values(STORE_ENV)) prev[v] = process.env[v];
  const problems: string[] = [];
  let audit: AuditVerification | null = null;
  const tables: Record<string, number> = {};
  let manifest: Manifest | null = null;
  try {
    const restored = restoreBackupSet({ file: opts.file, key: opts.key, destDir: path.join(tmpDir, "restored") });
    manifest = restored.manifest;
    for (const store of STORE_NAMES) {
      const counted = countTables(restored.files[store]);
      const want = manifest.stores[store].tables;
      for (const [t, n] of Object.entries(want)) if (counted.tables[t] !== n) problems.push(`${store}.${t}: manifest ${n} rows, restored ${counted.tables[t] ?? "missing"}`);
      for (const t of Object.keys(counted.tables)) if (!(t in want)) problems.push(`${store}.${t} not in manifest`);
      for (const [t, n] of Object.entries(counted.tables)) tables[`${store}.${t}`] = n;
      if (store === "audit" && JSON.stringify(manifest.auditHead) !== JSON.stringify(counted.head)) problems.push("audit head differs from manifest");
      const db = new DatabaseSync(restored.files[store], { readOnly: true });
      try { for (const m of misplacedTables(db, store)) problems.push("store separation: " + m); } finally { db.close(); }
    }
    resetDbForTests(); // closes the shared handles; the next getStore() opens the restored copies
    for (const store of STORE_NAMES) process.env[STORE_ENV[store]] = restored.files[store];
    audit = verifyAuditChain();
    if (!audit.ok) problems.push(`audit chain: ${audit.reason ?? "failed"} (seq ${audit.brokenAt ?? audit.anchorMismatch ?? "?"})`);
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    resetDbForTests(); // closes the restored copies' handles (no-op when they never opened)
    for (const [v, val] of Object.entries(prev)) if (val === undefined) delete process.env[v]; else process.env[v] = val;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems, audit, tables, manifest };
}
