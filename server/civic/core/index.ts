/**
 * CONTRACT between Phase 1 agents (see docs/DESIGN_2028.md). Owned by Agent A.
 * Exported signatures that existed in the frozen contract are unchanged; additions are marked "(addition)".
 *
 * Dev-only providers: key provider derives keys from an env master key; SMS provider logs to console.
 * Production must install real adapters via setKeyProvider / setSmsProvider (HSM/KMS, DLT-registered SMS).
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

export type Tier = "T0" | "T1" | "T2";
export interface AuthedPerson { id: string; tier: Tier }

declare module "express-serve-static-core" {
  interface Request { person?: AuthedPerson }
}

const isProd = () => process.env.NODE_ENV === "production";
const isTest = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;

// ---------------------------------------------------------------------------------------------
// Database + migrations
// ---------------------------------------------------------------------------------------------

let db: DatabaseSync | null = null;

/** node:sqlite database. File at CIVIC_DB (default data/civic.db); ":memory:" when NODE_ENV=test. One shared handle. */
export function getDb(): DatabaseSync {
  if (db) return db;
  let file = process.env.CIVIC_DB || path.join("data", "civic.db");
  if (isTest() && !process.env.CIVIC_DB) file = ":memory:";
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

const migrations: { id: string; sql: string }[] = [];

/** Register an idempotent migration (SQL text, run once per id, in registration order). Call at module load. */
export function registerMigration(id: string, sql: string): void {
  if (migrations.some((m) => m.id === id)) return; // re-registration (module reload) is a no-op
  migrations.push({ id, sql });
}

/** Run all registered migrations. Called by createCivicRouter and by tests. Safe to call repeatedly. */
export function migrate(): void {
  const d = getDb();
  d.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of migrations) {
    const done = d.prepare("SELECT 1 AS x FROM migrations WHERE id = ?").get(m.id);
    if (done) continue;
    d.exec("BEGIN");
    try {
      d.exec(m.sql);
      d.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw new Error(`civic migration ${m.id} failed: ${(e as Error).message}`);
    }
  }
}

/** Reset the DB handle (tests only). Also resets the key provider cache, SMS outbox, anchor sink and rate state. */
export function resetDbForTests(): void {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = null;
  keyProvider = null;
  smsProvider = null;
  smsOutbox.length = 0;
  anchorSink = null; // erasure hooks are registered at module load, so they are kept
}

// Core tables: persons (shared by identity and everything else), sessions, audit, consents.
registerMigration("core_001_base", `
CREATE TABLE persons (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'T0',
  role TEXT NOT NULL DEFAULT 'resident',
  phone_hash TEXT,
  phone_enc TEXT,
  pin_salt TEXT,
  pin_hash TEXT,
  label TEXT,
  failed_pins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  residence_enc TEXT,
  residence_unit TEXT,
  residence_declared_at TEXT,
  created_at TEXT NOT NULL,
  eligible_from TEXT NOT NULL,
  org TEXT,
  phone_purged_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_persons_phone_hash ON persons(phone_hash);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object TEXT NOT NULL,
  meta TEXT NOT NULL,
  actor_d TEXT NOT NULL,
  object_d TEXT NOT NULL,
  meta_d TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  version TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX idx_consents_person ON consents(person_id);
`);

// ---------------------------------------------------------------------------------------------
// Keys (KeyProvider)
// ---------------------------------------------------------------------------------------------

/**
 * Keyed hashing / encryption behind a provider (dev provider = local key from env; production = HSM/KMS adapter).
 *
 * HSM ADAPTER CONTRACT: an adapter implements these three methods against a non-exportable master key.
 *  - hmac(purpose, value): deterministic, hex, HMAC-SHA256 under a purpose-specific key (used for phone pseudonyms,
 *    so the same input must always yield the same output while the key version is unchanged).
 *  - encrypt(purpose, plaintext): authenticated encryption (AES-256-GCM or KMS Encrypt); output is an opaque string
 *    that must embed key version + nonce so decrypt() needs no extra state.
 *  - decrypt(purpose, ciphertext): inverse; must throw on tamper or wrong purpose (purpose is bound as AAD).
 * Install with setKeyProvider(). Key rotation = new key version embedded in ciphertext; hmac rotation needs re-hash.
 */
export interface KeyProvider {
  hmac(purpose: string, value: string): string;
  encrypt(purpose: string, plaintext: string): string;
  decrypt(purpose: string, ciphertext: string): string;
}

