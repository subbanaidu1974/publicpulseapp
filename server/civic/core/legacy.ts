/**
 * One-time import of the pre-split single database (S-74). When CIVIC_DB names an existing regular file that is not itself one of the
 * four store files, and the identity store has no `legacy_import` record, every table is copied into its store:
 *
 *   audit    <- audit_log, audit_anchors (rows verbatim, so the hash chain keeps verifying)
 *   issues   <- issue*, officer_rebuttal, moderation_action, lexicon_change, issue_media, geography, ivr_call. Every person id in those
 *               tables is replaced by its keyed pseudonym (server/civic/core/pseudonyms.ts); the way back goes to identity.issue_links
 *   identity <- everything else (persons, sessions, roles, households, enrolments, officer_role ...). rate_events are transient and not copied.
 *
 * Each store is written in ONE transaction of that store. The record in identity.store_meta is written last, so a crash before it just
 * repeats the import (every insert is INSERT OR IGNORE and pseudonyms are deterministic). The legacy file is then made read-only and kept as
 * a backup; it is never opened for writing again and never read again once recorded. The source must be at the schema of the release
 * before the split (otps.purpose, roles.department, sessions.id); an older file must be migrated by that release first.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { audit, getKeys } from "./index";
import { actorPseudonym, isErasedMarker, ivrPseudonym, mediaOwnerPseudonym, reporterPseudonym, type LinkKind } from "./pseudonyms";
import { getStore, legacyDbFile, runInStore, type StoreName } from "./stores";

type Row = Record<string, unknown>;
export interface LegacyImportReport { file: string; imported_at: string; tables: Record<string, number>; links: number }

const AUDIT_TABLES = ["audit_log", "audit_anchors"];
const IDENTITY_TABLES = [
  "persons", "sessions", "consents", "roles", "otps", "attestations", "has_responded", "pin_failures", "survey_closures", "enrolments",
  "hh_household", "hh_member", "hh_invite", "hh_pin", "hh_invite_cooldown", "hh_transfer", "admin_mfa", "admin_mfa_recovery", "role_requests",
  "officer_role", "people_requests", "people_takedowns",
];

const hasTable = (d: DatabaseSync, t: string): boolean => !!d.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(t);
const columnsOf = (d: DatabaseSync, t: string): string[] => (d.prepare(`PRAGMA table_info("${t}")`).all() as unknown as { name: string }[]).map((c) => c.name);

function openLegacy(file: string): DatabaseSync {
  try {
    const d = new DatabaseSync(file, { readOnly: true });
    d.prepare("SELECT COUNT(*) FROM sqlite_master").get(); // forces the open (a WAL file needing recovery fails here)
    return d;
  } catch {
    const d = new DatabaseSync(file); // a clean shutdown leaves no WAL; if one is left, SQLite must recover it, which needs a normal open
    try { d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
    return d;
  }
}

function copyTable(src: DatabaseSync, store: StoreName, table: string, transform?: (r: Row) => Row | null): number {
  if (!hasTable(src, table)) return 0;
  const dst = getStore(store);
  const dcols = columnsOf(dst, table);
  if (!dcols.length) return 0; // table of a module that is not loaded in this process
  const rows = src.prepare(`SELECT * FROM "${table}"`).all() as unknown as Row[];
  let n = 0;
  let stmt: ReturnType<DatabaseSync["prepare"]> | null = null;
  let cols: string[] = [];
  for (const raw of rows) {
    const r = transform ? transform(raw) : raw;
    if (!r) continue;
    if (!stmt) {
      cols = dcols.filter((c) => c in r);
      stmt = dst.prepare(`INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    }
    stmt.run(...cols.map((c) => (r[c] ?? null) as never));
    n++;
  }
  return n;
}

/** Import the pre-split database if there is one and it has not been imported yet. Returns the report, or null when nothing was done. */
export function importLegacyDatabase(): LegacyImportReport | null {
  const file = legacyDbFile();
  if (!file) return null;
  const identity = getStore("identity");
  if (identity.prepare("SELECT 1 AS x FROM store_meta WHERE key = 'legacy_import'").get()) return null;

  const src = openLegacy(file);
  try {
    if (!hasTable(src, "persons")) return null; // not a civic database: leave it alone
    const need: [string, string][] = [["otps", "purpose"], ["roles", "department"], ["sessions", "id"]];
    for (const [t, c] of need) {
      if (hasTable(src, t) && !columnsOf(src, t).includes(c)) {
        throw new Error(`legacy civic database ${file} is older than the store split (${t}.${c} missing): run the previous release once so it migrates the file, then start this one`);
      }
    }
    const k = getKeys();
    const links: { person: string; kind: LinkKind; ref: string; village: string | null; ts: string }[] = [];
    const link = (person: unknown, kind: LinkKind, ref: string, village: string | null = null, ts = new Date().toISOString()): string | null => {
      if (typeof person !== "string" || isErasedMarker(person)) return null;
      links.push({ person, kind, ref, village, ts });
      return person;
    };
    const tables: Record<string, number> = {};
    const pseudo = (person: unknown, issueId: string, ts?: string): unknown => {
      const p = link(person, "issue", issueId, null, ts);
      return p ? reporterPseudonym(issueId, p) : person;
    };
    const actor = (v: unknown): unknown => (typeof v === "string" && !isErasedMarker(v) ? actorPseudonym(v) : v);

    runInStore("audit", () => { for (const t of AUDIT_TABLES) tables[t] = copyTable(src, "audit", t); });

    runInStore("issues", () => {
      for (const t of ["admin_unit", "hamlet", "village_constituency", "issue_event"]) tables[t] = copyTable(src, "issues", t);
      tables.issue = copyTable(src, "issues", "issue", (r) => {
        const id = String(r.id);
        const p = typeof r.reporter_id === "string" && !isErasedMarker(r.reporter_id) ? r.reporter_id : null;
        if (p) links.push({ person: p, kind: "issue", ref: id, village: String(r.village_lgd), ts: String(r.created_at ?? new Date().toISOString()) });
        return { ...r, reporter_id: p ? reporterPseudonym(id, p) : r.reporter_id };
      });
      tables.issue_me_too = copyTable(src, "issues", "issue_me_too", (r) => ({ ...r, person_id: pseudo(r.person_id, String(r.issue_id), String(r.at)) }));
      tables.issue_sample = copyTable(src, "issues", "issue_sample", (r) => ({ ...r, person_id: pseudo(r.person_id, String(r.issue_id)) }));
      tables.issue_appeal = copyTable(src, "issues", "issue_appeal", (r) => ({ ...r, person_id: pseudo(r.person_id, String(r.issue_id), String(r.at)) }));
      tables.officer_rebuttal = copyTable(src, "issues", "officer_rebuttal", (r) => ({ ...r, author_id: actor(r.author_id) }));
      tables.moderation_action = copyTable(src, "issues", "moderation_action", (r) => ({ ...r, actor_id: actor(r.actor_id) }));
      tables.lexicon_change = copyTable(src, "issues", "lexicon_change", (r) => {
        let approvals = r.approvals;
        try { approvals = JSON.stringify((JSON.parse(String(r.approvals ?? "[]")) as string[]).map((x) => actor(x))); } catch { /* keep as is */ }
        return { ...r, proposer_id: actor(r.proposer_id), rejected_by: actor(r.rejected_by), approvals };
      });
      tables.issue_media = copyTable(src, "issues", "issue_media", (r) => {
        const id = String(r.id);
        const p = link(r.owner_id, "media", id, null, String(r.created_at ?? new Date().toISOString()));
        return { ...r, owner_id: p ? mediaOwnerPseudonym(id, p) : r.owner_id };
      });
      tables.ivr_call = copyTable(src, "issues", "ivr_call", (r) => {
        const ids: string[] = [];
        if (typeof r.person_id === "string" && r.person_id) ids.push(r.person_id);
        let adults: string[] = [];
        try { adults = r.adults ? (JSON.parse(String(r.adults)) as string[]) : []; } catch { /* ignore */ }
        ids.push(...adults);
        return {
          ...r,
          person_enc: typeof r.person_id === "string" && r.person_id ? k.encrypt("ivr-call-person", r.person_id) : null,
          adults_enc: adults.length ? k.encrypt("ivr-call-person", JSON.stringify(adults)) : null,
          person_keys: ids.length ? " " + [...new Set(ids)].map(ivrPseudonym).join(" ") + " " : null,
        };
      });
    });

    runInStore("identity", () => {
      for (const t of IDENTITY_TABLES) tables[t] = copyTable(src, "identity", t);
      const ins = identity.prepare("INSERT OR IGNORE INTO issue_links (person_id, link_key, kind, ref_enc, village_lgd, ts) VALUES (?,?,?,?,?,?)");
      for (const l of links) ins.run(l.person, k.hmac("issue-link", `${l.person}|${l.kind}|${l.ref}`), l.kind, k.encrypt("issue-link", JSON.stringify({ kind: l.kind, ref: l.ref })), l.village, l.ts);
      const st = fs.statSync(file);
      const report: LegacyImportReport = { file, imported_at: new Date().toISOString(), tables, links: links.length };
      identity.prepare("INSERT OR REPLACE INTO store_meta (key, value, updated_at) VALUES ('legacy_import', ?, ?)")
        .run(JSON.stringify({ ...report, bytes: st.size, mtime: st.mtime.toISOString() }), report.imported_at);
    });
    try { fs.chmodSync(file, 0o444); } catch { /* best effort */ } // the old file stays as a read-only backup
    audit("system", "store.legacy_import", "identity", { rows: Object.values(tables).reduce((a, b) => a + b, 0), links: links.length });
    return { file, imported_at: new Date().toISOString(), tables, links: links.length };
  } finally {
    try { src.close(); } catch { /* ignore */ }
  }
}
