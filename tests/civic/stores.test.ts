/**
 * Store separation (S-74, @E2E-89, docs/STORES.md): identity / issues / survey / audit are four separate databases with no cross-store
 * joins, per-store migrations and backups, a pseudonymous reporter link, a staged cross-store account erasure and a one-time import of
 * the pre-split single file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  STORE_NAMES, STORE_TABLES, assertStorePlacement, audit, canonicalJson, getDb, getKeys, getStore, migrate, migrationStatus, misplacedTables, registerErasureHook,
  registerStoreErasureHook, registeredMigrations, resetDbForTests, storeFile, tablesOf, verifyAuditChain, type StoreName,
} from "../../server/civic/core";
import { myIssueIds, pseudonymsOf, reporterPseudonym } from "../../server/civic/core/pseudonyms";
import "../../server/civic/identity/service";
import "../../server/civic/households/routes";
import "../../server/civic/admin/mfa";
import "../../server/civic/geo/service";
import "../../server/civic/channels/callstore";
import "../../server/people-api";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createPerson, deleteAccount } from "../../server/civic/identity/service";
import { clock, meToo, reportIssue } from "../../server/civic/issues/service";
import { defaultJobs } from "../../server/civic/jobs";

const T0 = new Date("2026-03-01T10:00:00Z");
const envSave = { ...process.env };
let dir = "";

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "civic-stores-")); resetDbForTests(); clock.now = () => T0; });
afterEach(() => { resetDbForTests(); process.env = { ...envSave }; fs.rmSync(dir, { recursive: true, force: true }); });

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/** Every (table.column) of the given stores whose text value contains the needle. */
function scan(needle: string, stores: StoreName[]): string[] {
  const hits: string[] = [];
  for (const s of stores) {
    const d = getStore(s);
    for (const t of tablesOf(d)) for (const c of d.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]) {
      if ((d.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`).get(`%${needle}%`) as { c: number }).c) hits.push(`${s}:${t}.${c.name}`);
    }
  }
  return hits;
}

describe("store separation: no cross-store SQL", () => {
  it("@E2E-89 server/civic never ATTACHes a database and no SQL statement names tables of two stores", () => {
    const files = [...walk(path.resolve("server/civic")), path.resolve("server/people-api.ts")].filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(20);
    const owner = new Map<string, StoreName>();
    for (const s of STORE_NAMES) for (const t of STORE_TABLES[s]) if (t !== "migrations") owner.set(t, s);
    const attach: string[] = [], cross: string[] = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      if (/\b(ATTACH|DETACH)\s+(DATABASE\b|['"`$])/i.test(src) || /\bATTACH\s+DATABASE\b/i.test(src)) attach.push(path.relative(process.cwd(), f));
      for (const lit of src.match(/`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"/g) ?? []) {
        if (!/\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/i.test(lit)) continue;
        const stores = new Set<StoreName>();
        // statement tables only: FROM / JOIN / INTO / UPDATE / TABLE name (SQL comments inside the literal are ignored)
        const sql = lit.replace(/--[^\n]*/g, "");
        for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+"?([a-z_][a-z0-9_]*)/gi)) { const s = owner.get(m[1].toLowerCase()); if (s) stores.add(s); }
        if (stores.size > 1) cross.push(`${path.relative(process.cwd(), f)}: ${[...stores].join("+")}: ${lit.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
    expect(attach, "ATTACH/DETACH in server code").toEqual([]);
    expect(cross, "statements spanning two stores").toEqual([]);
  });

  it("@E2E-89 at runtime every store contains only its own tables (and every table is on the allow-list)", () => {
    migrate();
    assertStorePlacement();
    for (const s of STORE_NAMES) {
      const names = tablesOf(getStore(s));
      expect(misplacedTables(getStore(s), s), s).toEqual([]);
      const unknown = names.filter((t) => !STORE_TABLES[s].includes(t));
      expect(unknown, `${s} store has tables missing from STORE_TABLES (add them, in the RIGHT store)`).toEqual([]);
    }
    expect(tablesOf(getStore("issues"))).not.toContain("persons");
    expect(tablesOf(getStore("identity"))).not.toContain("issue");
    expect(tablesOf(getStore("identity"))).not.toContain("audit_log");
    expect(tablesOf(getStore("audit")).sort()).toEqual(["audit_anchors", "audit_log", "migrations"]);
    expect(tablesOf(getStore("survey")).sort()).toEqual(["migrations", "survey_meta"]);
    // a table in the wrong store is caught
    getStore("issues").exec("CREATE TABLE persons (id TEXT)");
    expect(() => assertStorePlacement()).toThrow(/store separation violated.*persons/);
  });

  it("@E2E-89 getDb() is the identity store; the four stores are four different handles", () => {
    migrate();
    expect(getDb()).toBe(getStore("identity"));
    expect(new Set(STORE_NAMES.map((s) => getStore(s))).size).toBe(4);
    expect(() => getStore("nope" as StoreName)).toThrow(/unknown civic store/);
    for (const m of registeredMigrations()) expect(STORE_NAMES).toContain(m.store);
  });
});

