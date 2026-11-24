/**
 * CONTRACT between Phase 1 agents (see docs/DESIGN_2028.md). Owned by Agent A.
 * Exported signatures that existed in the frozen contract are unchanged; additions are marked "(addition)".
 *
 * ROLES (addition; for the issues agent and other modules): roles live in the `roles` table keyed to person_id.
 *   grantRole(grantedBy, personId, role, jurisdiction?)  grantedBy = an admin person id or "system" (ops); throws otherwise; audited.
 *   revokeRole(revokedBy, personId, role)                audited.
 *   hasRole(personId, role, jurisdiction?)               role = "admin" | "officer" | "moderator". A grant with a null jurisdiction covers
 *                                                        every jurisdiction; a scoped grant covers only that exact scope string.
 *   listRoles(personId)                                  [{role, jurisdiction}]
 *   requireRole(role)                                    Express middleware (does requireAuth itself, then 403 if the role is missing).
 *   runInTransaction(fn)                                 one DB transaction (nests via savepoints); audit() joins it.
 * req.person.roles (set by requireAuth) lists the caller's role names.
 *
 * WAVE-4 ADDITIONS (E2E-74/75/76/88/151/155/159; owner: auth/roles agent):
 *   Sessions   createSession(personId, {label?}) (TTL CIVIC_SESSION_TTL_DAYS, default 7, sliding refresh, hard cap CIVIC_SESSION_MAX_DAYS=30)
 *              listSessions(personId) / revokeSessionById(personId, id) / revokeSessions(personId) (all); req.sessionId set by requireAuth.
 *   Roles      RoleName now: admin officer moderator politician journalist eci_liaison geo_reviewer volunteer (ROLE_NAMES exported).
 *              grantRole(by, person, role, jurisdiction?, department?)  hasRole(person, role, scope?)  hasAnyRole(person, roles[], scope?)
 *              listRolesDetailed(person) -> [{role, jurisdiction, department}]   requireRole(...roles) (any-of; one arg still works).
 *              "volunteer" is bridged to persons.role=volunteer both ways. Admin API: server/civic/admin (dual control + TOTP MFA).
 *   Audit      auditHead(), auditPublicEntries(from, limit), anchorStatus(), HttpWitnessAnchorSink, setAnchorSink/getAnchorSink,
 *              env CIVIC_ANCHOR_URL (+ CIVIC_ANCHOR_SECRET) selects the HTTP witness; CIVIC_AUDIT_ANCHOR_FILE the file sink.
 *
 * Dev-only providers: key provider derives keys from an env master key; SMS provider logs to console.
 * Production must install real adapters via setKeyProvider / setSmsProvider (HSM/KMS, DLT-registered SMS).
 */
import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import {
  STORE_NAMES, STORE_TABLES, assertStorePlacement, backupStoreTo, closeStores, getStore, legacyDbFile, migrateStore, misplacedTables, registerMigration,
  registeredMigrations, runInStore, storeFile, storeMigrationStatus, tablesOf, writeAtCommit, type StoreMigrationStatus, type StoreName,
} from "./stores";
import { importLegacyDatabase } from "./legacy";
import { scrubAuditMeta } from "./auditscrub";

export { SCRUBBED, auditScrubCount, findAuditViolations, maskPhones, resetAuditScrubCount, scrubAuditMeta } from "./auditscrub";

export type Tier = "T0" | "T1" | "T2";
export interface AuthedPerson { id: string; tier: Tier; roles?: string[] }

declare module "express-serve-static-core" {
  interface Request { person?: AuthedPerson; sessionId?: string }
}

const isProd = () => process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production";
const isTest = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;

// ---------------------------------------------------------------------------------------------
// Stores + migrations (S-74: identity / issues / survey / audit are separate databases; see ./stores.ts and docs/STORES.md)
// ---------------------------------------------------------------------------------------------

/**
 * (S-74) The identity store: persons, sessions, roles, households, consents ... (the historical single database). Use
 * getStore("issues" | "survey" | "audit") for the other stores. :memory: when NODE_ENV=test and CIVIC_DB is unset.
 */
export function getDb(): DatabaseSync { return getStore("identity"); }

/** (addition) Run fn in one transaction of the IDENTITY store (nests via savepoints). Use runInStore(name, fn) for another store. */
export function runInTransaction<T>(fn: () => T): T { return runInStore("identity", fn); }

export { STORE_NAMES, STORE_TABLES, assertStorePlacement, backupStoreTo, closeStores, getStore, legacyDbFile, migrateStore, misplacedTables, registerMigration,
  registeredMigrations, runInStore, storeFile, storeMigrationStatus, tablesOf };
export type { StoreName, StoreMigrationStatus };

