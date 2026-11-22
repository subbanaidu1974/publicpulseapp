/**
 * Key rotation helpers: DUAL-READ / SINGLE-WRITE migration for keyed hashes and pseudonyms (S-64).
 *
 * A keyed hash (persons.phone_hash = hmac("phone", e164), the reporter pseudonyms in the issues store, issue_links.link_key) changes
 * value when its key rotates, so a rotation is a data migration, not just a new key:
 *
 *   1. provider.rotate("phone")        new version is the WRITE version; the old one stays readable (hmacCandidates = [new, old]).
 *   2. dual-read                       lookups use `WHERE phone_hash IN (<candidates>)` (phoneHashCandidates below) so nobody is locked out.
 *   3. rehashTable(PHONE_REHASH, {dryRun:true})  report only, then {dryRun:false}: decrypts the stored phone, writes the NEW hash (and
 *      re-encrypts the ciphertext under the new version). Resumable and idempotent: staleness is computed from the data, not from progress state.
 *   4. rehashPseudonyms(...)           same for reporter/actor pseudonyms (issues store) and issue_links (identity store).
 *   5. a dry run reporting stale == 0  ->  provider.retire(purpose, oldVersion).
 *
 * Offline path (no code change in the identity lookups): stop writers, rotate, run step 3/4 in non-dry mode, start. Online path: adopt
 * `hashCandidates` in the identity lookups first (that wiring belongs to the identity module; see docs/PROVIDERS.md).
 * Rows whose clear source is gone (phone_purged_at: phone_enc is NULL) cannot be rehashed; they are reported as `unrecoverable` and keep
 * their old hash, so retire the old version only once that number is understood.
 * Ephemeral keyed values (OTPs, rate counters, PIN failure counters, sessions) are cleared instead of migrated: `clearEphemeral`.
 */
import { getKeys, getStore, runInStore, type StoreName } from "../core";
import { isKeyProviderV2, type KeyProviderV2 } from "./keys";

export interface RehashSpec {
  name: string; store: StoreName; table: string;
  hashCol: string; encCol: string; hashPurpose: string; encPurpose: string;
  /** Extra SQL predicate (no user input). */
  where?: string;
}
export const PHONE_REHASH: RehashSpec = { name: "persons.phone_hash", store: "identity", table: "persons", hashCol: "phone_hash", encCol: "phone_enc", hashPurpose: "phone", encPurpose: "phone" };

export interface RehashReport {
  name: string; dryRun: boolean; currentVersion: number; scanned: number; alreadyCurrent: number;
  /** Stored hash differs from the current-version hash. */
  stale: number; fromOldVersion: number; fromUnknown: number;
  /** Ciphertext not under the current key version. */
  encStale: number;
  /** No clear source (purged / undecryptable): cannot be recomputed. */
  unrecoverable: number; skippedNull: number; updated: number;
}

const ctVersion = (ct: string): number => { const m = /^v2\.(\d+)\./.exec(ct); return m ? Number(m[1]) : 0; };

function v2(): KeyProviderV2 {
  const k = getKeys();
  if (!isKeyProviderV2(k)) throw new Error("rehash needs a KeyProvider v2 (rotation is not available with the dev provider)");
  return k;
}

/** Hashes of `value` to match while a rehash is in flight: current first. Works with any provider (a v1 provider yields one candidate). */
export function hashCandidates(purpose: string, value: string): string[] {
  const k = getKeys();
  return isKeyProviderV2(k) ? k.hmacCandidates(purpose, value) : [k.hmac(purpose, value)];
}
export const phoneHashCandidates = (e164: string): string[] => hashCandidates("phone", e164);