describe("store files and environment", () => {
  it("@E2E-89 CIVIC_DB derives one file per store; explicit CIVIC_<STORE>_DB overrides; :memory: works for all four", () => {
    process.env.CIVIC_DB = path.join(dir, "civic.db");
    expect(STORE_NAMES.map((s) => path.basename(storeFile(s)))).toEqual(["civic.identity.db", "civic.issues.db", "civic.survey.db", "civic.audit.db"]);
    process.env.CIVIC_AUDIT_DB = path.join(dir, "elsewhere", "audit.sqlite");
    expect(storeFile("audit")).toBe(path.join(dir, "elsewhere", "audit.sqlite"));
    process.env.CIVIC_DB = dir + path.sep; // a directory
    delete process.env.CIVIC_AUDIT_DB;
    expect(path.basename(storeFile("issues"))).toBe("issues.db");
    process.env.CIVIC_DB = ":memory:";
    expect(STORE_NAMES.map((s) => storeFile(s))).toEqual([":memory:", ":memory:", ":memory:", ":memory:"]);
    delete process.env.CIVIC_DB; // vitest default
    expect(storeFile("identity")).toBe(":memory:");
  });

  it("@E2E-89 on disk each store is its own SQLite file with its own migrations table; the survey store is an empty placeholder", () => {
    process.env.CIVIC_DB = path.join(dir, "civic.db");
    migrate();
    for (const s of STORE_NAMES) {
      expect(fs.existsSync(storeFile(s)), s).toBe(true);
      expect((getStore(s).prepare("SELECT COUNT(*) c FROM migrations").get() as { c: number }).c).toBeGreaterThan(0);
    }
    expect(fs.existsSync(process.env.CIVIC_DB)).toBe(false); // the base name itself is not a database any more
    expect(getStore("survey").prepare("SELECT value FROM survey_meta").get()).toMatchObject({ value: expect.stringContaining("Phase 2") });
    const st = migrationStatus();
    expect(Object.keys(st.stores).sort()).toEqual(["audit", "identity", "issues", "survey"]);
    expect(st.pending).toEqual([]);
    expect(st.registered).toBe(Object.values(st.stores).reduce((n, x) => n + x.registered, 0));
  });

  it("@E2E-89 migration drift is detected per store and names the store; other stores are unaffected", () => {
    process.env.CIVIC_DB = path.join(dir, "civic.db");
    migrate();
    getStore("issues").prepare("UPDATE migrations SET checksum = 'deadbeef' WHERE id = 'issues_001'").run();
    expect(migrationStatus().stores.issues.drift).toEqual(["issues_001"]);
    expect(migrationStatus().stores.identity.drift).toEqual([]);
    resetDbForTests();
    expect(() => migrate()).toThrow(/issues store.*issues_001/);
    process.env.CIVIC_ALLOW_DRIFT = "1";
    resetDbForTests();
    expect(() => migrate()).not.toThrow();
  });

  it("@E2E-89 a compromise of another store cannot rewrite the audit chain: it lives in its own file and verifies independently", () => {
    process.env.CIVIC_DB = path.join(dir, "civic.db");
    migrate();
    audit("system", "test.one", "obj:1");
    audit("system", "test.two", "obj:2");
    expect(verifyAuditChain()).toMatchObject({ ok: true, checked: 2 });
    getDb().exec("DELETE FROM persons; DELETE FROM sessions");
    getStore("issues").exec("DELETE FROM issue");
    expect(verifyAuditChain().ok).toBe(true);
    expect(storeFile("audit")).not.toBe(storeFile("identity"));
  });
});