/** Online, consistent copy of the IDENTITY store (the historical `getDb()` database). See backupStoreTo for the other stores. */
export function backupDbTo(dest: string): void { backupStoreTo("identity", dest); }

/** (S-72/S-74) Applied vs registered migrations, summed over the four stores (`stores` has the per-store detail). */
export function migrationStatus(): { registered: number; applied: number; pending: string[]; drift: string[]; stores: Record<StoreName, StoreMigrationStatus> } {
  const stores = Object.fromEntries(STORE_NAMES.map((s) => [s, storeMigrationStatus(s)])) as Record<StoreName, StoreMigrationStatus>;
  const all = STORE_NAMES.map((s) => stores[s]);
  return {
    registered: all.reduce((n, x) => n + x.registered, 0), applied: all.reduce((n, x) => n + x.applied, 0),
    pending: all.flatMap((x) => x.pending), drift: all.flatMap((x) => x.drift), stores,
  };
}

/** (S-74) Readiness probe for ALL four stores (throws if any cannot answer). server.ts dbPing may call this instead of getDb(). */
export function pingStores(): void { for (const n of STORE_NAMES) getStore(n).prepare("SELECT 1").get(); }

/**
 * Run all registered migrations of every store, then verify store placement and (once) import a pre-split single database.
 * Called by createCivicRouter and by tests. Safe to call repeatedly. Per store: checksum drift detection (CIVIC_ALLOW_DRIFT=1 overrides)
 * and a pre-migrate copy of that store's file when migrations are pending (docs/RUNBOOK.md).
 * Legacy import (server/civic/core/legacy.ts): when CIVIC_DB names an existing pre-split database file that has not been imported, its
 * tables are copied into the four stores (issue reporters become pseudonyms), the file is kept read-only as a backup and the import is recorded.
 */
export function migrate(): void {
  for (const s of STORE_NAMES) migrateStore(s);
  assertStorePlacement();
  importLegacyDatabase();
}

/** Reset every store handle (tests only). Also resets the key provider cache, SMS outbox, anchor sink and rate state. */
export function resetDbForTests(): void {
  closeStores();
  keyProvider = null;
  smsProvider = null;
  smsOutbox.length = 0;
  anchorSink = null; // erasure hooks are registered at module load, so they are kept
}

// Identity store: persons (shared by identity and everything else), sessions, consents. The audit log lives in the audit store.
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
CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  version TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX idx_consents_person ON consents(person_id);
`);

// Audit store: the hash chain. A compromise of any other store cannot rewrite it (and the file can be shipped/anchored on its own).
registerMigration("core_audit_001_log", `
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
CREATE TABLE audit_anchors (
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  acked_at TEXT,
  PRIMARY KEY (seq, hash)
);
`, "audit");

// Survey store (Phase 2 placeholder): its own file and migration runner. Response rows will carry no person id; `has_responded` stays in identity.
registerMigration("survey_000_init", `
CREATE TABLE survey_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO survey_meta (key, value) VALUES ('schema', 'placeholder: Phase 2 plugs response tables in here');
`, "survey");

// Identity store bookkeeping: store_meta (e.g. the legacy-import record), the keyed link ledger and the cross-store erasure outbox.
registerMigration("core_005_store_meta_links_outbox", `
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
-- Which issue-store objects a person is behind. link_key is a keyed hash of (person, object) and ref_enc the encrypted object reference,
-- so nothing in this table equals any value stored in the issues database (no SQL join is possible, even with both files open).
CREATE TABLE issue_links (
  person_id TEXT NOT NULL,
  link_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_enc TEXT NOT NULL,
  village_lgd TEXT,
  ts TEXT NOT NULL,
  PRIMARY KEY (person_id, link_key)
);
CREATE INDEX idx_issue_links_village ON issue_links(kind, village_lgd);
-- Work that must follow an identity-side erasure into another store (issue pseudonym unlinking, audit redaction). Retried until done.
CREATE TABLE erasure_outbox (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  subjects TEXT NOT NULL,
  stores_done INTEGER NOT NULL DEFAULT 0,
  audit_done INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
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
/** (addition, S-55) True unless a non-dev KeyProvider (HSM/KMS adapter) has been installed. */
export function isDevKeyProvider(): boolean { return !keyProvider || keyProvider instanceof DevKeyProvider; }

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
/** (addition, S-55) True unless a real SMS provider has been installed. */
export function isDevSmsProvider(): boolean { return !smsProvider || smsProvider instanceof DevSmsProvider; }

// ---------------------------------------------------------------------------------------------
// Sessions + auth
// ---------------------------------------------------------------------------------------------

/** Session lifetime in days (env CIVIC_SESSION_TTL_DAYS, default 7). Sliding: each use past the refresh interval pushes expiry out. */
export const sessionTtlDays = () => Math.max(0.0001, Number(process.env.CIVIC_SESSION_TTL_DAYS || 7));
/** Absolute lifetime cap regardless of use (env CIVIC_SESSION_MAX_DAYS, default 30). */
export const sessionMaxDays = () => Math.max(sessionTtlDays(), Number(process.env.CIVIC_SESSION_MAX_DAYS || 30));
const SESSION_TOUCH_MS = 5 * 60 * 1000;

registerMigration("core_003_sessions", `
ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN label TEXT;
UPDATE sessions SET id = lower(hex(randomblob(8))) WHERE id IS NULL;
UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;
CREATE UNIQUE INDEX idx_sessions_id ON sessions(id);
CREATE INDEX idx_sessions_person ON sessions(person_id);
`);

/** (addition) Create a session token for a person. Only a keyed hash of the token is stored. Lifetime: sessionTtlDays(), sliding. */
export function createSession(personId: string, opts: { label?: string } = {}): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const iso = new Date(now).toISOString();
  getDb().prepare("INSERT INTO sessions (token_hash, person_id, created_at, expires_at, id, last_seen_at, label) VALUES (?,?,?,?,?,?,?)").run(
    getKeys().hmac("session", token), personId, iso, new Date(now + sessionTtlDays() * 86400000).toISOString(),
    crypto.randomBytes(8).toString("hex"), iso, opts.label ? String(opts.label).slice(0, 60) : null);
  return token;
}
/** (addition) Revoke every session of a person. */
export function revokeSessions(personId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE person_id = ?").run(personId);
}
export interface SessionInfo { id: string; created_at: string; last_seen_at: string | null; expires_at: string; label: string | null }
/** (addition, S-59) Live sessions of a person (never includes the token or its hash). */
export function listSessions(personId: string, now: Date = new Date()): SessionInfo[] {
  return getDb().prepare("SELECT id, created_at, last_seen_at, expires_at, label FROM sessions WHERE person_id = ? AND expires_at > ? ORDER BY created_at DESC")
    .all(personId, now.toISOString()) as unknown as SessionInfo[];
}
/** (addition, S-59) Revoke one session by its public id; false when it is not this person's. */
export function revokeSessionById(personId: string, sessionId: string): boolean {
  return Number(getDb().prepare("DELETE FROM sessions WHERE person_id = ? AND id = ?").run(personId, sessionId).changes) > 0;
}