const DEV_FALLBACK_MASTER = "civic-insecure-dev-master-key-do-not-use-in-production";

export class DevKeyProvider implements KeyProvider {
  private master: Buffer;
  private cache = new Map<string, Buffer>();
  constructor(master?: string) {
    const m = master ?? process.env.CIVIC_DEV_MASTER_KEY;
    if (!m) {
      if (isProd()) throw new Error("CIVIC_DEV_MASTER_KEY (or an HSM KeyProvider) is required in production");
      this.master = Buffer.from(DEV_FALLBACK_MASTER);
    } else this.master = Buffer.from(m);
  }
  private key(purpose: string): Buffer {
    let k = this.cache.get(purpose);
    if (!k) {
      k = Buffer.from(crypto.hkdfSync("sha256", this.master, Buffer.from("civic-v1"), Buffer.from("purpose:" + purpose), 32));
      this.cache.set(purpose, k);
    }
    return k;
  }
  hmac(purpose: string, value: string): string {
    return crypto.createHmac("sha256", this.key("hmac:" + purpose)).update(value).digest("hex");
  }
  encrypt(purpose: string, plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key("enc:" + purpose), iv);
    c.setAAD(Buffer.from(purpose));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return "v1." + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
  }
  decrypt(purpose: string, ciphertext: string): string {
    if (!ciphertext.startsWith("v1.")) throw new Error("unknown ciphertext version");
    const raw = Buffer.from(ciphertext.slice(3), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key("enc:" + purpose), raw.subarray(0, 12));
    d.setAAD(Buffer.from(purpose));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  }
}

let keyProvider: KeyProvider | null = null;
export function getKeys(): KeyProvider {
  if (!keyProvider) keyProvider = new DevKeyProvider();
  return keyProvider;
}
/** (addition) Install an HSM/KMS adapter. */
export function setKeyProvider(p: KeyProvider | null): void { keyProvider = p; }

// ---------------------------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------------------------

/** Send an OTP/notification through a pluggable provider. Dev provider logs to console and never runs in production. */
export interface SmsProvider { send(toPhone: string, text: string): Promise<void> }

/** (addition) In-memory outbox, populated by the dev provider outside production. Tests read it. */
export const smsOutbox: { to: string; text: string; ts: string }[] = [];

class DevSmsProvider implements SmsProvider {
  async send(toPhone: string, text: string): Promise<void> {
    if (isProd()) throw new Error("dev SMS provider refuses to run in production; install a real provider with setSmsProvider");
    smsOutbox.push({ to: toPhone, text, ts: new Date().toISOString() });
    if (smsOutbox.length > 500) smsOutbox.shift();
    // Deliberately do not print the number or the message body (they may carry an OTP).
    if (!isTest()) console.log(`[dev-sms] message queued (${text.length} chars)`);
  }
}

let smsProvider: SmsProvider | null = null;
export function getSms(): SmsProvider {
  if (isProd() && !smsProvider) throw new Error("no SMS provider configured for production");
  if (!smsProvider) smsProvider = new DevSmsProvider();
  return smsProvider;
}
/** (addition) Install a real SMS provider. */
export function setSmsProvider(p: SmsProvider | null): void { smsProvider = p; }

// ---------------------------------------------------------------------------------------------
// Sessions + auth
// ---------------------------------------------------------------------------------------------

const SESSION_DAYS = 30;

/** (addition) Create a session token for a person. Only a keyed hash of the token is stored. */
export function createSession(personId: string): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  getDb().prepare("INSERT INTO sessions (token_hash, person_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    getKeys().hmac("session", token), personId, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 86400000).toISOString());
  return token;
}
/** (addition) */
export function revokeSessions(personId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE person_id = ?").run(personId);
}