/** Recompute one keyed-hash column from its encrypted source. dryRun (default) changes nothing. */
export function rehashTable(spec: RehashSpec, o: { dryRun?: boolean; batch?: number; reencrypt?: boolean } = {}): RehashReport {
  const p = v2(), dryRun = o.dryRun !== false, batch = Math.max(1, o.batch ?? 500), reenc = o.reencrypt !== false;
  const cur = p.keyInfo(spec.hashPurpose).version, encCur = p.keyInfo(spec.encPurpose).version;
  const rep: RehashReport = { name: spec.name, dryRun, currentVersion: cur, scanned: 0, alreadyCurrent: 0, stale: 0, fromOldVersion: 0, fromUnknown: 0, encStale: 0, unrecoverable: 0, skippedNull: 0, updated: 0 };
  const db = getStore(spec.store);
  const sel = db.prepare(`SELECT rowid AS rid, ${spec.hashCol} AS h, ${spec.encCol} AS e FROM ${spec.table} WHERE rowid > ? ${spec.where ? "AND (" + spec.where + ")" : ""} ORDER BY rowid LIMIT ?`);
  const upd = db.prepare(`UPDATE ${spec.table} SET ${spec.hashCol} = ?, ${spec.encCol} = ? WHERE rowid = ?`);
  let after = 0;
  for (;;) {
    const rows = sel.all(after, batch) as { rid: number; h: string | null; e: string | null }[];
    if (!rows.length) break;
    const writes: [string, string, number][] = [];
    for (const r of rows) {
      after = r.rid; rep.scanned++;
      if (r.h == null) { rep.skippedNull++; continue; }
      if (r.e == null) { rep.unrecoverable++; continue; }
      let clear: string;
      try { clear = p.decrypt(spec.encPurpose, r.e); } catch { rep.unrecoverable++; continue; }
      const cands = p.hmacCandidates(spec.hashPurpose, clear);
      const encOld = ctVersion(r.e) !== encCur;
      if (encOld) rep.encStale++;
      if (r.h === cands[0]) { rep.alreadyCurrent++; if (!(encOld && reenc)) continue; }
      else { rep.stale++; if (cands.includes(r.h)) rep.fromOldVersion++; else rep.fromUnknown++; }
      writes.push([cands[0], reenc && encOld ? p.encrypt(spec.encPurpose, clear) : r.e, r.rid]);
    }
    if (!dryRun && writes.length) {
      runInStore(spec.store, () => { for (const w of writes) { upd.run(w[0], w[1], w[2]); rep.updated++; } });
    }
  }
  return rep;
}

// --- pseudonyms ------------------------------------------------------------------------------------------------------------------

export interface PseudonymRehashReport { dryRun: boolean; linksScanned: number; staleLinkKeys: number; stalePseudonymRows: number; actorsScanned: number; updatedRows: number; unreadableLinks: number }

/** Issues-store columns holding a per-issue reporter pseudonym, keyed by the issue id column. */
const REPORTER_COLS: { table: string; col: string; issueCol: string }[] = [
  { table: "issue", col: "reporter_id", issueCol: "id" }, { table: "issue_me_too", col: "person_id", issueCol: "issue_id" },
  { table: "issue_sample", col: "person_id", issueCol: "issue_id" }, { table: "issue_appeal", col: "person_id", issueCol: "issue_id" },
];

/**
 * Re-key the reporter / media / actor pseudonyms in the ISSUES store and the issue_links ledger in the IDENTITY store after rotating
 * "reporter-pseudonym", "actor-pseudonym" and/or "issue-link". Issues store first, then the link row, so a crash in between is repaired by a re-run.
 */