/** Express middleware: requires header `Authorization: Bearer <session token>`; sets req.person and req.sessionId; 401 JSON {error} otherwise. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) { res.status(401).json({ error: "authentication required" }); return; }
  try {
    const th = getKeys().hmac("session", m[1]);
    const row = getDb().prepare(
      `SELECT p.id AS id, p.tier AS tier, s.expires_at AS exp, s.id AS sid, s.created_at AS created, s.last_seen_at AS seen
         FROM sessions s JOIN persons p ON p.id = s.person_id
        WHERE s.token_hash = ? AND p.deleted_at IS NULL`).get(th) as { id: string; tier: Tier; exp: string; sid: string | null; created: string; seen: string | null } | undefined;
    const now = Date.now();
    if (!row || row.exp < new Date(now).toISOString()) { res.status(401).json({ error: "invalid or expired session" }); return; }
    // Sliding refresh (at most every 5 minutes), never past the absolute cap.
    if (!row.seen || now - new Date(row.seen).getTime() > SESSION_TOUCH_MS) {
      const cap = new Date(row.created).getTime() + sessionMaxDays() * 86400000;
      const next = Math.min(now + sessionTtlDays() * 86400000, cap);
      getDb().prepare("UPDATE sessions SET last_seen_at = ?, expires_at = MAX(expires_at, ?) WHERE token_hash = ?").run(new Date(now).toISOString(), new Date(next).toISOString(), th);
    }
    req.person = { id: row.id, tier: row.tier, roles: listRoles(row.id).map((r) => r.role) };
    if (row.sid) req.sessionId = row.sid;
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

/** Append to the hash-chained audit log. Phone numbers, PINs, OTPs, tokens and response contents never reach the log: scrubAuditMeta redacts them (S-160, T-31). */
export function audit(actor: string, action: string, object: string, meta?: Record<string, unknown>): void {
  const metaJson = canonicalJson(scrubAuditMeta(meta));
  const ts = new Date().toISOString();
  writeAtCommit(() => writeAudit(actor, action, object, metaJson, ts));
}