/** Express middleware: requires header `Authorization: Bearer <session token>`; sets req.person; 401 JSON {error} otherwise. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) { res.status(401).json({ error: "authentication required" }); return; }
  try {
    const row = getDb().prepare(
      `SELECT p.id AS id, p.tier AS tier, s.expires_at AS exp FROM sessions s JOIN persons p ON p.id = s.person_id
       WHERE s.token_hash = ? AND p.deleted_at IS NULL`).get(getKeys().hmac("session", m[1])) as { id: string; tier: Tier; exp: string } | undefined;
    if (!row || row.exp < new Date().toISOString()) { res.status(401).json({ error: "invalid or expired session" }); return; }
    req.person = { id: row.id, tier: row.tier };
    next();
  } catch {
    res.status(401).json({ error: "authentication failed" });
  }
}

// ---------------------------------------------------------------------------------------------
// Audit log (hash chain, redactable without breaking the chain, external anchoring)
// ---------------------------------------------------------------------------------------------
//
// Row hash = sha256(prev_hash + canonicalJSON({seq, ts, action, actor_d, object_d, meta_d})).
// actor_d/object_d/meta_d are keyed digests (HMAC under the 'audit' purpose) of the clear values at write time.
// The clear columns (actor, object, meta) can later be REDACTED (replaced by "[redacted]", redacted=1) for erasure:
// the digests and hash stay, so the chain still verifies. Redaction is itself audited as 'audit.redact' with the
// affected seq numbers, and verifyAuditChain() fails if a row is marked redacted without a matching audit.redact
// entry. Clear fields of non-redacted rows are re-digested during verification, so editing them is detected.
// Limits: someone with DB write access AND the audit key can rebuild the chain; the external anchor (head hash
// published to a sink outside the DB) is what detects that.

const REDACTED = "[redacted]";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const GENESIS = "0".repeat(64);

function rowHash(prev: string, r: { seq: number; ts: string; action: string; actor_d: string; object_d: string; meta_d: string }): string {
  return sha256(prev + canonicalJson({ seq: r.seq, ts: r.ts, action: r.action, actor_d: r.actor_d, object_d: r.object_d, meta_d: r.meta_d }));
}

/** Append to the hash-chained audit log. Never include phone numbers, PINs or response contents in meta. */
export function audit(actor: string, action: string, object: string, meta?: Record<string, unknown>): void {
  const d = getDb();
  const k = getKeys();
  const metaJson = canonicalJson(meta ?? {});
  d.exec("BEGIN IMMEDIATE");
  try {
    const last = d.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? GENESIS;
    const ts = new Date().toISOString();
    const row = { seq, ts, action, actor_d: k.hmac("audit", actor), object_d: k.hmac("audit", object), meta_d: k.hmac("audit", metaJson) };
    d.prepare(`INSERT INTO audit_log (seq, ts, actor, action, object, meta, actor_d, object_d, meta_d, redacted, prev_hash, hash)
               VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`).run(seq, ts, actor, action, object, metaJson, row.actor_d, row.object_d, row.meta_d, prev, rowHash(prev, row));
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** (addition) Log a privileged/sensitive read (who, what, why). Call this wherever an operator reads personal data. */
export function auditPrivilegedRead(actor: string, object: string, purpose: string): void {
  audit(actor, "read.sensitive", object, { purpose });
}

/** (addition) Redact every audit row whose actor or object refers to `subjectId` (bare id or "kind:<id>"). Chain still verifies. */
export function redactAuditFor(subjectId: string): number {
  const d = getDb();
  const rows = d.prepare("SELECT seq, actor, object FROM audit_log WHERE redacted = 0").all() as { seq: number; actor: string; object: string }[];
  const hit = rows.filter((r) => r.actor === subjectId || r.object === subjectId || r.actor.endsWith(":" + subjectId) || r.object.endsWith(":" + subjectId)).map((r) => r.seq);
  if (hit.length === 0) return 0;
  const upd = d.prepare("UPDATE audit_log SET actor = ?, object = ?, meta = ?, redacted = 1 WHERE seq = ?");
  for (const s of hit) upd.run(REDACTED, REDACTED, "{}", s);
  audit("system", "audit.redact", "audit_log", { seqs: hit, reason: "erasure" });
  return hit.length;
}

export interface AnchorRecord { seq: number; hash: string; ts: string }
/** External anchoring: publish the chain head to a store the DB operator cannot rewrite (WORM bucket, transparency log, notary). */
export interface AnchorSink {
  publish(rec: AnchorRecord): void;
  list(): AnchorRecord[];
}
export class NoopAnchorSink implements AnchorSink { publish(): void { /* none */ } list(): AnchorRecord[] { return []; } }
/** Dev sink: JSON lines in a local file (not tamper-proof against someone who owns the machine; stands in for a real sink). */
export class FileAnchorSink implements AnchorSink {
  constructor(private file: string) {}
  publish(rec: AnchorRecord): void {
    fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
  }
  list(): AnchorRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AnchorRecord);
  }
}
let anchorSink: AnchorSink | null = null;
export function getAnchorSink(): AnchorSink {
  if (!anchorSink) anchorSink = process.env.CIVIC_AUDIT_ANCHOR_FILE ? new FileAnchorSink(process.env.CIVIC_AUDIT_ANCHOR_FILE) : new NoopAnchorSink();
  return anchorSink;
}
export function setAnchorSink(s: AnchorSink | null): void { anchorSink = s; }

