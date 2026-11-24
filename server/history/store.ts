/**
 * History store: a local SQLite projection (node:sqlite, no extra dependency) of the election, people and geo JSON that is
 * authoritative in git. It adds what flat JSON cannot: per-election results joined to the boundary version in force, office-holder
 * validity intervals that survive rebuilds, and an append-only dataset_revisions log (checksum, row counts, source, licence,
 * asOf, previous revision, diff summary) written whenever an ingest or refresh changes a dataset. Public data only: no civic
 * (citizen) data ever enters this file. See docs/HISTORY_STORE.md.
 *
 * Rebuilding drops and recreates the PROJECTION tables from JSON; dataset_revisions, office_holders (validity intervals) and
 * manual_corrections are never wiped except by --reset (which deletes the file).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const HISTORY_SCHEMA_VERSION = 1;
export const defaultHistoryDb = (root = process.cwd()): string => path.resolve(root, process.env.HISTORY_DB || path.join("data", "history.db"));

const DDL = `
CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dataset_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  row_count INTEGER,
  source TEXT,
  licence TEXT,
  provenance TEXT,
  as_of TEXT,
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL,
  previous_revision_id INTEGER REFERENCES dataset_revisions(id),
  diff_summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_dataset ON dataset_revisions(dataset, id);
CREATE TRIGGER IF NOT EXISTS dataset_revisions_no_update BEFORE UPDATE ON dataset_revisions BEGIN SELECT RAISE(ABORT, 'dataset_revisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dataset_revisions_no_delete BEFORE DELETE ON dataset_revisions BEGIN SELECT RAISE(ABORT, 'dataset_revisions is append-only'); END;
CREATE TABLE IF NOT EXISTS manual_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  source_url TEXT
);
CREATE TRIGGER IF NOT EXISTS manual_corrections_no_update BEFORE UPDATE ON manual_corrections BEGIN SELECT RAISE(ABORT, 'manual_corrections is append-only'); END;
CREATE TRIGGER IF NOT EXISTS manual_corrections_no_delete BEFORE DELETE ON manual_corrections BEGIN SELECT RAISE(ABORT, 'manual_corrections is append-only'); END;
CREATE TABLE IF NOT EXISTS office_holders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id TEXT NOT NULL,
  state TEXT NOT NULL,
  role TEXT NOT NULL,
  person TEXT NOT NULL,
  party TEXT,
  constituency TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  current INTEGER NOT NULL DEFAULT 1,
  confidence TEXT,
  wikidata TEXT,
  sources TEXT NOT NULL,
  first_revision_id INTEGER,
  last_revision_id INTEGER,
  UNIQUE (slot_id, person, start_date)
);
CREATE INDEX IF NOT EXISTS idx_oh_dates ON office_holders(start_date, end_date);
`;

const PROJECTION_DDL = `
DROP TABLE IF EXISTS results; DROP TABLE IF EXISTS constituencies; DROP TABLE IF EXISTS elections; DROP TABLE IF EXISTS parties;
DROP TABLE IF EXISTS party_alliances; DROP TABLE IF EXISTS by_elections; DROP TABLE IF EXISTS party_switches;
CREATE TABLE elections (id TEXT PRIMARY KEY, state TEXT NOT NULL, year INTEGER NOT NULL, type TEXT NOT NULL, boundary_version TEXT,
  comparability TEXT, provenance TEXT, seats INTEGER NOT NULL, rows INTEGER NOT NULL);
CREATE TABLE constituencies (state TEXT NOT NULL, type TEXT NOT NULL, ac_no INTEGER NOT NULL, boundary_version TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY (state, type, ac_no, boundary_version));
CREATE TABLE results (election_id TEXT NOT NULL REFERENCES elections(id), ac_no INTEGER NOT NULL, ac_name TEXT, candidate TEXT NOT NULL,
  party TEXT, party_code TEXT, votes INTEGER NOT NULL, position INTEGER, share_pct REAL, is_nota INTEGER NOT NULL DEFAULT 0, margin INTEGER,
  valid_votes INTEGER, electors INTEGER);
CREATE INDEX idx_results_seat ON results(election_id, ac_no);
CREATE INDEX idx_results_party ON results(party_code, election_id);
CREATE TABLE parties (code TEXT PRIMARY KEY, name_en TEXT, name_te TEXT, color TEXT, founded_year INTEGER, wikidata TEXT);
CREATE TABLE party_alliances (election_id TEXT NOT NULL, alliance TEXT NOT NULL, party_code TEXT NOT NULL, kind TEXT, confidence TEXT, sources TEXT);
CREATE INDEX idx_alliance_party ON party_alliances(party_code, election_id);
CREATE TABLE by_elections (id TEXT PRIMARY KEY, state TEXT, type TEXT, ac_no INTEGER, seat TEXT, date TEXT, kind TEXT, cause TEXT, winner TEXT,
  party TEXT, margin INTEGER, margin_pct REAL, valid_votes INTEGER, electors INTEGER, turnout_pct REAL, verified INTEGER, sources TEXT);
CREATE TABLE party_switches (id TEXT PRIMARY KEY, person TEXT NOT NULL, state TEXT, type TEXT, ac_no INTEGER, constituency TEXT,
  from_party TEXT, to_party TEXT, date TEXT, status TEXT, verified INTEGER, sources TEXT);
`;

export function openHistoryDb(file: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
  if (!opts.readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, opts.readOnly ? { readOnly: true } : {});
  if (!opts.readOnly) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec(DDL);
    db.prepare("INSERT OR IGNORE INTO history_meta(key, value) VALUES ('schema_version', ?)").run(String(HISTORY_SCHEMA_VERSION));
  }
  return db;
}

/* ---------------- source datasets ---------------- */