describe("pseudonymous reporter link", () => {
  beforeEach(() => { migrate(); loadDemoGeo(); });
  const resident = (phone: string) => {
    const p = createPerson({ phone, pin: "4821", consentVersion: "v1" });
    getDb().prepare("UPDATE persons SET residence_unit='DEMO-V-KLR', residence_declared_at=? WHERE id=?").run(T0.toISOString(), p.id);
    return p;
  };

  it("@E2E-89 the issues store holds no persons.id: reporter and supporter are per-issue keyed pseudonyms; identity keeps only an encrypted way back", () => {
    const a = resident("+919876511111"), b = resident("+919876511112");
    const r = reportIssue(a.id, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply here" }, T0);
    meToo(r.id, b.id, T0);
    const second = reportIssue(a.id, { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Pothole outside the school" }, T0);
    for (const id of [a.id, b.id]) expect(scan(id, ["issues", "survey"]), `person id ${id} in issues/survey`).toEqual([]);
    const row = getStore("issues").prepare("SELECT reporter_id FROM issue WHERE id=?").get(r.id) as { reporter_id: string };
    expect(row.reporter_id).toBe(reporterPseudonym(r.id, a.id));
    expect(row.reporter_id).toMatch(/^[0-9a-f]{64}$/);
    // per issue: the same person has DIFFERENT pseudonyms on different issues, so the issues store cannot link a person's reports
    const other = getStore("issues").prepare("SELECT reporter_id FROM issue WHERE id=?").get(second.id) as { reporter_id: string };
    expect(other.reporter_id).not.toBe(row.reporter_id);
    expect(getStore("issues").prepare("SELECT person_id FROM issue_me_too WHERE issue_id=? AND self=0").get(r.id)).toEqual({ person_id: reporterPseudonym(r.id, b.id) });
    // identity side: link ledger, encrypted references, nothing equal to any issues-store value
    const links = getDb().prepare("SELECT person_id, link_key, kind, ref_enc FROM issue_links").all() as { person_id: string; link_key: string; kind: string; ref_enc: string }[];
    expect(links.length).toBe(3);
    for (const l of links) { expect(l.ref_enc.startsWith("v1.")).toBe(true); expect(JSON.stringify(l)).not.toContain(r.id); expect(JSON.stringify(l)).not.toContain(second.id); }
    expect(new Set(myIssueIds(a.id))).toEqual(new Set([r.id, second.id]));
    expect(myIssueIds(b.id)).toEqual([r.id]);
    expect(pseudonymsOf(a.id)).toContain(row.reporter_id);
    // and the identity store has no issue content
    expect(scan("drinking water", ["identity", "audit", "survey"])).toEqual([]);
  });
});

describe("cross-store account erasure", () => {
  beforeEach(() => { migrate(); loadDemoGeo(); });

  it("@E2E-89 identity is erased first; a failing issues step leaves an outbox row that the retry job completes (idempotent)", () => {
    const a = createPerson({ phone: "+919876522221", pin: "4821", consentVersion: "v1" });
    getDb().prepare("UPDATE persons SET residence_unit='DEMO-V-KLR', residence_declared_at=? WHERE id=?").run(T0.toISOString(), a.id);
    const r = reportIssue(a.id, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply here", lat: 16.24, lon: 80.15 }, T0);
    let fail = true;
    registerStoreErasureHook("issues", "test.second_step", () => { if (fail) throw new Error("issues store unavailable"); });
    try {
      const out = deleteAccount(a.id);
      expect(out.pending_cross_store).toBe(true);
      // identity side is already erased and committed
      expect(getDb().prepare("SELECT phone_hash, deleted_at FROM persons WHERE id=?").get(a.id)).toMatchObject({ phone_hash: null, deleted_at: expect.any(String) });
      expect(getDb().prepare("SELECT COUNT(*) c FROM issue_links WHERE person_id=?").get(a.id)).toMatchObject({ c: 0 });
      // the issues store still carries the (now unlinkable) pseudonym until the retry runs
      expect(getStore("issues").prepare("SELECT reporter_id FROM issue WHERE id=?").get(r.id)).toMatchObject({ reporter_id: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const box = getDb().prepare("SELECT person_id, attempts, last_error, stores_done FROM erasure_outbox").all() as { person_id: string; attempts: number; last_error: string; stores_done: number }[];
      expect(box).toEqual([{ person_id: a.id, attempts: 1, last_error: "issues store unavailable", stores_done: 0 }]);
      fail = false;
      const job = defaultJobs().find((j) => j.name === "retryErasureOutbox")!;
      expect(job.run(new Date())).toMatchObject({ done: 1, failed: 0, pending: 0 });
      expect(getDb().prepare("SELECT COUNT(*) c FROM erasure_outbox").get()).toMatchObject({ c: 0 });
      expect(getStore("issues").prepare("SELECT reporter_id, gps_enc FROM issue WHERE id=?").get(r.id)).toMatchObject({ reporter_id: "erased", gps_enc: null });
      expect(job.run(new Date())).toMatchObject({ done: 0, failed: 0, pending: 0 }); // idempotent
      expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE redacted=1").get()).toMatchObject({ c: expect.any(Number) });
      expect(verifyAuditChain().ok).toBe(true);
    } finally { registerStoreErasureHook("issues", "test.second_step", () => { /* healthy */ }); }
  });

  it("@E2E-89 a failure in the identity stage rolls identity back and queues nothing", () => {
    const a = createPerson({ phone: "+919876522222", pin: "4821", consentVersion: "v1" });
    registerErasureHook("test.zz_identity_fail", () => { throw new Error("boom"); });
    try {
      expect(() => deleteAccount(a.id)).toThrow("boom");
      expect(getDb().prepare("SELECT deleted_at FROM persons WHERE id=?").get(a.id)).toMatchObject({ deleted_at: null });
      expect(getDb().prepare("SELECT COUNT(*) c FROM erasure_outbox").get()).toMatchObject({ c: 0 });
    } finally { registerErasureHook("test.zz_identity_fail", () => { /* healthy */ }); }
  });
});

describe("one-time import of the pre-split single database", () => {
  /** A database shaped like the release before the split: every table in ONE file, person ids inside the issue tables. */
  function buildLegacy(file: string) {
    const skip = new Set(["survey_000_init", "core_005_store_meta_links_outbox", "channels_ivr_call_001"]);
    const d = new DatabaseSync(file);
    d.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT)");
    for (const m of registeredMigrations()) if (!skip.has(m.id)) { d.exec(m.sql); d.prepare("INSERT INTO migrations (id, applied_at) VALUES (?,?)").run(m.id, "2026-01-01"); }
    d.exec(`CREATE TABLE ivr_call (call_id TEXT PRIMARY KEY, phone_enc TEXT NOT NULL, state TEXT NOT NULL, category TEXT, reference_id TEXT, last_ref TEXT,
      adults TEXT, person_id TEXT, needs_pin INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    const k = getKeys();
    const ins = (sql: string, ...a: (string | number | null)[]) => d.prepare(sql).run(...a);
    ins("INSERT INTO persons (id, created_at, eligible_from, phone_hash, tier) VALUES ('p-old-1','2026-01-02','2026-01-02', ?, 'T1')", k.hmac("phone", "+919876500001"));
    ins("INSERT INTO persons (id, created_at, eligible_from) VALUES ('p-old-2','2026-01-02','2026-01-02')");
    ins("INSERT INTO persons (id, created_at, eligible_from) VALUES ('mod-old','2026-01-02','2026-01-02')");
    ins("INSERT INTO roles (person_id, role, jurisdiction, department, granted_by, granted_at) VALUES ('mod-old','moderator','','','system','2026-01-02')");
    ins("INSERT INTO officer_role VALUES ('mod-old','moderator',NULL,NULL,'Mod')");
    ins("INSERT INTO sessions (token_hash, person_id, created_at, expires_at, id) VALUES ('th','p-old-1','2026-01-02','2099-01-01','s1')");
    ins("INSERT INTO consents (id, person_id, purpose, version, ts) VALUES ('c1','p-old-1','signup','v1','2026-01-02')");
    ins(`INSERT INTO issue (id,category,desc_en,village_lgd,department,status,moderation,reporter_id,created_at,updated_at,sla_due)
         VALUES ('i-old-1','water','No water','DEMO-V-KLR','Rural Water Supply','Reported','ok','p-old-1','2026-01-03','2026-01-03','2026-01-05')`);
    ins(`INSERT INTO issue (id,category,desc_en,village_lgd,department,status,moderation,reporter_id,created_at,updated_at,sla_due)
         VALUES ('i-old-2','roads','Pothole','DEMO-V-KLR','Roads and Buildings','Reported','ok','erased','2026-01-03','2026-01-03','2026-01-05')`);
    ins("INSERT INTO issue_me_too VALUES ('i-old-1','p-old-1','2026-01-03',1)");
    ins("INSERT INTO issue_me_too VALUES ('i-old-1','p-old-2','2026-01-03',0)");
    ins("INSERT INTO issue_event (issue_id,type,status,village_lgd,category,department,at) VALUES ('i-old-1','reported','Reported','DEMO-V-KLR','water','Rural Water Supply','2026-01-03')");
    ins("INSERT INTO moderation_action (id,issue_id,actor_id,decision,at) VALUES ('m1','i-old-1','mod-old','approve','2026-01-04')");
    ins("INSERT INTO issue_media (id,owner_id,kind,mime,bytes,file,issue_id,created_at,retain_until) VALUES ('0123456789abcdef0123456789abcdef','p-old-1','photo','image/jpeg',10,'x.jpg','i-old-1','2026-01-03','2099-01-01')");
    ins("INSERT INTO ivr_call (call_id,phone_enc,state,adults,person_id,created_at,expires_at) VALUES ('call-1', ?, 'pin', ?, 'p-old-1', 1, 9999999999999)", k.encrypt("ivr-call-phone", "9876500001"), JSON.stringify(["p-old-1", "p-old-2"]));
    // a valid hash chain of two audit rows, written the way the pre-split release did
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    let prev = "0".repeat(64);
    for (const [seq, actor, action, object] of [[1, "p-old-1", "issue.report", "issue:i-old-1"], [2, "system", "job.run", "job:x"]] as const) {
      const row = { seq, ts: "2026-01-03T00:00:0" + seq + "Z", action, actor_d: k.hmac("audit", actor), object_d: k.hmac("audit", object), meta_d: k.hmac("audit", "{}") };
      const hash = sha(prev + canonicalJson(row));
      ins("INSERT INTO audit_log (seq,ts,actor,action,object,meta,actor_d,object_d,meta_d,redacted,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)", seq, row.ts, actor, action, object, "{}", row.actor_d, row.object_d, row.meta_d, prev, hash);
      prev = hash;
    }
    d.close();
  }
  const fileHash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

  it("@E2E-89 copies each table into its store, pseudonymises the issue rows, keeps the old file read-only, and is idempotent", () => {
    const legacy = path.join(dir, "civic.db");
    process.env.CIVIC_DB = legacy;
    migrate(); // registers nothing new; used only to know the migration SQL for the fixture
    resetDbForTests();
    for (const s of STORE_NAMES) fs.rmSync(storeFile(s), { force: true });
    buildLegacy(legacy);
    const before = fileHash(legacy);

    migrate();

    // identity data arrived intact
    expect(getDb().prepare("SELECT COUNT(*) c FROM persons").get()).toMatchObject({ c: 3 });
    expect(getDb().prepare("SELECT role FROM roles WHERE person_id='mod-old'").get()).toMatchObject({ role: "moderator" });
    expect(getDb().prepare("SELECT COUNT(*) c FROM officer_role").get()).toMatchObject({ c: 1 });
    expect(getDb().prepare("SELECT COUNT(*) c FROM sessions").get()).toMatchObject({ c: 1 });
    // issues store: same rows, person ids replaced by pseudonyms, nothing else lost
    const iss = getStore("issues");
    expect(iss.prepare("SELECT COUNT(*) c FROM issue").get()).toMatchObject({ c: 2 });
    expect(iss.prepare("SELECT reporter_id FROM issue WHERE id='i-old-1'").get()).toEqual({ reporter_id: reporterPseudonym("i-old-1", "p-old-1") });
    expect(iss.prepare("SELECT reporter_id FROM issue WHERE id='i-old-2'").get()).toEqual({ reporter_id: "erased" });
    expect(iss.prepare("SELECT COUNT(*) c FROM issue_me_too").get()).toMatchObject({ c: 2 });
    expect(iss.prepare("SELECT COUNT(*) c FROM issue_event").get()).toMatchObject({ c: 1 });
    expect(iss.prepare("SELECT COUNT(*) c FROM issue_media").get()).toMatchObject({ c: 1 });
    expect(iss.prepare("SELECT person_keys FROM ivr_call").get()).toMatchObject({ person_keys: expect.stringContaining(" ") });
    for (const id of ["p-old-1", "p-old-2", "mod-old"]) expect(scan(id, ["issues", "survey"]), id).toEqual([]);
    // the way back exists in identity only
    expect(new Set(myIssueIds("p-old-1"))).toEqual(new Set(["i-old-1"]));
    expect(pseudonymsOf("p-old-1")).toContain(reporterPseudonym("i-old-1", "p-old-1"));
    // audit: chain copied verbatim, still verifies, plus the import entry
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE seq <= 2 AND redacted=0").get()).toMatchObject({ c: 2 });
    expect(verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
    // recorded, read-only, byte-identical
    const rec = JSON.parse((getDb().prepare("SELECT value FROM store_meta WHERE key='legacy_import'").get() as { value: string }).value);
    expect(rec).toMatchObject({ file: path.resolve(legacy), tables: expect.objectContaining({ persons: 3, issue: 2 }) });
    expect(fileHash(legacy)).toBe(before);
    expect(() => fs.accessSync(legacy, fs.constants.W_OK)).toThrow();
    // idempotent: a restart changes nothing, and the old file is never read again
    const counts = () => JSON.stringify(STORE_NAMES.map((s) => tablesOf(getStore(s)).map((t) => (getStore(s).prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c)));
    const snap = counts();
    resetDbForTests(); migrate(); migrate();
    expect(counts()).toBe(snap);
    // the imported data works: the reporter can still be erased through the pseudonym
    deleteAccount("p-old-1");
    expect(getStore("issues").prepare("SELECT reporter_id FROM issue WHERE id='i-old-1'").get()).toEqual({ reporter_id: "erased" });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM ivr_call").get()).toMatchObject({ c: 0 });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue_media").get()).toMatchObject({ c: 0 });
  });

  it("@E2E-89 refuses a legacy file that predates the split release's schema", () => {
    const legacy = path.join(dir, "civic.db");
    const d = new DatabaseSync(legacy);
    d.exec("CREATE TABLE persons (id TEXT PRIMARY KEY, created_at TEXT, eligible_from TEXT); CREATE TABLE otps (phone_hash TEXT PRIMARY KEY, code_hash TEXT, expires_at TEXT, attempts INTEGER)");
    d.close();
    process.env.CIVIC_DB = legacy;
    expect(() => migrate()).toThrow(/older than the store split/);
  });

  it("@E2E-89 a CIVIC_DB that is not a civic database is left alone", () => {
    const other = path.join(dir, "civic.db");
    const d = new DatabaseSync(other);
    d.exec("CREATE TABLE unrelated (x INTEGER)");
    d.close();
    process.env.CIVIC_DB = other;
    expect(() => migrate()).not.toThrow();
    expect(getDb().prepare("SELECT COUNT(*) c FROM store_meta WHERE key='legacy_import'").get()).toMatchObject({ c: 0 });
  });
});