/** (addition) Publish the current chain head to the anchor sink. Run periodically (e.g. hourly). Returns the record or null if empty. */
export function anchorAuditHead(): AnchorRecord | null {
  const last = getDb().prepare("SELECT seq, hash, ts FROM audit_log ORDER BY seq DESC LIMIT 1").get() as unknown as AnchorRecord | undefined;
  if (!last) return null;
  const rec = { seq: last.seq, hash: last.hash, ts: new Date().toISOString() };
  getAnchorSink().publish(rec);
  return rec;
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  reason?: string;
  anchorMismatch?: number; // seq of the first anchor that does not match the chain
}

/** (addition) Verify the whole chain, the clear-field digests, redaction records and any external anchors. */
export function verifyAuditChain(): AuditVerification {
  const d = getDb();
  const k = getKeys();
  const rows = d.prepare("SELECT * FROM audit_log ORDER BY seq ASC").all() as unknown as {
    seq: number; ts: string; actor: string; action: string; object: string; meta: string; actor_d: string; object_d: string; meta_d: string;
    redacted: number; prev_hash: string; hash: string;
  }[];
  const redactedSeqs = new Set<number>();
  for (const r of rows) {
    if (r.action === "audit.redact" && !r.redacted) {
      try { for (const s of (JSON.parse(r.meta) as { seqs?: number[] }).seqs ?? []) redactedSeqs.add(s); } catch { /* digest check below catches it */ }
    }
  }
  let prev = GENESIS;
  let n = 0;
  for (const r of rows) {
    n++;
    if (r.seq !== n) return { ok: false, checked: n - 1, brokenAt: n, reason: "sequence gap (row deleted or inserted)" };
    if (r.prev_hash !== prev) return { ok: false, checked: n - 1, brokenAt: r.seq, reason: "prev_hash mismatch" };
    if (rowHash(prev, r) !== r.hash) return { ok: false, checked: n - 1, brokenAt: r.seq, reason: "row hash mismatch" };
    if (r.redacted) {
      if (!redactedSeqs.has(r.seq)) return { ok: false, checked: n - 1, brokenAt: r.seq, reason: "row marked redacted without an audit.redact record" };
    } else if (k.hmac("audit", r.actor) !== r.actor_d || k.hmac("audit", r.object) !== r.object_d || k.hmac("audit", r.meta) !== r.meta_d) {
      return { ok: false, checked: n - 1, brokenAt: r.seq, reason: "row content does not match its digest (edited)" };
    }
    prev = r.hash;
  }
  const bySeq = new Map(rows.map((r) => [r.seq, r.hash]));
  for (const a of getAnchorSink().list()) {
    if (bySeq.get(a.seq) !== a.hash) return { ok: false, checked: n, anchorMismatch: a.seq, reason: "external anchor does not match chain" };
  }
  return { ok: true, checked: n };
}

// ---------------------------------------------------------------------------------------------
// Consent + erasure hooks
// ---------------------------------------------------------------------------------------------

/** Record a versioned consent (purpose e.g. "signup", "household_invite", "minor_dependent"). Returns consent id. */
export function recordConsent(personId: string, purpose: string, version: string): string {
  const id = crypto.randomUUID();
  getDb().prepare("INSERT INTO consents (id, person_id, purpose, version, ts) VALUES (?,?,?,?,?)").run(id, personId, purpose, version, new Date().toISOString());
  audit(personId, "consent.record", "consent:" + id, { purpose, version });
  return id;
}

/** (addition) Other modules register erasure work here; DELETE /me calls every hook with the person id. */
export type ErasureHook = (personId: string) => void;
const erasureHooks: { name: string; fn: ErasureHook }[] = [];
export function registerErasureHook(name: string, fn: ErasureHook): void {
  const i = erasureHooks.findIndex((h) => h.name === name);
  if (i >= 0) erasureHooks[i] = { name, fn }; else erasureHooks.push({ name, fn });
}
export function runErasureHooks(personId: string): string[] {
  const ran: string[] = [];
  for (const h of erasureHooks) { h.fn(personId); ran.push(h.name); }
  return ran;
}