interface Spec { dataset: string; rel: string; licence: string; source: string; provenance: string; count: (j: unknown) => number | null }
const arr = (v: unknown, ...keys: string[]): number | null => {
  if (Array.isArray(v)) return v.length;
  const o = v as Record<string, unknown> | null;
  for (const k of keys) if (o && Array.isArray(o[k])) return (o[k] as unknown[]).length;
  return null;
};
/** Reference datasets that are not in data/generated/manifest.json. Manifest datasets supply their own metadata. */
const EXTRA: Spec[] = [
  { dataset: "people-office-holders", rel: "data/reference/people/office-holders.json", licence: "wikipedia-cc-by-sa", source: "English Wikipedia, Wikidata, news reports (cited per record)", provenance: "hand-curated", count: (v) => arr(v, "records") },
  { dataset: "history-byelections", rel: "data/reference/history/byelections.json", licence: "project-derived", source: "TCPD / ECI results (see file)", provenance: "TCPD", count: (v) => arr(v, "records") },
  { dataset: "history-party-switches", rel: "data/reference/history/party-switches.json", licence: "project-derived", source: "Cited news and Wikipedia pages (per record)", provenance: "hand-curated", count: (v) => arr(v, "records") },
];

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const readJson = <T>(root: string, rel: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")) as T; } catch { return fallback; }
};
const js = (v: unknown) => JSON.stringify(v ?? []);

interface ManifestEntry { id: string; path: string; rows?: number; asOf?: string; provenance?: string; sources?: string[]; licences?: string[] }

function specs(root: string): Spec[] {
  const man = readJson<{ datasets?: ManifestEntry[] }>(root, "data/generated/manifest.json", {});
  const out: Spec[] = (man.datasets ?? []).map((d) => ({
    dataset: d.id, rel: d.path, licence: (d.licences ?? []).join(", "), source: (d.sources ?? []).join(" "), provenance: d.provenance ?? "",
    count: () => (typeof d.rows === "number" ? d.rows : null),
  }));
  const have = new Set(out.map((s) => s.dataset));
  return [...out, ...EXTRA.filter((e) => !have.has(e.dataset))];
}

