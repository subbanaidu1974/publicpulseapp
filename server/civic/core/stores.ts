/**
 * STORE SEPARATION (S-74, docs/STORES.md). The civic data lives in four SEPARATE SQLite databases, each with its own file,
 * migration runner (checksums, drift detection, pre-migrate backup), backup and retention. There is no ATTACH and no SQL that
 * spans two stores: a module that needs data from two stores reads each store separately and combines them in code.
 *
 *   identity  persons, sessions, roles, otps, rate limits, pin_failures, consents, households, enrolments, admin MFA, officer roles,
 *             has_responded, the keyed issue-link ledger and the erasure outbox
 *   issues    issues, me-too, events, samples, appeals, rebuttals, moderation, lexicon changes, media, geography, IVR call state.
 *             It holds NO persons.id: people appear only as keyed pseudonyms (server/civic/core/pseudonyms.ts)
 *   survey    placeholder for Phase 2 (own file + migration runner; response rows will carry no person id)
 *   audit     the hash-chained audit log and its anchor ledger, in a file a compromise of another store cannot rewrite
 *
 * Files: CIVIC_IDENTITY_DB / CIVIC_ISSUES_DB / CIVIC_SURVEY_DB / CIVIC_AUDIT_DB. When one is unset it is derived from CIVIC_DB
 * (default data/civic.db): `civic.db` -> `civic.identity.db`, `civic.issues.db`, `civic.survey.db`, `civic.audit.db`; a CIVIC_DB that is an
 * existing directory (or ends with a path separator) -> `<dir>/identity.db` ... ; ":memory:" gives four in-memory databases.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StoreName = "identity" | "issues" | "survey" | "audit";
export const STORE_NAMES: StoreName[] = ["identity", "issues", "survey", "audit"];

/**
 * Every table civic code creates, by owning store. migrate() fails when a table of one store shows up in another (a misplaced
 * migration) and the runtime check `assertStorePlacement()` / tests/civic/stores.test.ts enforce the same rule on live files.
 * Tables created by tests or other modules that are not listed here are tolerated; the rule is about placing KNOWN tables.
 */
export const STORE_TABLES: Record<StoreName, string[]> = {
  identity: [
    "migrations", "store_meta", "persons", "sessions", "consents", "roles", "otps", "rate_events", "attestations", "has_responded", "pin_failures",
    "survey_closures", "enrolments", "hh_household", "hh_member", "hh_invite", "hh_pin", "hh_invite_cooldown", "hh_transfer", "admin_mfa",
    "admin_mfa_recovery", "role_requests", "officer_role", "issue_links", "erasure_outbox", "people_requests", "people_takedowns", "sms_ledger", "provider_keys",
    "cred_idem",
    // government notifications (server/civic/notify)
    "notify_orgs", "notify_senders", "notify_credentials", "notify_challenges", "notify_messages", "notify_approvals", "notify_inbox", "notify_person",
    "notify_prefs", "notify_devices", "notify_block_log", "notify_kill",
  ],
  issues: [
    "migrations", "issue", "issue_me_too", "issue_event", "issue_sample", "officer_rebuttal", "issue_appeal", "moderation_action", "lexicon_change",
    "issue_media", "admin_unit", "hamlet", "village_constituency", "ivr_call",
  ],
  survey: [
    "migrations", "survey_meta",
    // registry (server/civic/surveys/registry.ts)
    "surveys", "survey_questions", "survey_options", "survey_versions", "panel_reviews", "cancellations", "survey_registry_log", "survey_quota_events",
    // published figures (server/civic/surveys/results.ts, budget.ts)
    "survey_results", "survey_query_budget",
    // anonymous credential + responses (server/civic/surveys/responses.ts, credential.ts)
    "survey_signing_key", "spent_token", "survey_response", "survey_response_assisted", "response_journal",
    // bill consultations (server/civic/consultations/schema.ts)
    "consultations", "consultation_versions", "consultation_corrections", "consultation_panel_reviews", "consultation_audio_reviews", "consultation_log",
    "consultation_feedback", "consultation_burst", "consultation_comment_reviews", "consultation_machine_items", "consultation_themes", "consultation_responses",
    "consultation_reports",
  ],
  audit: ["migrations", "audit_log", "audit_anchors"],
};
const OWNER = new Map<string, StoreName>();
for (const s of STORE_NAMES) for (const t of STORE_TABLES[s]) if (t !== "migrations") OWNER.set(t, s);
/** Which store owns a known table name (undefined for unknown/test tables). */
export const ownerOfTable = (table: string): StoreName | undefined => OWNER.get(table);

const isTest = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;

const ENV_FILE: Record<StoreName, string> = { identity: "CIVIC_IDENTITY_DB", issues: "CIVIC_ISSUES_DB", survey: "CIVIC_SURVEY_DB", audit: "CIVIC_AUDIT_DB" };

/** The CIVIC_DB value (file, directory or ":memory:"); ":memory:" under vitest when unset. */
export function baseDbPath(): string {
  const v = process.env.CIVIC_DB;
  if (v) return v;
  return isTest() ? ":memory:" : path.join("data", "civic.db");
}

