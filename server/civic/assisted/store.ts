/**
 * Assisted participation tables (S-49), in the ISSUES store. No assisted-person identifier exists anywhere: the person is never named, has no
 * phone or id here, and the only handle they hold is a paper receipt code of which only a keyed hash is stored.
 * Assistants, coordinators, reviewers and admins appear only as keyed actor pseudonyms (server/civic/core/pseudonyms.ts), like moderators.
 */
import { registerMigration, registerStoreErasureHook, getStore } from "../core";
import "../issues/service"; // the `issue` table (and its channel column) must be migrated first

registerMigration("assisted_001", `
CREATE TABLE IF NOT EXISTS assist_pair (
  id TEXT PRIMARY KEY, village_lgd TEXT NOT NULL, label TEXT,
  member_a TEXT NOT NULL, member_b TEXT NOT NULL, formed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', suspended_reason TEXT, suspended_by TEXT, suspended_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assist_pair_members ON assist_pair(member_a, member_b);
CREATE TABLE IF NOT EXISTS assisted_record (
  issue_id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, village_lgd TEXT NOT NULL,
  consent_by_a TEXT NOT NULL, consent_by_b TEXT NOT NULL, consent_at TEXT NOT NULL,
  receipt_code_hash TEXT NOT NULL UNIQUE,
  recheck_state TEXT NOT NULL DEFAULT 'not_sampled', recheck_due TEXT, flagged INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assisted_record_pair ON assisted_record(pair_id, created_at);
CREATE INDEX IF NOT EXISTS assisted_record_queue ON assisted_record(recheck_state, recheck_due);
CREATE TABLE IF NOT EXISTS assist_recheck (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL UNIQUE, reviewer_id TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assisted_switch_request (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, reason TEXT NOT NULL, requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);
`, "issues");

// Later controls reuse the dual-control request table: `target` names the pair, record or area an action applies to
// (actions: disable | enable | pair_reinstate | record_delete | village_suspend | village_resume).
registerMigration("assisted_002", `
ALTER TABLE assisted_switch_request ADD COLUMN target TEXT;
ALTER TABLE assist_pair ADD COLUMN reinstated_at TEXT;
`, "issues");

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");
const chunks = (subjects: string[], fn: (c: string[]) => void) => { for (let i = 0; i < subjects.length; i += 500) fn(subjects.slice(i, i + 500)); };

// Account erasure of an assistant, coordinator, reviewer or admin: their pseudonyms are blanked. A pair that loses a member is suspended
// (it can no longer authenticate as that pair anyway). Records, re-check outcomes and receipts stay: they hold no person.
registerStoreErasureHook("issues", "assisted.pseudonyms", (subjects) => {
  const d = getStore("issues");
  chunks(subjects, (c) => {
    const ph = inList(c.length);
    d.prepare(`UPDATE assist_pair SET status='suspended', suspended_reason=COALESCE(suspended_reason,'member erased'), suspended_at=COALESCE(suspended_at, ?) WHERE status='active' AND (member_a IN (${ph}) OR member_b IN (${ph}))`).run(new Date().toISOString(), ...c, ...c);
    d.prepare(`UPDATE assist_pair SET member_a='erased' WHERE member_a IN (${ph})`).run(...c);
    d.prepare(`UPDATE assist_pair SET member_b='erased' WHERE member_b IN (${ph})`).run(...c);
    d.prepare(`UPDATE assist_pair SET formed_by='erased' WHERE formed_by IN (${ph})`).run(...c);
    d.prepare(`UPDATE assist_pair SET suspended_by='erased' WHERE suspended_by IN (${ph})`).run(...c);
    d.prepare(`UPDATE assisted_record SET consent_by_a='erased' WHERE consent_by_a IN (${ph})`).run(...c);
    d.prepare(`UPDATE assisted_record SET consent_by_b='erased' WHERE consent_by_b IN (${ph})`).run(...c);
    d.prepare(`UPDATE assist_recheck SET reviewer_id='erased', note=NULL WHERE reviewer_id IN (${ph})`).run(...c);
    d.prepare(`UPDATE assisted_switch_request SET requested_by='erased' WHERE requested_by IN (${ph})`).run(...c);
    d.prepare(`UPDATE assisted_switch_request SET decided_by='erased' WHERE decided_by IN (${ph})`).run(...c);
  });
});
