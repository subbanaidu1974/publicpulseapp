import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { audit, getDb, migrate, migrationStatus, registerMigration, resetDbForTests } from "../../server/civic/core";
import { createBackup, decryptBuffer, encryptBuffer, latestBackup, openBackup, resolveBackupKey, restoreBackup, restoreDrill, rotateBackups } from "../../server/civic/backup";

let dir: string;
let dbFile: string;
const KEY = crypto.randomBytes(32);
const envSave = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-bk-"));
  dbFile = path.join(dir, "civic.db");
  process.env.CIVIC_DB = dbFile;
  resetDbForTests();
  migrate();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES ('p1', '2026-01-01', '2026-01-01')").run();
  audit("system", "test.one", "obj:1", { a: 1 });
  audit("system", "test.two", "obj:2", { b: 2 });
});
afterEach(() => {
  resetDbForTests();
  process.env = { ...envSave };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("UT-backup", () => {
  it("@E2E-83 backup -> restore round trip reproduces the DB and the restore drill passes", () => {
    const bdir = path.join(dir, "backups");
    const b = createBackup({ dir: bdir, key: KEY });
    expect(fs.existsSync(b.file)).toBe(true);
    expect(b.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.manifest.tables.persons).toBe(1);
    expect(b.manifest.tables.audit_log).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(b.file).subarray(0, 16).toString()).not.toContain("SQLite format");
    const out = path.join(dir, "restored.db");
    restoreBackup({ file: b.file, key: KEY, dest: out });
    const r = new DatabaseSync(out, { readOnly: true });
    expect((r.prepare("SELECT COUNT(*) c FROM persons").get() as { c: number }).c).toBe(1);
    r.close();
    const drill = restoreDrill({ file: b.file, key: KEY });
    expect(drill.problems).toEqual([]);
    expect(drill.ok).toBe(true);
    expect(drill.audit?.ok).toBe(true);
    expect(process.env.CIVIC_DB).toBe(dbFile); // the drill leaves the process pointing at the source DB
  });

  it("@E2E-83 tamper detection: flipped byte, wrong key, wrong manifest hash and truncation all fail", () => {
    const b = createBackup({ dir: path.join(dir, "backups"), key: KEY });
    const blob = fs.readFileSync(b.file);
    const flipped = Buffer.from(blob); flipped[40] ^= 0xff;
    fs.writeFileSync(b.file, flipped);
    expect(() => openBackup(b.file, KEY)).toThrow(/manifest sha256/);
    fs.rmSync(b.manifestFile); // without a manifest, GCM authentication still catches it
    expect(() => openBackup(b.file, KEY)).toThrow(/authentication failed/);
    fs.writeFileSync(b.file, blob);
    expect(() => openBackup(b.file, crypto.randomBytes(32))).toThrow(/authentication failed/);
    fs.writeFileSync(b.file, blob.subarray(0, blob.length - 5));
    expect(() => openBackup(b.file, KEY)).toThrow();
    expect(decryptBuffer(encryptBuffer(Buffer.from("hi"), KEY), KEY).toString()).toBe("hi");
  });

  it("@E2E-83 restore drill fails when the audit chain inside the backup was tampered with", () => {
    getDb().exec("UPDATE audit_log SET meta = '{\"a\":999}' WHERE seq = 1");
    const b = createBackup({ dir: path.join(dir, "backups"), key: KEY });
    const drill = restoreDrill({ file: b.file, key: KEY });
    expect(drill.ok).toBe(false);
    expect(drill.problems.join(" ")).toMatch(/audit chain/);
  });

  it("@E2E-83 rotation keeps the newest N and removes manifests with them", () => {
    const bdir = path.join(dir, "backups");
    for (let i = 0; i < 4; i++) createBackup({ dir: bdir, key: KEY, keep: 99, now: new Date(Date.UTC(2026, 0, 1 + i)) });
    const dropped = rotateBackups(bdir, 2);
    expect(dropped).toHaveLength(2);
    expect(fs.readdirSync(bdir).filter((f) => f.endsWith(".enc"))).toHaveLength(2);
    expect(fs.readdirSync(bdir).filter((f) => f.endsWith(".json"))).toHaveLength(2);
    expect(latestBackup(bdir)).toContain("20260104");
  });

  it("@E2E-83 key handling: required in production, validated, never echoed", () => {
    expect(() => resolveBackupKey({ NODE_ENV: "production" })).toThrow(/CIVIC_BACKUP_KEY is required/);
    expect(() => resolveBackupKey({ CIVIC_ENV: "production" })).toThrow(/required/);
    const bad = "not-a-valid-key-value-xyz";
    let msg = "";
    try { resolveBackupKey({ CIVIC_BACKUP_KEY: bad }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/must be 32 bytes/);
    expect(msg).not.toContain(bad);
    expect(resolveBackupKey({ CIVIC_BACKUP_KEY: KEY.toString("hex") }).equals(KEY)).toBe(true);
    expect(resolveBackupKey({ CIVIC_BACKUP_KEY: KEY.toString("base64") }).equals(KEY)).toBe(true);
    expect(resolveBackupKey({ NODE_ENV: "development" })).toHaveLength(32);
  });
});

describe("UT-migrations", () => {
  it("@E2E-87 stores a checksum per applied migration and reports no drift", () => {
    const rows = getDb().prepare("SELECT id, checksum FROM migrations").all() as { id: string; checksum: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);
    expect(migrationStatus().drift).toEqual([]);
  });

  it("@E2E-87 refuses to start when an applied migration's checksum no longer matches, unless CIVIC_ALLOW_DRIFT=1", () => {
    getDb().prepare("UPDATE migrations SET checksum = 'deadbeef' WHERE id = 'core_001_base'").run();
    resetDbForTests();
    expect(() => migrate()).toThrow(/migration drift.*core_001_base/);
    resetDbForTests();
    process.env.CIVIC_ALLOW_DRIFT = "1";
    expect(() => migrate()).not.toThrow();
  });

  it("@E2E-87 stamps checksums on legacy rows that predate the column", () => {
    getDb().exec("UPDATE migrations SET checksum = NULL");
    resetDbForTests();
    migrate();
    expect((getDb().prepare("SELECT COUNT(*) c FROM migrations WHERE checksum IS NULL").get() as { c: number }).c).toBe(0);
  });

  it("@E2E-87 writes a pre-migrate backup copy when migrations are pending on a non-empty DB, and not otherwise", () => {
    const bdir = path.join(dir, "backups");
    migrate();
    expect(fs.existsSync(bdir)).toBe(false); // nothing pending
    registerMigration("zz_ops_test_002", "CREATE TABLE ops_t (id INTEGER PRIMARY KEY);");
    migrate();
    const copies = fs.readdirSync(bdir).filter((f) => f.startsWith("pre-migrate-"));
    expect(copies).toHaveLength(1);
    const c = new DatabaseSync(path.join(bdir, copies[0]), { readOnly: true });
    expect(c.prepare("SELECT name FROM sqlite_master WHERE name = 'ops_t'").get()).toBeUndefined(); // state BEFORE the new migration
    expect((c.prepare("SELECT COUNT(*) c FROM persons").get() as { c: number }).c).toBe(1);
    c.close();
  });
});
