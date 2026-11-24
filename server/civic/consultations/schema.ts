/**
 * Consultation tables (survey store, migration consult_001). The survey store is the home of every "public record plus pseudonymous
 * rows" module: no persons.id is ever stored here. Feedback rows carry a keyed pseudonym per (consultation, person) so one person
 * counts once per clause and can edit their own row, yet nothing in the file names the account.
 */
import { getStore, registerMigration } from "../core";

registerMigration("consult_001_registry", `
CREATE TABLE consultations (
  id TEXT PRIMARY KEY,
  creator_pseudonym TEXT NOT NULL,
  department TEXT NOT NULL,
  title_en TEXT NOT NULL,
  title_te TEXT,
  bill_ref TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','open','closed','completed')),
  scope_state TEXT NOT NULL,
  scope_units TEXT NOT NULL DEFAULT '{}',
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  registered_at TEXT,
  approved_at TEXT,
  published_at TEXT,
  closed_at TEXT,
  completed_at TEXT,
  close_reason TEXT
);
CREATE INDEX idx_consultations_status ON consultations(status, registered_at);
CREATE INDEX idx_consultations_creator ON consultations(creator_pseudonym);
CREATE TABLE consultation_versions (
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  note_en TEXT,
  note_te TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (consultation_id, version)
);
CREATE TABLE consultation_corrections (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reason_en TEXT NOT NULL,
  reason_te TEXT,
  creator_pseudonym TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE consultation_panel_reviews (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  reviewer_pseudonym TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  notes TEXT,
  at TEXT NOT NULL,
  UNIQUE (consultation_id, content_hash, reviewer_pseudonym)
);
CREATE TABLE consultation_audio_reviews (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  clause_n INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  reviewer_pseudonym TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (consultation_id, clause_n, group_key, file_id)
);
CREATE TABLE consultation_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_consultation_log ON consultation_log(consultation_id, seq);
CREATE TABLE consultation_feedback (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  clause_n INTEGER NOT NULL,
  person_key TEXT NOT NULL,
  stance TEXT NOT NULL CHECK (stance IN ('support','support_changes','oppose','unclear','prefer_not')),
  comment TEXT,
  public_ok INTEGER NOT NULL DEFAULT 0,
  mod_verdict TEXT NOT NULL DEFAULT 'none' CHECK (mod_verdict IN ('none','ok','hold','released')),
  mod_reasons TEXT NOT NULL DEFAULT '[]',
  mandal TEXT,
  tier TEXT NOT NULL,
  quality TEXT NOT NULL DEFAULT 'normal',
  net_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edits INTEGER NOT NULL DEFAULT 0,
  UNIQUE (consultation_id, clause_n, person_key)
);
CREATE INDEX idx_consultation_feedback_c ON consultation_feedback(consultation_id, clause_n);
CREATE INDEX idx_consultation_feedback_p ON consultation_feedback(person_key);
CREATE TABLE consultation_burst (
  consultation_id TEXT NOT NULL,
  minute TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  limited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (consultation_id, minute)
);
CREATE TABLE consultation_comment_reviews (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  feedback_id TEXT NOT NULL,
  reviewer_pseudonym TEXT NOT NULL,
  reviewer_role TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (consultation_id, feedback_id)
);
CREATE TABLE consultation_machine_items (
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  feedback_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (consultation_id, feedback_id)
);
CREATE TABLE consultation_themes (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  clause_n INTEGER,
  label_en TEXT NOT NULL,
  label_te TEXT,
  source TEXT NOT NULL CHECK (source IN ('human','reviewer')),
  author_role TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE consultation_responses (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  clause_n INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('response','no_change')),
  text_en TEXT NOT NULL,
  text_te TEXT,
  author_pseudonym TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (consultation_id, clause_n)
);
CREATE TABLE consultation_reports (
  consultation_id TEXT PRIMARY KEY REFERENCES consultations(id),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published')),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  publisher_pseudonym TEXT NOT NULL,
  published_at TEXT NOT NULL
);

-- Append-only public records.
CREATE TRIGGER consultation_versions_no_update BEFORE UPDATE ON consultation_versions BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultation_versions_no_delete BEFORE DELETE ON consultation_versions BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultation_log_no_update BEFORE UPDATE ON consultation_log BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultation_log_no_delete BEFORE DELETE ON consultation_log BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultation_panel_no_update BEFORE UPDATE ON consultation_panel_reviews BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultation_panel_no_delete BEFORE DELETE ON consultation_panel_reviews BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultation_reports_no_update BEFORE UPDATE ON consultation_reports BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultation_reports_no_delete BEFORE DELETE ON consultation_reports BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER consultations_no_delete BEFORE DELETE ON consultations WHEN OLD.status <> 'draft' BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;

-- Frozen content: from in_review on, the registered content of version 1 and the identity of the consultation cannot change
-- (corrections add rows to consultation_versions and move version / content_hash only).
CREATE TRIGGER consultations_content_frozen BEFORE UPDATE ON consultations
WHEN OLD.status <> 'draft' AND (
  NEW.draft_json IS NOT OLD.draft_json OR NEW.title_en IS NOT OLD.title_en OR NEW.title_te IS NOT OLD.title_te OR NEW.department IS NOT OLD.department
  OR NEW.bill_ref IS NOT OLD.bill_ref OR NEW.source_url IS NOT OLD.source_url OR NEW.scope_state IS NOT OLD.scope_state OR NEW.scope_units IS NOT OLD.scope_units
  OR NEW.opens_at IS NOT OLD.opens_at OR NEW.closes_at IS NOT OLD.closes_at OR NEW.creator_pseudonym IS NOT OLD.creator_pseudonym)
BEGIN SELECT RAISE(ABORT, 'content_frozen'); END;
CREATE TRIGGER consultations_status_forward BEFORE UPDATE OF status ON consultations
WHEN (OLD.status IN ('closed','completed') AND NEW.status <> OLD.status AND NOT (OLD.status = 'closed' AND NEW.status = 'completed'))
  OR (OLD.status IN ('approved','open') AND NEW.status IN ('draft','in_review')) OR (OLD.status = 'completed')
BEGIN SELECT RAISE(ABORT, 'status_cannot_go_back'); END;
-- The mandatory closing report (S-36 c): a consultation cannot reach 'completed' without a PUBLISHED closing report. Enforced in the database too.
CREATE TRIGGER consultations_completed_needs_report BEFORE UPDATE OF status ON consultations
WHEN NEW.status = 'completed' AND NOT EXISTS (SELECT 1 FROM consultation_reports r WHERE r.consultation_id = NEW.id AND r.status = 'published')
BEGIN SELECT RAISE(ABORT, 'closing_report_required'); END;
`, "survey");

// S-154: stored recordings (uploaded by staff; served only once a panel reviewer marked them reviewed) and a moderator "reject" marker on held comments.
registerMigration("consult_002_audio_files", `
CREATE TABLE consultation_audio_files (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  clause_n INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  uploader_pseudonym TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  UNIQUE (consultation_id, file_id)
);
ALTER TABLE consultation_feedback ADD COLUMN mod_rejected INTEGER NOT NULL DEFAULT 0;
`, "survey");

export const cdb = () => getStore("survey");