export interface RecordedRevision { dataset: string; revisionId: number; previousRevisionId: number | null; sha256: string }
export interface BuildReport {
  dbPath: string; trigger: string; revisions: RecordedRevision[]; unchanged: number; missing: string[];
  counts: Record<string, number>; reset: boolean;
}

/** Record one revision per dataset whose file checksum differs from its latest revision (append-only). */
export function recordRevisions(db: DatabaseSync, root: string, trigger: string, now: Date): { revisions: RecordedRevision[]; unchanged: number; missing: string[] } {
  const revisions: RecordedRevision[] = [];
  const missing: string[] = [];
  let unchanged = 0;
  const latest = db.prepare("SELECT id, sha256, row_count FROM dataset_revisions WHERE dataset = ? ORDER BY id DESC LIMIT 1");
  const ins = db.prepare(`INSERT INTO dataset_revisions (dataset, path, sha256, bytes, row_count, source, licence, provenance, as_of, trigger, created_at, previous_revision_id, diff_summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const man = readJson<{ datasets?: ManifestEntry[] }>(root, "data/generated/manifest.json", {});
  const asOfOf = new Map((man.datasets ?? []).map((d) => [d.id, d.asOf]));
  for (const s of specs(root)) {
    const file = path.join(root, s.rel);
    if (!fs.existsSync(file)) { missing.push(s.dataset); continue; }
    const buf = fs.readFileSync(file);
    const sum = sha256(buf);
    const prev = latest.get(s.dataset) as { id: number; sha256: string; row_count: number | null } | undefined;
    if (prev && prev.sha256 === sum) { unchanged++; continue; }
    let parsed: unknown = null;
    try { parsed = JSON.parse(buf.toString("utf8")); } catch { /* not JSON: row count unknown */ }
    const rows = parsed ? s.count(parsed) : null;
    const fileAsOf = (parsed as { asOf?: string } | null)?.asOf;
    const asOf = asOfOf.get(s.dataset) ?? (typeof fileAsOf === "string" ? fileAsOf : null);
    const diff = { first: !prev, rowsBefore: prev?.row_count ?? null, rowsAfter: rows, rowDelta: prev?.row_count != null && rows != null ? rows - prev.row_count : null, sha256Before: prev?.sha256 ?? null };
    const r = ins.run(s.dataset, s.rel, sum, buf.length, rows, s.source, s.licence, s.provenance, asOf, trigger, now.toISOString(), prev?.id ?? null, JSON.stringify(diff));
    revisions.push({ dataset: s.dataset, revisionId: Number(r.lastInsertRowid), previousRevisionId: prev?.id ?? null, sha256: sum });
  }
  return { revisions, unchanged, missing };
}

/* ---------------- projections ---------------- */

interface Row { state: string; year: number; type: string; acNo: number; acName?: string; candidate: string; party: string; votes: number; position?: number; validVotes?: number; electors?: number; provenance?: string; comparability?: string }
interface BoundarySet { id: string; valid_from: string; valid_to: string | null }

/** Boundary set whose [valid_from, valid_to] years contain the election year (elections here carry a year, not a date). */
export function boundaryVersionForYear(sets: BoundarySet[], year: number): string | null {
  const hit = sets.filter((s) => Number(s.valid_from.slice(0, 4)) <= year && (!s.valid_to || year <= Number(s.valid_to.slice(0, 4))))
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  return hit?.id ?? null;
}

function projectElections(db: DatabaseSync, root: string): number {
  const main = readJson<{ results?: Row[] }>(root, "data/generated/elections.json", {}).results ?? [];
  const pre = readJson<{ results?: Row[] }>(root, "data/generated/history/prebifurcation.json", {}).results ?? [];
  const sets = readJson<{ sets?: BoundarySet[] }>(root, "data/generated/geo/versions.json", {}).sets ?? [];
  const parties = readJson<{ parties?: { code: string; aliases?: string[] }[] }>(root, "data/reference/parties.json", {}).parties ?? [];
  const alias = new Map<string, string>();
  for (const p of parties) { alias.set(p.code.toUpperCase(), p.code); for (const a of p.aliases ?? []) alias.set(a.toUpperCase(), p.code); }
  const eid = (r: Row) => `${r.state}-${r.year}-${r.type}`;
  const mainIds = new Set(main.map(eid));
  const rows = [...main, ...pre.filter((r) => !mainIds.has(eid(r)))];

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${eid(r)}#${r.acNo}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const insEl = db.prepare("INSERT OR IGNORE INTO elections (id,state,year,type,boundary_version,comparability,provenance,seats,rows) VALUES (?,?,?,?,?,?,?,?,?)");
  const insCons = db.prepare("INSERT OR IGNORE INTO constituencies (state,type,ac_no,boundary_version,name) VALUES (?,?,?,?,?)");
  const insRes = db.prepare(`INSERT INTO results (election_id,ac_no,ac_name,candidate,party,party_code,votes,position,share_pct,is_nota,margin,valid_votes,electors)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const seen = new Map<string, { seats: Set<number>; rows: number; r: Row }>();
  // The election row must exist before its results (foreign key), so create elections first.
  for (const [k, list] of groups) {
    const id = k.slice(0, k.indexOf("#"));
    const e = seen.get(id) ?? { seats: new Set<number>(), rows: 0, r: list[0] };
    e.seats.add(list[0].acNo); e.rows += list.length; seen.set(id, e);
  }
  for (const [id, e] of seen) {
    insEl.run(id, e.r.state, e.r.year, e.r.type, boundaryVersionForYear(sets, e.r.year), e.r.comparability ?? null, e.r.provenance ?? null, e.seats.size, e.rows);
  }
  for (const [k, list] of groups) {
    const id = k.slice(0, k.indexOf("#"));
    const first = list[0];
    const bv = boundaryVersionForYear(sets, first.year);
    insCons.run(first.state, first.type, first.acNo, bv ?? "unknown", first.acName ?? `#${first.acNo}`);
    const valid = list.find((x) => x.validVotes)?.validVotes ?? list.reduce((s, x) => s + x.votes, 0);
    const ranked = list.filter((x) => x.party !== "NOTA").sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || b.votes - a.votes);
    const margin = ranked.length > 1 ? ranked[0].votes - ranked[1].votes : null;
    for (const x of list) {
      const nota = x.party === "NOTA" ? 1 : 0;
      insRes.run(id, x.acNo, x.acName ?? null, x.candidate, x.party, nota ? "NOTA" : (alias.get(x.party.toUpperCase()) ?? x.party), x.votes, x.position ?? null,
        valid ? Math.round((x.votes / valid) * 10000) / 100 : null, nota, !nota && ranked[0] === x ? margin : null, valid || null, x.electors ?? null);
    }
  }
  return rows.length;
}