export function rehashPseudonyms(o: { dryRun?: boolean } = {}): PseudonymRehashReport {
  const p = v2(), dryRun = o.dryRun !== false;
  const rep: PseudonymRehashReport = { dryRun, linksScanned: 0, staleLinkKeys: 0, stalePseudonymRows: 0, actorsScanned: 0, updatedRows: 0, unreadableLinks: 0 };
  const idb = getStore("identity"), sdb = getStore("issues");
  const olderOf = (purpose: string) => p.activeVersions(purpose).slice(1);
  const rp = olderOf("reporter-pseudonym"), ap = olderOf("actor-pseudonym");
  const exec = (store: StoreName, fn: () => number): number => (dryRun ? 0 : runInStore(store, fn));
  const count = (sql: string, ...args: string[]): number => (sdb.prepare(sql).get(...args) as { n: number }).n;

  const links = idb.prepare("SELECT rowid AS rid, person_id, link_key, kind, ref_enc FROM issue_links").all() as { rid: number; person_id: string; link_key: string; kind: string; ref_enc: string }[];
  for (const l of links) {
    rep.linksScanned++;
    let ref: string;
    try { ref = (JSON.parse(p.decrypt("issue-link", l.ref_enc)) as { ref: string }).ref; } catch { rep.unreadableLinks++; continue; }
    const curKey = p.hmac("issue-link", `${l.person_id}|${l.kind}|${ref}`);
    // 1. issues-store pseudonyms for this (object, person)
    const oldPs = (l.kind === "issue" ? rp.map((v) => p.hmacVersioned("reporter-pseudonym", `issue:${ref}:${l.person_id}`, v)) : rp.map((v) => p.hmacVersioned("reporter-pseudonym", `media:${ref}:${l.person_id}`, v)));
    const newP = l.kind === "issue" ? p.hmac("reporter-pseudonym", `issue:${ref}:${l.person_id}`) : p.hmac("reporter-pseudonym", `media:${ref}:${l.person_id}`);
    for (const oldP of oldPs) {
      const targets = l.kind === "issue" ? REPORTER_COLS : [{ table: "issue_media", col: "owner_id", issueCol: "id" }];
      for (const t of targets) {
        rep.stalePseudonymRows += count(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.issueCol} = ? AND ${t.col} = ?`, ref, oldP);
        rep.updatedRows += exec("issues", () => Number(sdb.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.issueCol} = ? AND ${t.col} = ?`).run(newP, ref, oldP).changes));
      }
    }
    // 2. the link row itself (keyed link_key + ciphertext under the current versions)
    const staleKey = l.link_key !== curKey, staleEnc = /^v2\.(\d+)\./.exec(l.ref_enc)?.[1] !== String(p.keyInfo("issue-link").version);
    if (staleKey || staleEnc) {
      if (staleKey) rep.staleLinkKeys++;
      rep.updatedRows += exec("identity", () => Number(idb.prepare("UPDATE issue_links SET link_key = ?, ref_enc = ? WHERE person_id = ? AND link_key = ?").run(curKey, p.encrypt("issue-link", JSON.stringify({ kind: l.kind, ref })), l.person_id, l.link_key).changes));
    }
  }

  // actor pseudonyms (staff): moderation, rebuttals, lexicon proposals
  if (ap.length) {
    const staff = (idb.prepare("SELECT DISTINCT person_id FROM roles").all() as { person_id: string }[]).map((r) => r.person_id);
    for (const person of staff) {
      rep.actorsScanned++;
      const newA = p.hmac("actor-pseudonym", person);
      for (const v of ap) {
        const oldA = p.hmacVersioned("actor-pseudonym", person, v);
        const cols = [["officer_rebuttal", "author_id"], ["moderation_action", "actor_id"], ["lexicon_change", "proposer_id"]] as const;
        for (const [table, col] of cols) {
          rep.stalePseudonymRows += count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, oldA);
          rep.updatedRows += exec("issues", () => Number(sdb.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(newA, oldA).changes));
        }
        // lexicon dual control stores reviewer pseudonyms inside text columns
        rep.stalePseudonymRows += count("SELECT COUNT(*) AS n FROM lexicon_change WHERE instr(approvals, ?) > 0 OR rejected_by = ?", oldA, oldA);
        rep.updatedRows += exec("issues", () => Number(sdb.prepare("UPDATE lexicon_change SET approvals = replace(approvals, ?, ?), rejected_by = CASE WHEN rejected_by = ? THEN ? ELSE rejected_by END WHERE instr(approvals, ?) > 0 OR rejected_by = ?").run(oldA, newA, oldA, newA, oldA, oldA).changes));
      }
    }
  }
  return rep;
}

// --- ephemeral keyed values -----------------------------------------------------------------------------------------------------

const EPHEMERAL: Record<string, { store: StoreName; table: string }[]> = {
  otp: [{ store: "identity", table: "otps" }], rate: [{ store: "identity", table: "rate_events" }],
  pinsrc: [{ store: "identity", table: "pin_failures" }], session: [{ store: "identity", table: "sessions" }],
};
/** Purposes whose keyed values are short-lived: after a rotation they are cleared (users re-request a code / sign in again), not migrated. */
export function clearEphemeral(purpose: string, o: { dryRun?: boolean } = {}): { purpose: string; dryRun: boolean; table: string; rows: number }[] {
  const dryRun = o.dryRun !== false;
  return (EPHEMERAL[purpose] ?? []).map((t) => {
    const n = (getStore(t.store).prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get() as { n: number }).n;
    if (!dryRun) runInStore(t.store, () => getStore(t.store).prepare(`DELETE FROM ${t.table}`).run());
    return { purpose, dryRun, table: t.table, rows: n };
  });
}