const looksLikeDir = (p: string): boolean => /[\\/]$/.test(p) || (fs.existsSync(p) && fs.statSync(p).isDirectory());

/** Database file (or ":memory:") of a store. */
export function storeFile(name: StoreName): string {
  const o = process.env[ENV_FILE[name]];
  if (o) return o;
  const base = baseDbPath();
  if (base === ":memory:") return ":memory:";
  if (looksLikeDir(base)) return path.join(base, `${name}.db`);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem}.${name}.db`;
}

/** The pre-split single database file (CIVIC_DB itself), when it is a regular file that is not also one of the store files. */
export function legacyDbFile(): string | null {
  const base = baseDbPath();
  if (base === ":memory:" || looksLikeDir(base)) return null;
  if (STORE_NAMES.some((s) => path.resolve(storeFile(s)) === path.resolve(base))) return null;
  try { return fs.statSync(base).isFile() ? path.resolve(base) : null; } catch { return null; }
}

const handles = new Map<StoreName, DatabaseSync>();

/** The node:sqlite handle of one store (opened on first use; WAL for files). One shared handle per store. */
export function getStore(name: StoreName): DatabaseSync {
  const have = handles.get(name);
  if (have) return have;
  if (!STORE_NAMES.includes(name)) throw new Error(`unknown civic store "${String(name)}"`);
  const file = storeFile(name);
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  handles.set(name, db);
  return db;
}

/** Close every open store handle and forget transaction state (tests, backup drills). */
export function closeStores(): void {
  for (const db of handles.values()) { try { db.close(); } catch { /* ignore */ } }
  handles.clear();
  txDepth.clear();
  txActive = 0; flushing = false; held = [];
}

// ---------------------------------------------------------------------------------------------
// Transactions (per store; a transaction never spans two stores)
// ---------------------------------------------------------------------------------------------

const txDepth = new Map<StoreName, number>();

// Audit entries written while a transaction is open are HELD and written to the audit store just before the OUTERMOST transaction
// commits (a rollback or throw discards them, nested savepoints discard only their own). So "the action and its audit row stand or fall
// together" still holds for rollbacks, and an action never commits without its audit row (a failing audit write rolls the action back).
// The only gap left by the store split is a crash between the audit commit and the action commit: a spurious audit row, never a missing one.
let txActive = 0;
let flushing = false;
let held: (() => void)[] = [];
/** Run `write` now, or hold it until the outermost open transaction is about to commit (see above). */
export function writeAtCommit(write: () => void): void {
  if (txActive === 0 || flushing) write(); else held.push(write);
}

/** Run fn in one transaction of ONE store (outermost = BEGIN IMMEDIATE, nested = SAVEPOINT). Any throw rolls that store back. */
export function runInStore<T>(name: StoreName, fn: () => T): T {
  const d = getStore(name);
  const depth = txDepth.get(name) ?? 0;
  const sp = "sp_" + depth;
  const counted = name !== "audit" && !flushing; // the audit store's own transactions are the flush (or the chain itself)
  const mark = held.length;
  d.exec(depth === 0 ? "BEGIN IMMEDIATE" : "SAVEPOINT " + sp);
  txDepth.set(name, depth + 1);
  if (counted) txActive++;
  try {
    const r = fn();
    if (counted && txActive === 1 && held.length) {
      const q = held; held = [];
      flushing = true;
      try { for (const w of q) w(); } finally { flushing = false; }
    }
    if (counted) txActive--;
    txDepth.set(name, depth);
    d.exec(depth === 0 ? "COMMIT" : "RELEASE " + sp);
    return r;
  } catch (e) {
    if (counted) txActive--;
    if (held.length > mark) held.length = mark;
    txDepth.set(name, depth);
    try { d.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* already rolled back */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Migrations (one registry and one `migrations` table per store)
// ---------------------------------------------------------------------------------------------

export interface MigrationDef { id: string; sql: string; store: StoreName }
const registry: Record<StoreName, MigrationDef[]> = { identity: [], issues: [], survey: [], audit: [] };

/**
 * Register an idempotent migration (SQL text, run once per id per store, in registration order). Call at module load.
 * `store` defaults to "identity" (the historical single database). Re-registering an id is a no-op.
 */
export function registerMigration(id: string, sql: string, store: StoreName = "identity"): void {
  if (!STORE_NAMES.includes(store)) throw new Error(`unknown civic store "${String(store)}"`);
  if (STORE_NAMES.some((s) => registry[s].some((m) => m.id === id))) return;
  registry[store].push({ id, sql, store });
}
/** All registered migrations (docs, tests; e.g. to build a legacy single-file fixture). */
export const registeredMigrations = (): MigrationDef[] => STORE_NAMES.flatMap((s) => registry[s].map((m) => ({ ...m })));

export const checksumOf = (sql: string) => crypto.createHash("sha256").update(sql).digest("hex");

function ensureMigrationsTable(d: DatabaseSync): void {
  d.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT)");
  const cols = d.prepare("PRAGMA table_info(migrations)").all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === "checksum")) d.exec("ALTER TABLE migrations ADD COLUMN checksum TEXT");
}

export interface StoreMigrationStatus { registered: number; applied: number; pending: string[]; drift: string[] }

/** Applied vs registered migrations of one store. `drift` lists applied migrations whose SQL no longer matches the stored checksum. */
export function storeMigrationStatus(name: StoreName): StoreMigrationStatus {
  const d = getStore(name);
  ensureMigrationsTable(d);
  const list = registry[name];
  const rows = d.prepare("SELECT id, checksum FROM migrations").all() as unknown as { id: string; checksum: string | null }[];
  const have = new Map(rows.map((r) => [r.id, r.checksum]));
  const pending = list.filter((m) => !have.has(m.id)).map((m) => m.id);
  const drift = list.filter((m) => have.has(m.id) && have.get(m.id) && have.get(m.id) !== checksumOf(m.sql)).map((m) => m.id);
  return { registered: list.length, applied: rows.length, pending, drift };
}

/** Online, consistent copy of one store into a NEW file (`VACUUM INTO`; WAL-safe). Plaintext SQLite: as sensitive as the live file. */
export function backupStoreTo(name: StoreName, dest: string): void {
  const target = path.resolve(dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  getStore(name).exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  try { fs.chmodSync(target, 0o600); } catch { /* best effort (Windows) */ }
}

function preMigrateBackup(name: StoreName): void {
  const file = storeFile(name);
  if (file === ":memory:") return;
  const dir = path.join(path.dirname(path.resolve(file)), "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // identity keeps the historical file name; the other stores carry their name so each store rotates on its own
  const prefix = name === "identity" ? "pre-migrate-" : `pre-migrate-${name}-`;
  backupStoreTo(name, path.join(dir, `${prefix}${stamp}.db`));
  const re = name === "identity" ? /^pre-migrate-\d.*\.db$/ : new RegExp(`^pre-migrate-${name}-\\d.*\\.db$`);
  const old = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 5))) { try { fs.rmSync(path.join(dir, f)); } catch { /* ignore */ } }
}

/**
 * Run the registered migrations of one store. Each applied migration stores the sha256 of its SQL; if an applied migration's SQL has
 * changed since (drift) this throws unless CIVIC_ALLOW_DRIFT=1. When migrations are pending on a non-empty file store, a copy is
 * written first to <store dir>/backups/ (newest 5 kept; CIVIC_PREMIGRATE_BACKUP=0 disables).
 */
export function migrateStore(name: StoreName): void {
  const d = getStore(name);
  ensureMigrationsTable(d);
  const st = storeMigrationStatus(name);
  const list = registry[name];
  if (st.drift.length) {
    const msg = `civic migration drift in the ${name} store: applied migration(s) changed after being applied: ${st.drift.join(", ")}`;
    if (process.env.CIVIC_ALLOW_DRIFT !== "1") throw new Error(msg + " (never edit an applied migration; add a new one. CIVIC_ALLOW_DRIFT=1 overrides)");
    console.warn("[civic] WARNING: " + msg + " (continuing because CIVIC_ALLOW_DRIFT=1)");
  }
  for (const m of list) d.prepare("UPDATE migrations SET checksum = ? WHERE id = ? AND checksum IS NULL").run(checksumOf(m.sql), m.id); // legacy rows
  if (st.pending.length && st.applied > 0 && process.env.CIVIC_PREMIGRATE_BACKUP !== "0") preMigrateBackup(name);
  for (const m of list) {
    if (d.prepare("SELECT 1 AS x FROM migrations WHERE id = ?").get(m.id)) continue;
    d.exec("BEGIN");
    try {
      d.exec(m.sql);
      d.prepare("INSERT INTO migrations (id, applied_at, checksum) VALUES (?, ?, ?)").run(m.id, new Date().toISOString(), checksumOf(m.sql));
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch { /* ignore */ }
      throw new Error(`civic migration ${m.id} (${name} store) failed: ${(e as Error).message}`);
    }
  }
}

/** Table names in a store (excluding sqlite internals). */
export function tablesOf(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as { name: string }[]).map((r) => r.name);
}

/** Known tables that live in the wrong store, as "table (in <store>, belongs to <store>)". Empty = placement is clean. */
export function misplacedTables(db: DatabaseSync, store: StoreName): string[] {
  const bad: string[] = [];
  for (const t of tablesOf(db)) {
    const owner = ownerOfTable(t);
    if (owner && owner !== store) bad.push(`${t} (in ${store}, belongs to ${owner})`);
  }
  return bad;
}

/** Runtime check: each open store contains only its own tables. Throws on a misplaced table. */
export function assertStorePlacement(): void {
  const bad = STORE_NAMES.flatMap((s) => misplacedTables(getStore(s), s));
  if (bad.length) throw new Error("civic store separation violated: " + bad.join("; "));
}