function writeAudit(actor: string, action: string, object: string, metaJson: string, ts: string): void {
  const d = getStore("audit");
  const k = getKeys();
  runInStore("audit", () => {
    const last = d.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? GENESIS;
    const row = { seq, ts, action, actor_d: k.hmac("audit", actor), object_d: k.hmac("audit", object), meta_d: k.hmac("audit", metaJson) };
    d.prepare(`INSERT INTO audit_log (seq, ts, actor, action, object, meta, actor_d, object_d, meta_d, redacted, prev_hash, hash)
               VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`).run(seq, ts, actor, action, object, metaJson, row.actor_d, row.object_d, row.meta_d, prev, rowHash(prev, row));
  });
}

/** (addition) Log a privileged/sensitive read (who, what, why). Call this wherever an operator reads personal data. */
export function auditPrivilegedRead(actor: string, object: string, purpose: string): void {
  audit(actor, "read.sensitive", object, { purpose });
}

/** (addition) Redact every audit row whose actor or object refers to `subjectId` (bare id or "kind:<id>"). Chain still verifies. */
export function redactAuditFor(subjectId: string): number {
  const d = getStore("audit");
  const rows = d.prepare("SELECT seq, actor, object FROM audit_log WHERE redacted = 0").all() as { seq: number; actor: string; object: string }[];
  const hit = rows.filter((r) => r.actor === subjectId || r.object === subjectId || r.actor.endsWith(":" + subjectId) || r.object.endsWith(":" + subjectId)).map((r) => r.seq);
  if (hit.length === 0) return 0;
  const upd = d.prepare("UPDATE audit_log SET actor = ?, object = ?, meta = ?, redacted = 1 WHERE seq = ?");
  runInStore("audit", () => {
    for (const s of hit) upd.run(REDACTED, REDACTED, "{}", s);
    audit("system", "audit.redact", "audit_log", { seqs: hit, reason: "erasure" });
  });
  return hit.length;
}

