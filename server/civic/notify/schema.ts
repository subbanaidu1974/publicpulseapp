/** Tables for government notifications. All live in the identity store (they hold person ids: preferences, inbox, sender bindings). No message content is ever written to audit metadata. */
import { getDb, registerErasureHook, registerMigration } from "../core";

registerMigration("notify_001_core", `
CREATE TABLE notify_orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  letter_ref TEXT NOT NULL, email_domain TEXT NOT NULL, contact TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','rejected')),
  requested_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);
CREATE TABLE notify_senders (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','rejected','revoked')),
  requested_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);
CREATE INDEX idx_notify_senders_person ON notify_senders(person_id);
CREATE TABLE notify_credentials (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL, spki TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE INDEX idx_notify_credentials_person ON notify_credentials(person_id);
CREATE TABLE notify_challenges (
  challenge TEXT PRIMARY KEY, person_id TEXT NOT NULL, kind TEXT NOT NULL, purpose TEXT NOT NULL,
  message_id TEXT, msg_hash TEXT, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE notify_messages (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, created_by TEXT NOT NULL, category TEXT NOT NULL,
  state TEXT NOT NULL, district TEXT, target TEXT NOT NULL,
  title_en TEXT NOT NULL, title_te TEXT NOT NULL, text_en TEXT NOT NULL, text_te TEXT NOT NULL,
  template_id TEXT, slots TEXT, declaration TEXT, msg_hash TEXT NOT NULL,
  approvals_required INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','sending','sent','blocked','cancelled')),
  blocked_reason TEXT, mcc_window TEXT, created_at TEXT NOT NULL, approved_at TEXT, sent_at TEXT, expires_at TEXT,
  key_id TEXT, key_version INTEGER, signature TEXT, signed_payload TEXT, stats TEXT
);
CREATE INDEX idx_notify_messages_org ON notify_messages(org_id, created_at);
CREATE TABLE notify_approvals (
  message_id TEXT NOT NULL, person_id TEXT NOT NULL, at TEXT NOT NULL, credential_id TEXT NOT NULL,
  PRIMARY KEY (message_id, person_id)
);
CREATE TABLE notify_inbox (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL, message_id TEXT NOT NULL, category TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered','deferred','expired')),
  deliver_after TEXT, created_at TEXT NOT NULL, delivered_at TEXT, read_at TEXT,
  push_status TEXT, sms_status TEXT
);
CREATE INDEX idx_notify_inbox_person ON notify_inbox(person_id, created_at);
CREATE INDEX idx_notify_inbox_deferred ON notify_inbox(status, deliver_after);
CREATE TABLE notify_person (
  person_id TEXT PRIMARY KEY, quiet_start TEXT, quiet_end TEXT, antiphish_enc TEXT,
  language TEXT NOT NULL DEFAULT 'te', sms_ok INTEGER NOT NULL DEFAULT 0, push_blocked INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE notify_prefs (person_id TEXT NOT NULL, category TEXT NOT NULL, opted_in INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (person_id, category));
CREATE TABLE notify_devices (token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, token_enc TEXT NOT NULL, platform TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_notify_devices_person ON notify_devices(person_id);
CREATE TABLE notify_block_log (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, org_id TEXT, org_name TEXT NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE notify_kill (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('all','org')), org_id TEXT, reason TEXT NOT NULL,
  engaged_by TEXT NOT NULL, engaged_at TEXT NOT NULL,
  release_requested_by TEXT, release_requested_at TEXT, released_by TEXT, released_at TEXT
);
`);

registerErasureHook("notify.person", (personId) => {
  const d = getDb();
  for (const t of ["notify_prefs", "notify_person", "notify_devices", "notify_inbox", "notify_credentials", "notify_challenges"]) d.prepare(`DELETE FROM ${t} WHERE person_id = ?`).run(personId);
  d.prepare("UPDATE notify_senders SET status = 'revoked' WHERE person_id = ? AND status IN ('pending','active')").run(personId);
  d.prepare("UPDATE notify_approvals SET person_id = '[erased]' WHERE person_id = ?").run(personId);
  d.prepare("UPDATE notify_messages SET created_by = '[erased]' WHERE created_by = ?").run(personId);
});
