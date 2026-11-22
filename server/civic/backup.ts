/**
 * Encrypted backups and restore drill (S-68).
 *
 * File format  <name>.db.enc :  "PPBK1" (5 bytes) | iv (12) | AES-256-GCM ciphertext | tag (16).  AAD = "PPBK1".
 * Manifest     <name>.manifest.json : { version, file, createdAt, bytes, sha256 (of the .enc file), plainBytes, tables{name:rows}, auditHead }.
 * The key (CIVIC_BACKUP_KEY) is 32 bytes as 64 hex chars or base64. It is never logged, printed or written to the manifest.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDbTo, resetDbForTests, verifyAuditChain, type AuditVerification } from "./core";

const MAGIC = Buffer.from("PPBK1");
const IV_LEN = 12, TAG_LEN = 16;

export interface Manifest {
  version: 1;
  file: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  plainBytes: number;
  tables: Record<string, number>;
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

/** Snapshot the live DB (CIVIC_DB via getDb) into an encrypted file + manifest in `dir`, then rotate to `keep` newest. */
export function createBackup(opts: { dir: string; key: Buffer; keep?: number; now?: Date }): { file: string; manifestFile: string; manifest: Manifest; rotated: string[] } {
  const now = opts.now ?? new Date();
  fs.mkdirSync(opts.dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-bk-"));
  const snap = path.join(tmpDir, "snapshot.db");
  try {
    backupDbTo(snap);
    const plain = fs.readFileSync(snap);
    const { tables, head } = countTables(snap);
    const blob = encryptBuffer(plain, opts.key);
    const name = `civic-${stampOf(now)}.db.enc`;
    const file = path.join(opts.dir, name);
    fs.writeFileSync(file, blob, { mode: 0o600, flag: "wx" });
    const manifest: Manifest = { version: 1, file: name, createdAt: now.toISOString(), bytes: blob.length, sha256: sha256(blob), plainBytes: plain.length, tables, auditHead: head };
    const manifestFile = path.join(opts.dir, name.replace(/\.db\.enc$/, ".manifest.json"));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    const rotated = rotateBackups(opts.dir, opts.keep ?? 14);
    return { file, manifestFile, manifest, rotated };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Keep the newest `keep` backups (by timestamped name); delete older .enc and their manifests. Returns deleted file names. */
export function rotateBackups(dir: string, keep: number): string[] {
  const encs = fs.readdirSync(dir).filter((f) => /^civic-\d{8}T\d{6}Z\.db\.enc$/.test(f)).sort();
  const drop = encs.slice(0, Math.max(0, encs.length - Math.max(1, keep)));
  for (const f of drop) {
    fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, f.replace(/\.db\.enc$/, ".manifest.json")), { force: true });
  }
  return drop;
}

export function latestBackup(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const encs = fs.readdirSync(dir).filter((f) => /^civic-\d{8}T\d{6}Z\.db\.enc$/.test(f)).sort();
  return encs.length ? path.join(dir, encs[encs.length - 1]) : null;
}

export function readManifest(encFile: string): Manifest | null {
  const m = encFile.replace(/\.db\.enc$/, ".manifest.json");
  return fs.existsSync(m) ? (JSON.parse(fs.readFileSync(m, "utf8")) as Manifest) : null;
}

/** Verify the file against its manifest sha256 (when a manifest exists) and decrypt. Throws on any mismatch. */
export function openBackup(encFile: string, key: Buffer): { plain: Buffer; manifest: Manifest | null } {
  const blob = fs.readFileSync(encFile);
  const manifest = readManifest(encFile);
  if (manifest && sha256(blob) !== manifest.sha256) throw new Error("backup file does not match its manifest sha256 (tampered or truncated)");
  return { plain: decryptBuffer(blob, key), manifest };
}

/** Decrypt a backup to `dest` (must not exist). */
export function restoreBackup(opts: { file: string; key: Buffer; dest: string }): Manifest | null {
  if (fs.existsSync(opts.dest)) throw new Error("restore destination already exists; refusing to overwrite");
  const { plain, manifest } = openBackup(opts.file, opts.key);
  fs.mkdirSync(path.dirname(path.resolve(opts.dest)), { recursive: true });
  fs.writeFileSync(opts.dest, plain, { mode: 0o600, flag: "wx" });
  return manifest;
}

export interface DrillReport { ok: boolean; problems: string[]; audit: AuditVerification | null; tables: Record<string, number>; manifest: Manifest | null }

/**
 * Restore to a temporary DB, compare per-table row counts with the manifest and run verifyAuditChain on the restored copy.
 * NOTE: verifyAuditChain works on the process-wide handle, so the drill temporarily repoints CIVIC_DB at the restored copy and
 * restores the previous handle/env afterwards. Run it in its own process (scripts/restore-drill.ts) against production keys.
 */
export function restoreDrill(opts: { file: string; key: Buffer }): DrillReport {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-drill-"));
  const dest = path.join(tmpDir, "restored.db");
  const prevDb = process.env.CIVIC_DB;
  const problems: string[] = [];
  let audit: AuditVerification | null = null;
  let tables: Record<string, number> = {};
  let manifest: Manifest | null = null;
  try {
    manifest = restoreBackup({ file: opts.file, key: opts.key, dest });
    const counted = countTables(dest);
    tables = counted.tables;
    if (!manifest) problems.push("no manifest next to the backup; row counts cannot be compared");
    else {
      for (const [t, n] of Object.entries(manifest.tables)) if (tables[t] !== n) problems.push(`table ${t}: manifest ${n} rows, restored ${tables[t] ?? "missing"}`);
      for (const t of Object.keys(tables)) if (!(t in manifest.tables)) problems.push(`table ${t} not in manifest`);
      if (JSON.stringify(manifest.auditHead) !== JSON.stringify(counted.head)) problems.push("audit head differs from manifest");
    }
    resetDbForTests(); // closes the shared handle; the next getDb() opens the restored copy
    process.env.CIVIC_DB = dest;
    audit = verifyAuditChain();
    if (!audit.ok) problems.push(`audit chain: ${audit.reason ?? "failed"} (seq ${audit.brokenAt ?? audit.anchorMismatch ?? "?"})`);
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    resetDbForTests(); // closes the restored copy's handle (no-op when it never opened)
    if (prevDb === undefined) delete process.env.CIVIC_DB; else process.env.CIVIC_DB = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems, audit, tables, manifest };
}