function projectParties(db: DatabaseSync, root: string): void {
  const p = readJson<{ parties?: { code: string; name?: { en?: string; te?: string | null }; color?: string; foundedYear?: number; wikidata?: string }[] }>(root, "data/reference/parties.json", {});
  const ins = db.prepare("INSERT OR REPLACE INTO parties (code,name_en,name_te,color,founded_year,wikidata) VALUES (?,?,?,?,?,?)");
  for (const x of p.parties ?? []) ins.run(x.code, x.name?.en ?? null, x.name?.te ?? null, x.color ?? null, x.foundedYear ?? null, x.wikidata ?? null);
  const a = readJson<{ records?: { key: string; groups?: { name: string; parties: string[]; kind?: string; confidence?: string; sources?: string[] }[] }[] }>(root, "data/reference/alliances.json", {});
  const insA = db.prepare("INSERT INTO party_alliances (election_id,alliance,party_code,kind,confidence,sources) VALUES (?,?,?,?,?,?)");
  for (const r of a.records ?? []) for (const g of r.groups ?? []) for (const code of g.parties) insA.run(r.key, g.name, code, g.kind ?? null, g.confidence ?? null, js(g.sources));
}

function projectEvents(db: DatabaseSync, root: string): void {
  const b = readJson<{ records?: Record<string, unknown>[] }>(root, "data/reference/history/byelections.json", {});
  const ins = db.prepare("INSERT OR REPLACE INTO by_elections (id,state,type,ac_no,seat,date,kind,cause,winner,party,margin,margin_pct,valid_votes,electors,turnout_pct,verified,sources) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const n = (v: unknown) => (v == null ? null : (v as number));
  const s = (v: unknown) => (v == null ? null : String(v));
  for (const r of b.records ?? []) ins.run(String(r.id), s(r.state), s(r.type), n(r.acNo), s(r.seat), s(r.date), s(r.kind), s(r.cause), s(r.winner), s(r.party), n(r.margin), n(r.marginPct), n(r.validVotes), n(r.electors), n(r.turnoutPct), r.verified ? 1 : 0, js(r.sources));
  const sw = readJson<{ records?: { id: string; person: string; state: string; constituency?: { type?: string; acNo?: number; name?: string }; from: string; to: string; date: string; status: string; verified: boolean; sources: unknown[] }[] }>(root, "data/reference/history/party-switches.json", {});
  const insS = db.prepare("INSERT OR REPLACE INTO party_switches (id,person,state,type,ac_no,constituency,from_party,to_party,date,status,verified,sources) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const r of sw.records ?? []) insS.run(r.id, r.person, r.state, r.constituency?.type ?? null, r.constituency?.acNo ?? null, r.constituency?.name ?? null, r.from, r.to, r.date, r.status, r.verified ? 1 : 0, js(r.sources));
}

interface Holder { id: string; state: string; role: string; person: string; party?: string; start: string; constituency?: string; confidence?: string; wikidata?: string | null; sources?: string[] }

/** Upserts office holders by slot. A slot whose person/start changed closes the old row at the new start date; a slot that disappeared is
 *  marked not current (end date unknown). Nothing is deleted, so validity intervals accumulate across rebuilds. */
function projectOfficeHolders(db: DatabaseSync, root: string, revId: number | null): { added: number; closed: number; retired: number } {
  const recs = readJson<{ records?: Holder[] }>(root, "data/reference/people/office-holders.json", {}).records ?? [];
  let added = 0, closed = 0, retired = 0;
  const cur = db.prepare("SELECT id, person, start_date FROM office_holders WHERE slot_id = ? AND current = 1");
  const exists = db.prepare("SELECT id, current FROM office_holders WHERE slot_id = ? AND person = ? AND start_date = ?");
  const close = db.prepare("UPDATE office_holders SET end_date = ?, current = 0, last_revision_id = COALESCE(?, last_revision_id) WHERE id = ?");
  const ins = db.prepare(`INSERT INTO office_holders (slot_id,state,role,person,party,constituency,start_date,confidence,wikidata,sources,first_revision_id,last_revision_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const refresh = db.prepare("UPDATE office_holders SET party=?, constituency=?, confidence=?, wikidata=?, sources=?, last_revision_id = COALESCE(?, last_revision_id) WHERE id = ?");
  const slots = new Set<string>();
  for (const r of recs) {
    slots.add(r.id);
    const same = exists.get(r.id, r.person, r.start) as { id: number; current: number } | undefined;
    for (const c of cur.all(r.id) as { id: number; person: string; start_date: string }[]) {
      if (c.person === r.person && c.start_date === r.start) continue;
      close.run(r.start, revId, c.id); closed++;
    }
    if (same) { refresh.run(r.party ?? null, r.constituency ?? null, r.confidence ?? null, r.wikidata ?? null, js(r.sources), revId, same.id); continue; }
    ins.run(r.id, r.state, r.role, r.person, r.party ?? null, r.constituency ?? null, r.start, r.confidence ?? null, r.wikidata ?? null, js(r.sources), revId, revId);
    added++;
  }
  for (const c of db.prepare("SELECT id, slot_id FROM office_holders WHERE current = 1").all() as { id: number; slot_id: string }[]) {
    if (!slots.has(c.slot_id)) { db.prepare("UPDATE office_holders SET current = 0 WHERE id = ?").run(c.id); retired++; }
  }
  return { added, closed, retired };
}

/** Idempotent importer: records revisions for changed datasets, then rebuilds the projections from the JSON in git. */
export function buildHistory(opts: { root?: string; dbPath?: string; reset?: boolean; trigger?: string; now?: Date } = {}): BuildReport {
  const root = opts.root ?? process.cwd();
  const dbPath = opts.dbPath ?? defaultHistoryDb(root);
  const reset = !!opts.reset;
  if (reset) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  const db = openHistoryDb(dbPath);
  const now = opts.now ?? new Date();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const rec = recordRevisions(db, root, opts.trigger ?? "build", now);
      db.exec(PROJECTION_DDL);
      const nRows = projectElections(db, root);
      projectParties(db, root);
      projectEvents(db, root);
      const ohRev = rec.revisions.find((r) => r.dataset === "people-office-holders")?.revisionId
        ?? (db.prepare("SELECT id FROM dataset_revisions WHERE dataset = 'people-office-holders' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
      projectOfficeHolders(db, root, ohRev);
      db.prepare("INSERT OR REPLACE INTO history_meta(key,value) VALUES ('projected_at', ?)").run(now.toISOString());
      const count = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      const counts: Record<string, number> = { result_rows: nRows };
      for (const t of ["elections", "constituencies", "results", "parties", "party_alliances", "by_elections", "party_switches", "office_holders", "dataset_revisions"]) counts[t] = count(t);
      db.exec("COMMIT");
      return { dbPath, trigger: opts.trigger ?? "build", revisions: rec.revisions, unchanged: rec.unchanged, missing: rec.missing, counts, reset };
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  } finally { db.close(); }
}

/** Refresh hook: guarded and never throws. Only records when a history DB already exists (or HISTORY_AUTO_RECORD=1), so a fresh
 *  checkout that never ran `npm run history:build` is not given a database as a side effect of refreshing data. */
export function recordRefreshRevision(root: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): { ok: boolean; recorded?: number; skipped?: string; error?: string } {
  try {
    const dbPath = defaultHistoryDb(root);
    if (env.HISTORY_AUTO_RECORD === "0") return { ok: true, skipped: "disabled" };
    if (env.HISTORY_AUTO_RECORD !== "1" && !fs.existsSync(dbPath)) return { ok: true, skipped: "no history database" };
    const r = buildHistory({ root, dbPath, trigger: "refresh" });
    return { ok: true, recorded: r.revisions.length };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Audit trail for a manual correction applied to the JSON sources (the JSON stays authoritative; this records who/why). */
export function recordCorrection(db: DatabaseSync, c: { actor: string; table: string; key: string; field: string; oldValue?: string | null; newValue?: string | null; reason: string; sourceUrl?: string }, now: Date = new Date()): number {
  if (!c.reason.trim() || !c.actor.trim()) throw new Error("a correction needs an actor and a reason");
  const r = db.prepare("INSERT INTO manual_corrections (at,actor,table_name,record_key,field,old_value,new_value,reason,source_url) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(now.toISOString(), c.actor, c.table, c.key, c.field, c.oldValue ?? null, c.newValue ?? null, c.reason, c.sourceUrl ?? null);
  return Number(r.lastInsertRowid);
}