export interface AnchorRecord { seq: number; hash: string; ts: string }
/** External anchoring: publish the chain head to a store the DB operator cannot rewrite (WORM bucket, transparency log, notary). */
export interface AnchorSink {
  /** May return a promise (network sinks); anchorAuditHead never waits for it. */
  publish(rec: AnchorRecord): void | Promise<void>;
  /** Anchors this sink has durably accepted (sync: network sinks answer from their acknowledgement ledger). */
  list(): AnchorRecord[];
  /** Short label for status endpoints. */
  kind?: string;
  /** Network sinks: re-send anchors that were not acknowledged yet. */
  retryPending?(): Promise<number>;
  /** Network sinks: ask the witness for the latest anchor it holds (independent of the local database). */
  fetchLast?(): Promise<AnchorRecord | null>;
}
export class NoopAnchorSink implements AnchorSink { kind = "none"; publish(): void { /* none */ } list(): AnchorRecord[] { return []; } }
/** Dev sink: JSON lines in a local file (not tamper-proof against someone who owns the machine; stands in for a real sink). */
export class FileAnchorSink implements AnchorSink {
  kind = "file";
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
/**
 * (addition, S-144) HTTP witness: POSTs `{seq, hash, ts}` to `url` (an independent append-only service, transparency log or notary).
 * The body is signed: header `x-civic-signature: sha256=<hex HMAC-SHA256 of canonicalJson(body) under CIVIC_ANCHOR_SECRET>` plus
 * `x-civic-timestamp`. Any 2xx acknowledges. Anchors are first written to the local `audit_anchors` ledger as "pending", then delivered
 * with exponential-backoff retries (default 4 attempts); unacknowledged ones are re-sent by retryPending() (the anchor job calls it).
 * list() returns only ACKNOWLEDGED anchors. fetchLast() does `GET url` expecting the latest `{seq, hash, ts}` the witness holds, which
 * is what an auditor compares with the local head (the local ledger alone is as rewritable as the chain itself).
 */
export class HttpWitnessAnchorSink implements AnchorSink {
  kind = "http";
  private opts: { retries: number; baseDelayMs: number; timeoutMs: number; fetchFn: typeof fetch };
  constructor(private url: string, private secret: string, opts: { retries?: number; baseDelayMs?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {}) {
    this.opts = { retries: opts.retries ?? 4, baseDelayMs: opts.baseDelayMs ?? 500, timeoutMs: opts.timeoutMs ?? 5000, fetchFn: opts.fetchFn ?? fetch };
  }
  private sign(body: string, ts: string): string {
    return "sha256=" + crypto.createHmac("sha256", this.secret).update(ts + "." + body).digest("hex");
  }
  publish(rec: AnchorRecord): Promise<void> {
    getStore("audit").prepare("INSERT OR IGNORE INTO audit_anchors (seq, hash, ts, status, attempts) VALUES (?,?,?,'pending',0)").run(rec.seq, rec.hash, rec.ts);
    return this.deliver(rec).then(() => undefined, () => undefined);
  }
  /** Deliver one anchor with retries. Resolves true once acknowledged. Never throws. */
  async deliver(rec: AnchorRecord): Promise<boolean> {
    for (let attempt = 1; attempt <= this.opts.retries; attempt++) {
      let err: string;
      try {
        const body = canonicalJson({ seq: rec.seq, hash: rec.hash, ts: rec.ts });
        const stamp = new Date().toISOString();
        const r = await this.opts.fetchFn(this.url, {
          method: "POST", signal: AbortSignal.timeout(this.opts.timeoutMs),
          headers: { "content-type": "application/json", "x-civic-signature": this.sign(body, stamp), "x-civic-timestamp": stamp }, body,
        });
        if (r.ok) {
          try { getStore("audit").prepare("UPDATE audit_anchors SET status='acked', attempts = attempts + 1, last_error = NULL, acked_at = ? WHERE seq = ? AND hash = ?").run(new Date().toISOString(), rec.seq, rec.hash); } catch { /* db closed (tests) */ }
          return true;
        }
        err = "http " + r.status;
      } catch (e) { err = ((e as Error).message || "error").slice(0, 120); }
      try { getStore("audit").prepare("UPDATE audit_anchors SET attempts = attempts + 1, last_error = ? WHERE seq = ? AND hash = ?").run(err, rec.seq, rec.hash); } catch { return false; }
      if (attempt < this.opts.retries) await new Promise((res) => { const t = setTimeout(res, this.opts.baseDelayMs * 2 ** (attempt - 1)); t.unref?.(); });
    }
    return false;
  }
  async retryPending(): Promise<number> {
    const rows = getStore("audit").prepare("SELECT seq, hash, ts FROM audit_anchors WHERE status = 'pending' ORDER BY seq").all() as unknown as AnchorRecord[];
    let ok = 0;
    for (const r of rows) if (await this.deliver(r)) ok++;
    return ok;
  }
  list(): AnchorRecord[] {
    return getStore("audit").prepare("SELECT seq, hash, ts FROM audit_anchors WHERE status = 'acked' ORDER BY seq").all() as unknown as AnchorRecord[];
  }
  pendingCount(): number {
    return (getStore("audit").prepare("SELECT COUNT(*) AS c FROM audit_anchors WHERE status = 'pending'").get() as { c: number }).c;
  }
  async fetchLast(): Promise<AnchorRecord | null> {
    const r = await this.opts.fetchFn(this.url, { method: "GET", signal: AbortSignal.timeout(this.opts.timeoutMs), headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<AnchorRecord>;
    return typeof j.seq === "number" && typeof j.hash === "string" ? { seq: j.seq, hash: j.hash, ts: String(j.ts ?? "") } : null;
  }
}

let anchorSink: AnchorSink | null = null;
export function getAnchorSink(): AnchorSink {
  if (!anchorSink) {
    const url = process.env.CIVIC_ANCHOR_URL;
    if (url) anchorSink = new HttpWitnessAnchorSink(url, process.env.CIVIC_ANCHOR_SECRET || (isProd() ? "" : "civic-dev-anchor-secret"));
    else anchorSink = process.env.CIVIC_AUDIT_ANCHOR_FILE ? new FileAnchorSink(process.env.CIVIC_AUDIT_ANCHOR_FILE) : new NoopAnchorSink();
  }
  return anchorSink;
}
export function setAnchorSink(s: AnchorSink | null): void { anchorSink = s; }

/** (addition) Publish the current chain head to the anchor sink. Run periodically (e.g. hourly). Returns the record or null if empty. */
export function anchorAuditHead(): AnchorRecord | null {
  const last = getStore("audit").prepare("SELECT seq, hash, ts FROM audit_log ORDER BY seq DESC LIMIT 1").get() as unknown as AnchorRecord | undefined;
  if (!last) return null;
  const rec = { seq: last.seq, hash: last.hash, ts: new Date().toISOString() };
  const sink = getAnchorSink();
  if (sink.retryPending) sink.retryPending().catch(() => { /* retried next run */ }); // older unacknowledged anchors first
  const p = sink.publish(rec);
  if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => { /* delivery failures stay "pending" and are retried */ });
  return rec;
}

/** (addition, S-144) Latest chain head: `count` is the number of entries. Null when the log is empty. */
export function auditHead(): { seq: number; hash: string; ts: string; count: number } | null {
  const d = getStore("audit");
  const last = d.prepare("SELECT seq, hash, ts FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string; ts: string } | undefined;
  if (!last) return null;
  const count = (d.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
  return { ...last, count };
}

/**
 * (addition, S-144) Public, redacted view of the chain from `fromSeq` (inclusive): sequence, hour-bucketed time, the coarse action class
 * (text before the first "." or "_") and the row hashes. No actor, no object, no meta, so it can be published without leaking who did what.
 */
export function auditPublicEntries(fromSeq = 1, limit = 200): { entries: { seq: number; hour: string; class: string; prev_hash: string; hash: string }[]; next_from: number | null } {
  const from = Math.max(1, Math.floor(Number(fromSeq)) || 1);
  const lim = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 200));
  const rows = getStore("audit").prepare("SELECT seq, ts, action, prev_hash, hash FROM audit_log WHERE seq >= ? ORDER BY seq ASC LIMIT ?").all(from, lim + 1) as unknown as
    { seq: number; ts: string; action: string; prev_hash: string; hash: string }[];
  const page = rows.slice(0, lim).map((r) => ({
    seq: r.seq, hour: r.ts.slice(0, 13) + ":00:00Z", class: r.action.split(/[._]/)[0].slice(0, 24), prev_hash: r.prev_hash, hash: r.hash,
  }));
  return { entries: page, next_from: rows.length > lim ? rows[lim].seq : null };
}

export interface AnchorStatus {
  sink: string;
  head: { seq: number; hash: string } | null;
  last_anchor: AnchorRecord | null;
  /** True when the chain row at the last anchor's seq still has the anchored hash; null when nothing is anchored yet. */
  anchor_matches_chain: boolean | null;
  unanchored_entries: number;
  chain_ok: boolean;
}
/** (addition, S-144) Compare the local head with the last anchored value (local ledger). Async witness comparison: see admin/audit routes. */
export function anchorStatus(): AnchorStatus {
  const sink = getAnchorSink();
  const anchors = sink.list();
  const last = anchors.length ? anchors.reduce((a, b) => (b.seq >= a.seq ? b : a)) : null;
  const head = auditHead();
  let matches: boolean | null = null;
  if (last) {
    const row = getStore("audit").prepare("SELECT hash FROM audit_log WHERE seq = ?").get(last.seq) as { hash: string } | undefined;
    matches = !!row && row.hash === last.hash;
  }
  return {
    sink: sink.kind ?? "custom", head: head ? { seq: head.seq, hash: head.hash } : null, last_anchor: last, anchor_matches_chain: matches,
    unanchored_entries: head ? head.seq - (last?.seq ?? 0) : 0, chain_ok: verifyAuditChain().ok,
  };
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
  const d = getStore("audit");
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

/**
 * (addition) Erasure hooks. DELETE /me (identity deleteAccount) must leave no trace of the person in any store, but a transaction never
 * spans two stores, so erasure is staged:
 *   1. registerErasureHook(name, fn(personId))        runs against the IDENTITY store, inside the caller's identity transaction.
 *   2. registerErasureSubjects(name, fn(personId))     returns the keyed pseudonyms the person has in OTHER stores (read BEFORE step 1
 *                                                      deletes the identity-side links).
 *   3. registerStoreErasureHook(store, name, fn(subjects))  unlinks those pseudonyms in another store. Idempotent. Run after the identity
 *                                                      transaction commits, driven by the erasure outbox (identity store) and retried
 *                                                      by the `retryErasureOutbox` job until it succeeds.
 * runErasureHooks(personId) is the all-in-one form (identity hooks, then the other stores) used by tests and scripts.
 */
export type ErasureHook = (personId: string) => void;
export type StoreErasureHook = (subjects: string[]) => void;
const erasureHooks: { name: string; fn: ErasureHook }[] = [];
const storeErasureHooks: { store: StoreName; name: string; fn: StoreErasureHook }[] = [];
const subjectProviders: { name: string; fn: (personId: string) => string[] }[] = [];
export function registerErasureHook(name: string, fn: ErasureHook): void {
  const i = erasureHooks.findIndex((h) => h.name === name);
  if (i >= 0) erasureHooks[i] = { name, fn }; else erasureHooks.push({ name, fn });
}
export function registerStoreErasureHook(store: StoreName, name: string, fn: StoreErasureHook): void {
  if (store === "identity") throw new Error("identity-store erasure hooks use registerErasureHook (they receive the person id)");
  const i = storeErasureHooks.findIndex((h) => h.name === name);
  if (i >= 0) storeErasureHooks[i] = { store, name, fn }; else storeErasureHooks.push({ store, name, fn });
}
export function registerErasureSubjects(name: string, fn: (personId: string) => string[]): void {
  const i = subjectProviders.findIndex((h) => h.name === name);
  if (i >= 0) subjectProviders[i] = { name, fn }; else subjectProviders.push({ name, fn });
}
/** Pseudonyms of `personId` in the other stores (call before the identity hooks delete the links). */
export function collectErasureSubjects(personId: string): string[] {
  return [...new Set(subjectProviders.flatMap((p) => p.fn(personId)))];
}
/** Identity-store hooks only (run inside the caller's identity transaction). Returns the hook names. */
export function runIdentityErasureHooks(personId: string): string[] {
  const ran: string[] = [];
  for (const h of erasureHooks) { h.fn(personId); ran.push(h.name); }
  return ran;
}
/** Other-store hooks for the given pseudonyms. All hooks of one store run in ONE transaction of that store (a failure rolls that store back and throws; nothing is skipped silently). */
export function runStoreErasureHooks(subjects: string[]): string[] {
  const ran: string[] = [];
  for (const store of new Set(storeErasureHooks.map((h) => h.store))) {
    const mine = storeErasureHooks.filter((h) => h.store === store);
    runInStore(store, () => { for (const h of mine) h.fn(subjects); });
    ran.push(...mine.map((h) => h.name));
  }
  return ran;
}
/** Every hook for one person, in order: subjects, identity hooks, other stores. Not atomic across stores (see above). */
export function runErasureHooks(personId: string): string[] {
  const subjects = collectErasureSubjects(personId);
  return [...runIdentityErasureHooks(personId), ...runStoreErasureHooks(subjects)];
}

/** Queue the cross-store part of an erasure in the identity store (call inside the identity transaction that erases the person). */
export function enqueueStoreErasure(personId: string, subjects: string[]): string {
  const id = crypto.randomUUID();
  getDb().prepare("INSERT INTO erasure_outbox (id, person_id, subjects, created_at) VALUES (?,?,?,?)").run(id, personId, JSON.stringify(subjects), new Date().toISOString());
  return id;
}
export function pendingErasureCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS c FROM erasure_outbox").get() as { c: number }).c;
}
export interface OutboxResult { done: number; failed: number; storeHooks: string[]; auditRedacted: number }
/**
 * Work the erasure outbox: for each pending row unlink the pseudonyms in the other stores, then redact the person's audit rows, then drop
 * the row. Idempotent; a failing step keeps the row (attempts, last_error) for the next run. Never throws. `only` limits it to one row.
 */
export function drainErasureOutbox(only?: string): OutboxResult {
  const out: OutboxResult = { done: 0, failed: 0, storeHooks: [], auditRedacted: 0 };
  let rows: { id: string; person_id: string; subjects: string; stores_done: number; audit_done: number }[] = [];
  try {
    rows = (only
      ? getDb().prepare("SELECT id, person_id, subjects, stores_done, audit_done FROM erasure_outbox WHERE id = ?").all(only)
      : getDb().prepare("SELECT id, person_id, subjects, stores_done, audit_done FROM erasure_outbox ORDER BY created_at LIMIT 200").all()) as typeof rows;
  } catch { return out; } // identity store not migrated / closed
  for (const r of rows) {
    try {
      if (!r.stores_done) {
        out.storeHooks.push(...runStoreErasureHooks(JSON.parse(r.subjects) as string[]));
        getDb().prepare("UPDATE erasure_outbox SET stores_done = 1 WHERE id = ?").run(r.id);
      }
      if (!r.audit_done) {
        out.auditRedacted += redactAuditFor(r.person_id);
        getDb().prepare("UPDATE erasure_outbox SET audit_done = 1 WHERE id = ?").run(r.id);
      }
      getDb().prepare("DELETE FROM erasure_outbox WHERE id = ?").run(r.id);
      out.done++;
    } catch (e) {
      out.failed++;
      try { getDb().prepare("UPDATE erasure_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?").run(String((e as Error).message ?? e).slice(0, 200), r.id); } catch { /* store closed */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Roles, keyed to person_id. One table for every role holder (admin, officer, moderator, politician, journalist,
// eci_liaison, geo_reviewer, volunteer). A role may carry a jurisdiction scope and a department. Grants over HTTP go through the
// dual-control admin API (server/civic/admin); the functions below are the primitive layer (admin or "system" only).
// ---------------------------------------------------------------------------------------------

export type RoleName = "admin" | "officer" | "moderator" | "politician" | "journalist" | "eci_liaison" | "geo_reviewer" | "volunteer" | "survey_panel";
export const ROLE_NAMES: RoleName[] = ["admin", "officer", "moderator", "politician", "journalist", "eci_liaison", "geo_reviewer", "volunteer", "survey_panel"];

registerMigration("core_002_roles", `
CREATE TABLE roles (
  person_id TEXT NOT NULL,
  role TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT '',
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (person_id, role, jurisdiction)
);
`);
registerMigration("core_004_roles_department", `
ALTER TABLE roles ADD COLUMN department TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_roles_role ON roles(role);
`);
// Erasing a person removes the roles they hold.
registerErasureHook("core.roles", (personId) => { getDb().prepare("DELETE FROM roles WHERE person_id = ?").run(personId); });

/**
 * Grant a role. `grantedBy` must be "system" (ops tooling) or a person holding the admin role. Always audited.
 * jurisdiction = optional scope (e.g. an LGD code); department = optional department (officers).
 */
export function grantRole(grantedBy: string, personId: string, role: RoleName, jurisdiction?: string | null, department?: string | null): void {
  if (!ROLE_NAMES.includes(role)) throw new Error("unknown role");
  if (grantedBy !== "system" && !hasRole(grantedBy, "admin")) throw new Error("only an admin can grant roles");
  const d = getDb();
  if (!d.prepare("SELECT 1 AS x FROM persons WHERE id = ? AND deleted_at IS NULL").get(personId)) throw new Error("person not found");
  runInTransaction(() => {
    d.prepare("INSERT OR REPLACE INTO roles (person_id, role, jurisdiction, department, granted_by, granted_at) VALUES (?,?,?,?,?,?)")
      .run(personId, role, jurisdiction ?? "", department ?? "", grantedBy, new Date().toISOString());
    if (role === "volunteer") d.prepare("UPDATE persons SET role = 'volunteer' WHERE id = ?").run(personId);
    audit(grantedBy, "role.grant", "person:" + personId, { role, jurisdiction: jurisdiction ?? "", ...(department ? { department } : {}) });
  });
}

/** Revoke a role (all scopes of it). Same authority rule as grantRole. */
export function revokeRole(revokedBy: string, personId: string, role: RoleName): void {
  if (revokedBy !== "system" && !hasRole(revokedBy, "admin")) throw new Error("only an admin can revoke roles");
  runInTransaction(() => {
    getDb().prepare("DELETE FROM roles WHERE person_id = ? AND role = ?").run(personId, role);
    if (role === "volunteer") getDb().prepare("UPDATE persons SET role = 'resident' WHERE id = ? AND role = 'volunteer'").run(personId);
    audit(revokedBy, "role.revoke", "person:" + personId, { role });
  });
}

const isPersonVolunteer = (personId: string): boolean =>
  !!getDb().prepare("SELECT 1 AS x FROM persons WHERE id = ? AND role = 'volunteer' AND deleted_at IS NULL").get(personId);

/** Does the person hold `role`? With `jurisdiction`, an unscoped grant or an exact-scope grant qualifies. "volunteer" also honours persons.role. */
export function hasRole(personId: string, role: RoleName, jurisdiction?: string | null): boolean {
  const rows = getDb().prepare(
    "SELECT r.jurisdiction AS j FROM roles r JOIN persons p ON p.id = r.person_id WHERE r.person_id = ? AND r.role = ? AND p.deleted_at IS NULL").all(personId, role) as { j: string }[];
  if (rows.length === 0) return role === "volunteer" && isPersonVolunteer(personId);
  if (jurisdiction == null || jurisdiction === "") return true;
  return rows.some((r) => r.j === "" || r.j === jurisdiction);
}

/** (addition) True when the person holds at least one of the roles (same scope rule as hasRole). */
export function hasAnyRole(personId: string, roles: RoleName[], jurisdiction?: string | null): boolean {
  return roles.some((r) => hasRole(personId, r, jurisdiction));
}

export function listRoles(personId: string): { role: RoleName; jurisdiction: string | null }[] {
  const rows = getDb().prepare("SELECT role, jurisdiction FROM roles WHERE person_id = ? ORDER BY role, jurisdiction").all(personId) as { role: RoleName; jurisdiction: string }[];
  const out = rows.map((r) => ({ role: r.role, jurisdiction: r.jurisdiction || null }));
  if (!out.some((r) => r.role === "volunteer") && isPersonVolunteer(personId)) out.push({ role: "volunteer", jurisdiction: null });
  return out;
}

/** (addition) Like listRoles, with the department and grant metadata. */
export function listRolesDetailed(personId: string): { role: RoleName; jurisdiction: string | null; department: string | null; granted_by: string; granted_at: string }[] {
  const rows = getDb().prepare("SELECT role, jurisdiction, department, granted_by, granted_at FROM roles WHERE person_id = ? ORDER BY role, jurisdiction").all(personId) as unknown as
    { role: RoleName; jurisdiction: string; department: string; granted_by: string; granted_at: string }[];
  return rows.map((r) => ({ role: r.role, jurisdiction: r.jurisdiction || null, department: r.department || null, granted_by: r.granted_by, granted_at: r.granted_at }));
}

/** Express middleware: authenticates (as requireAuth) and then requires a role (any of several when more than one is given); 403 JSON {error} otherwise. */
export function requireRole(...roles: RoleName[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    requireAuth(req, res, () => {
      if (!req.person || !hasAnyRole(req.person.id, roles)) { res.status(403).json({ error: "forbidden: " + roles.join(" or ") + " role required" }); return; }
      next();
    });
  };
}
