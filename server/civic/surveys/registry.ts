/**
 * Pulse Survey registry (S-28 / E2E-37, S-34 / E2E-43; DESIGN_2028 3.3). Mounted by ./index at /api/v1/civic/surveys.
 *
 * Every survey is registered publicly when it is submitted to review: wording, scope and close date are FROZEN once it is approved
 * (an edit answers 409 `wording_frozen`; a changed wording is a new survey). Cancelled surveys stay in the registry with a public reason.
 * An independent panel (>= 2 distinct approvals on the current wording hash, never the creator or the creator's organisation) approves.
 * Creation quotas are equal per organisation (data/civic/survey-policy.json). Election-choice surveys are OFF by default and fail closed.
 *
 *  GET   /surveys                      public list (filters status, topic, state, q; cursor, limit)           same payload for every caller
 *  GET   /surveys/registry/log         public change + cancellation log (after=<seq>, kind=, limit)
 *  GET   /surveys/mine                 creator: own surveys including drafts, with wording findings
 *  GET   /surveys/quota?topic_class=   creator: quota state for the caller's organisation
 *  GET   /surveys/:id                  public detail: frozen wording, versions, panel decisions (no identities), cancellation
 *  GET   /surveys/:id/versions/:n      public: the immutable snapshot of one registered version (its sha256 is the wording hash)
 *  POST  /surveys                      creator roles (politician | officer | journalist | admin): create a draft
 *  PATCH /surveys/:id                  creator, draft only (409 wording_frozen otherwise)
 *  POST  /surveys/:id/submit           creator: to review (wording checks, quota, election gate)
 *  POST  /surveys/:id/panel/review     admin | survey_panel: {decision: approve|reject, notes}
 *  POST  /surveys/:id/open             creator, only when approved and the window allows
 *  POST  /surveys/:id/cancel           creator or admin: {reason_code, reason_text} (public reason mandatory)
 *  POST  /surveys/:id/close            creator or admin
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { audit, canonicalJson, getKeys, getStore, hasRole, listRolesDetailed, registerMigration, requireAuth, requireRole, runInStore } from "../core";
import { rateAllow } from "../identity/service";
import { surveysAllowed, windowState } from "../../window";
import { asksPartyPreference, checkWording, detectsPartyPreference, isPartyCode, missingPreferNot, reviewerConflict } from "./panel";
import { registerRegistryLookup } from "./source";
import { consumeQuota, hasConsumed, quotaKey, quotaStatus } from "./quota";
import {
  ORG_KINDS, QUESTION_KINDS, SCOPE_UNIT_KEYS, SURVEY_STATUSES, TOPIC_CLASSES, disclaimer, electionChoiceFlag, registryNow, str, surveyPolicy,
} from "./types";
import type { Finding, OptionInput, OrgKind, QuestionInput, Scope, ScopeUnits, SurveyRow, SurveyStatus, TopicClass, WordingSnapshot } from "./types";

// ---------------------------------------------------------------------------------------------
// Schema (survey store)
// ---------------------------------------------------------------------------------------------

registerMigration("survey_001_registry", `
CREATE TABLE surveys (
  id TEXT PRIMARY KEY,
  creator_pseudonym TEXT NOT NULL,
  creator_org_kind TEXT NOT NULL CHECK (creator_org_kind IN ('party','government','civil_society','media','academic','platform')),
  creator_org_code TEXT,
  department TEXT,
  topic_class TEXT NOT NULL CHECK (topic_class IN ('issue_service','bill','political','election_choice')),
  election_choice INTEGER NOT NULL DEFAULT 0,
  title_en TEXT NOT NULL,
  title_te TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','open','closed','cancelled')),
  scope_state TEXT NOT NULL,
  scope_units TEXT NOT NULL DEFAULT '{}',
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  wording_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  registered_at TEXT,
  approved_at TEXT,
  opened_at TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX idx_surveys_status ON surveys(status, registered_at);
CREATE INDEX idx_surveys_creator ON surveys(creator_pseudonym);
CREATE TABLE survey_questions (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('single','multi','scale5')),
  text_en TEXT NOT NULL,
  text_te TEXT,
  max_select INTEGER
);
CREATE INDEX idx_survey_questions_survey ON survey_questions(survey_id, ord);
CREATE TABLE survey_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES survey_questions(id),
  ord INTEGER NOT NULL,
  label_en TEXT NOT NULL,
  label_te TEXT,
  prefer_not INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_survey_options_question ON survey_options(question_id, ord);
CREATE TABLE survey_versions (
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  version INTEGER NOT NULL,
  wording_json TEXT NOT NULL,
  wording_hash TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (survey_id, version)
);
CREATE TABLE panel_reviews (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  version INTEGER NOT NULL,
  wording_hash TEXT NOT NULL,
  reviewer_pseudonym TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  notes TEXT,
  at TEXT NOT NULL,
  UNIQUE (survey_id, wording_hash, reviewer_pseudonym)
);
CREATE TABLE cancellations (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  actor_pseudonym TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE survey_registry_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE survey_quota_events (
  survey_id TEXT PRIMARY KEY REFERENCES surveys(id),
  org_kind TEXT NOT NULL,
  quota_key TEXT NOT NULL,
  quota_class TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_quota_events ON survey_quota_events(org_kind, quota_key, at);

-- Append-only public records.
CREATE TRIGGER survey_versions_no_update BEFORE UPDATE ON survey_versions BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER survey_versions_no_delete BEFORE DELETE ON survey_versions BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER cancellations_no_update BEFORE UPDATE ON cancellations BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER cancellations_no_delete BEFORE DELETE ON cancellations BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER registry_log_no_update BEFORE UPDATE ON survey_registry_log BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER registry_log_no_delete BEFORE DELETE ON survey_registry_log BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER panel_reviews_no_update BEFORE UPDATE ON panel_reviews BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER panel_reviews_no_delete BEFORE DELETE ON panel_reviews BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;
CREATE TRIGGER surveys_no_delete BEFORE DELETE ON surveys WHEN OLD.status <> 'draft' BEGIN SELECT RAISE(ABORT, 'registry_append_only'); END;

-- Frozen wording: from in_review on, nothing that is part of the wording can change (the status columns can).
CREATE TRIGGER surveys_wording_frozen BEFORE UPDATE ON surveys
WHEN OLD.status <> 'draft' AND (
  NEW.title_en IS NOT OLD.title_en OR NEW.title_te IS NOT OLD.title_te OR NEW.topic_class IS NOT OLD.topic_class
  OR NEW.election_choice IS NOT OLD.election_choice OR NEW.scope_state IS NOT OLD.scope_state OR NEW.scope_units IS NOT OLD.scope_units
  OR NEW.opens_at IS NOT OLD.opens_at OR NEW.closes_at IS NOT OLD.closes_at OR NEW.wording_hash IS NOT OLD.wording_hash
  OR NEW.version IS NOT OLD.version OR NEW.department IS NOT OLD.department OR NEW.creator_org_kind IS NOT OLD.creator_org_kind
  OR NEW.creator_org_code IS NOT OLD.creator_org_code OR NEW.creator_pseudonym IS NOT OLD.creator_pseudonym)
BEGIN SELECT RAISE(ABORT, 'wording_frozen'); END;
CREATE TRIGGER surveys_status_forward BEFORE UPDATE OF status ON surveys
WHEN (OLD.status IN ('closed','cancelled') AND NEW.status <> OLD.status) OR (OLD.status IN ('approved','open') AND NEW.status IN ('draft','in_review'))
BEGIN SELECT RAISE(ABORT, 'status_cannot_go_back'); END;
CREATE TRIGGER survey_questions_frozen_i BEFORE INSERT ON survey_questions
WHEN (SELECT status FROM surveys WHERE id = NEW.survey_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'wording_frozen'); END;
CREATE TRIGGER survey_questions_frozen_u BEFORE UPDATE ON survey_questions
WHEN (SELECT status FROM surveys WHERE id = OLD.survey_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'wording_frozen'); END;
CREATE TRIGGER survey_questions_frozen_d BEFORE DELETE ON survey_questions
WHEN (SELECT status FROM surveys WHERE id = OLD.survey_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'wording_frozen'); END;
CREATE TRIGGER survey_options_frozen_i BEFORE INSERT ON survey_options
WHEN (SELECT s.status FROM survey_questions q JOIN surveys s ON s.id = q.survey_id WHERE q.id = NEW.question_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'wording_frozen'); END;
CREATE TRIGGER survey_options_frozen_u BEFORE UPDATE ON survey_options
WHEN (SELECT s.status FROM survey_questions q JOIN surveys s ON s.id = q.survey_id WHERE q.id = OLD.question_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'wording_frozen'); END;
CREATE TRIGGER survey_options_frozen_d BEFORE DELETE ON survey_options
WHEN (SELECT s.status FROM survey_questions q JOIN surveys s ON s.id = q.survey_id WHERE q.id = OLD.question_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'wording_frozen'); END;
`, "survey");

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const db = () => getStore("survey");
const iso = (d: Date) => d.toISOString();
const fail = (res: Response, status: number, code: string, extra: Record<string, unknown> = {}) => { res.status(status).json({ error: code, code, ...extra }); };
const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (e) { if (!res.headersSent) fail(res, 500, "internal_error"); void e; }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const trim = (v: unknown, max: number) => str(v).replace(/\s+/g, " ").trim().slice(0, max);

/** Stable per-person pseudonym for the survey store (creators, reviewers, cancelling actors). Never persons.id. */
export const surveyActorPseudonym = (personId: string): string => getKeys().hmac("survey-actor", personId);

/** Election-choice surveys: fail closed. Needs CIVIC_ELECTION_CHOICE_SURVEYS=1 AND windowState(state) === "open" (not blackout, not unknown). */
export function electionGate(state: string, now: Date): { ok: true } | { ok: false; reason: "flag_off" | "blackout" | "unknown" } {
  if (!electionChoiceFlag()) return { ok: false, reason: "flag_off" };
  const w = windowState(state, now);
  if (w !== "open") return { ok: false, reason: w };
  return { ok: true };
}
export const electionChoiceAllowed = (state: string, now: Date): boolean => electionGate(state, now).ok;

/** Public hidden reason: an election-choice survey that is not yet closed is hidden whenever the election gate is shut. */
export function hiddenReason(s: Pick<SurveyRow, "election_choice" | "status" | "scope_state">, now: Date): "election_window" | null {
  if (!s.election_choice) return null;
  if (s.status !== "in_review" && s.status !== "approved" && s.status !== "open") return null;
  return electionChoiceAllowed(s.scope_state, now) ? null : "election_window";
}

export const getSurvey = (id: string): SurveyRow | undefined => db().prepare("SELECT * FROM surveys WHERE id = ?").get(id) as unknown as SurveyRow | undefined;

/** Can responses be collected now? For the credential / response modules: status open, inside [opens_at, closes_at), election gate. */
export function surveyAnswerable(s: SurveyRow, now: Date = registryNow()): { ok: true } | { ok: false; reason: "not_open" | "outside_window" | "election_window" } {
  if (s.status !== "open") return { ok: false, reason: "not_open" };
  const t = now.getTime();
  if (t < Date.parse(s.opens_at) || t >= Date.parse(s.closes_at)) return { ok: false, reason: "outside_window" };
  if (s.election_choice && !electionChoiceAllowed(s.scope_state, now)) return { ok: false, reason: "election_window" };
  return { ok: true };
}

/** May aggregate figures of this survey be published now? Election-choice surveys: never in blackout or unknown (fail closed). */
export function figuresPublishable(s: Pick<SurveyRow, "election_choice" | "scope_state">, now: Date = registryNow()): { ok: true } | { ok: false; reason: "election_window" } {
  if (s.election_choice && !surveysAllowed(s.scope_state, now)) return { ok: false, reason: "election_window" };
  return { ok: true };
}

function logEvent(surveyId: string, kind: string, detail: Record<string, unknown>, at: Date): void {
  db().prepare("INSERT INTO survey_registry_log (survey_id, kind, at, detail) VALUES (?,?,?,?)").run(surveyId, kind, iso(at), canonicalJson(detail));
}

// ---------------------------------------------------------------------------------------------
// Creator context (role -> organisation)
// ---------------------------------------------------------------------------------------------

export interface CreatorCtx { kind: OrgKind; code: string | null; department: string | null }
type CreatorResult = { ok: true; ctx: CreatorCtx } | { ok: false; status: number; code: string };

/**
 * Creation rights come from the roles table: politician -> party (the role's `department` carries the party code, e.g. TDP),
 * officer -> government (department mandatory), journalist -> media, admin -> platform (or academic / civil_society on behalf of such a body).
 */
export function resolveCreator(personId: string, hint: { org_kind?: string; org_code?: string } = {}): CreatorResult {
  const roles = listRolesDetailed(personId);
  const order: { role: string; kind: OrgKind }[] = [
    { role: "politician", kind: "party" }, { role: "officer", kind: "government" }, { role: "journalist", kind: "media" }, { role: "admin", kind: "platform" },
  ];
  const want = hint.org_kind;
  for (const o of order) {
    const held = roles.filter((r) => r.role === o.role);
    if (!held.length) continue;
    if (want && !(want === o.kind || (o.role === "admin" && (want === "academic" || want === "civil_society" || want === "platform")))) continue;
    if (o.role === "politician") {
      const r = held.find((x) => x.department && isPartyCode(x.department));
      if (!r) return { ok: false, status: 403, code: "party_scope_missing" };
      return { ok: true, ctx: { kind: "party", code: r.department!.toUpperCase(), department: null } };
    }
    if (o.role === "officer") {
      const r = held.find((x) => x.department);
      if (!r) return { ok: false, status: 403, code: "department_required" };
      return { ok: true, ctx: { kind: "government", code: null, department: r.department!.slice(0, 64) } };
    }
    if (o.role === "journalist") return { ok: true, ctx: { kind: "media", code: held[0].department ? held[0].department.slice(0, 64) : null, department: null } };
    const kind = want === "academic" || want === "civil_society" ? want : "platform";
    return { ok: true, ctx: { kind, code: trim(hint.org_code, 64) || null, department: null } };
  }
  return { ok: false, status: 403, code: "creator_role_required" };
}

// ---------------------------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------------------------

interface DraftData {
  topic_class: TopicClass; election_choice: boolean; title_en: string; title_te: string | null; scope: Scope; opens_at: string; closes_at: string;
  asks_party_preference: boolean; questions: (QuestionInput & { options: Required<OptionInput>[] })[];
}
type Bad = { status: 400; code: string; extra?: Record<string, unknown> };
const bad = (code: string, extra?: Record<string, unknown>): Bad => ({ status: 400, code, extra });

function parseIso(v: unknown): string | null {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseScope(v: unknown): Scope | Bad {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const state = str(o.state).trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(state)) return bad("scope_state_required");
  const units: ScopeUnits = {};
  const raw = (o.units && typeof o.units === "object" ? o.units : {}) as Record<string, unknown>;
  let total = 0;
  for (const k of Object.keys(raw)) {
    if (!(SCOPE_UNIT_KEYS as readonly string[]).includes(k)) return bad("scope_unit_unknown", { unit: k });
    const arr = raw[k];
    if (!Array.isArray(arr)) return bad("scope_unit_invalid", { unit: k });
    const vals = [...new Set(arr.map((x) => (typeof x === "number" ? String(x) : str(x).trim())))].filter(Boolean);
    if (vals.some((x) => !/^[A-Za-z0-9_-]{1,32}$/.test(x))) return bad("scope_unit_invalid", { unit: k });
    total += vals.length;
    if (vals.length) (units as Record<string, string[]>)[k] = vals.sort();
  }
  if (total > surveyPolicy().limits.max_scope_units) return bad("scope_too_large");
  return { state, units };
}

function parseQuestions(v: unknown): DraftData["questions"] | Bad {
  const L = surveyPolicy().limits;
  if (!Array.isArray(v) || v.length < 1) return bad("questions_required");
  if (v.length > L.max_questions) return bad("too_many_questions", { max: L.max_questions });
  const out: DraftData["questions"] = [];
  for (let i = 0; i < v.length; i++) {
    const q = (v[i] && typeof v[i] === "object" ? v[i] : {}) as Record<string, unknown>;
    const kind = str(q.kind) as QuestionInput["kind"];
    if (!(QUESTION_KINDS as readonly string[]).includes(kind)) return bad("question_kind_invalid", { question: i + 1 });
    const text_en = trim(q.text_en, L.max_question_chars + 1);
    if (text_en.length < 3 || text_en.length > L.max_question_chars) return bad("question_text_invalid", { question: i + 1 });
    const text_te = trim(q.text_te, L.max_question_chars + 1) || null;
    if (text_te && text_te.length > L.max_question_chars) return bad("question_text_invalid", { question: i + 1 });
    const supplied = (Array.isArray(q.options) ? q.options : []).map((o) => {
      const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      return { label_en: trim(x.label_en, 121), label_te: trim(x.label_te, 121) || null, prefer_not: x.prefer_not === true };
    });
    if (supplied.some((o) => o.label_en.length < 1 || o.label_en.length > 120 || (o.label_te ?? "").length > 120)) return bad("option_label_invalid", { question: i + 1 });
    let options: Required<OptionInput>[];
    if (kind === "scale5") {
      if (supplied.some((o) => !o.prefer_not)) return bad("scale5_options_fixed", { question: i + 1 });
      options = [...surveyPolicy().scale5_labels.map((l) => ({ label_en: l.en, label_te: l.te as string | null, prefer_not: false })), ...supplied];
    } else options = supplied;
    if (options.filter((o) => o.prefer_not).length > 1) return bad("one_prefer_not_only", { question: i + 1 });
    if (options.length < L.min_options || options.length > L.max_options) return bad("option_count_invalid", { question: i + 1, min: L.min_options, max: L.max_options });
    if (new Set(options.map((o) => o.label_en.toLowerCase())).size !== options.length) return bad("option_duplicate", { question: i + 1 });
    let max_select: number | null = null;
    if (kind === "multi") {
      const real = options.filter((o) => !o.prefer_not).length;
      const n = Number(q.max_select);
      if (!Number.isInteger(n) || n < 2 || n > real) return bad("max_select_invalid", { question: i + 1, min: 2, max: real });
      max_select = n;
    }
    out.push({ kind, text_en, text_te, max_select, options });
  }
  return out;
}

function parseDraft(body: Record<string, unknown>, now: Date): DraftData | Bad {
  const L = surveyPolicy().limits;
  const topic = str(body.topic_class) as TopicClass;
  if (!(TOPIC_CLASSES as readonly string[]).includes(topic)) return bad("topic_class_invalid", { topic_classes: TOPIC_CLASSES });
  const title_en = trim(body.title_en, L.max_title_chars + 1);
  if (title_en.length < 3 || title_en.length > L.max_title_chars) return bad("title_invalid");
  const title_te = trim(body.title_te, L.max_title_chars + 1) || null;
  if (title_te && title_te.length > L.max_title_chars) return bad("title_invalid");
  const scope = parseScope(body.scope);
  if ("status" in scope) return scope;
  const opens_at = parseIso(body.opens_at), closes_at = parseIso(body.closes_at);
  if (!opens_at || !closes_at) return bad("window_invalid");
  if (Date.parse(closes_at) <= Date.parse(opens_at)) return bad("window_invalid");
  if (Date.parse(closes_at) <= now.getTime()) return bad("closes_in_past");
  if (Date.parse(closes_at) - Date.parse(opens_at) > L.max_duration_days * 86_400_000) return bad("window_too_long", { max_days: L.max_duration_days });
  const questions = parseQuestions(body.questions);
  if (!Array.isArray(questions)) return questions;
  const declared = body.asks_party_preference === true;
  if (declared && topic !== "political" && topic !== "election_choice") return bad("party_preference_needs_political_topic");
  const election = topic === "election_choice" || declared || (topic === "political" && detectsPartyPreference(title_en, questions));
  return { topic_class: topic, election_choice: election, title_en, title_te, scope, opens_at, closes_at, asks_party_preference: declared, questions };
}

function snapshotOf(d: DraftData, c: CreatorCtx): WordingSnapshot {
  return {
    title_en: d.title_en, title_te: d.title_te, topic_class: d.topic_class, election_choice: d.election_choice,
    creator_org_kind: c.kind, creator_org_code: c.code, department: c.department, scope: d.scope, opens_at: d.opens_at, closes_at: d.closes_at,
    questions: d.questions.map((q) => ({
      kind: q.kind, max_select: q.max_select ?? null, text_en: q.text_en, text_te: q.text_te ?? null,
      options: q.options.map((o) => ({ label_en: o.label_en, label_te: o.label_te ?? null, prefer_not: !!o.prefer_not })),
    })),
  };
}
const hashOf = (s: WordingSnapshot) => sha256(canonicalJson(s));

interface QRow { id: string; ord: number; kind: QuestionInput["kind"]; text_en: string; text_te: string | null; max_select: number | null }
interface ORow { id: string; question_id: string; ord: number; label_en: string; label_te: string | null; prefer_not: number }
function loadQuestions(surveyId: string) {
  const qs = db().prepare("SELECT id, ord, kind, text_en, text_te, max_select FROM survey_questions WHERE survey_id = ? ORDER BY ord").all(surveyId) as unknown as QRow[];
  const os = db().prepare("SELECT o.id, o.question_id, o.ord, o.label_en, o.label_te, o.prefer_not FROM survey_options o JOIN survey_questions q ON q.id = o.question_id WHERE q.survey_id = ? ORDER BY o.ord").all(surveyId) as unknown as ORow[];
  return qs.map((q) => ({
    id: q.id, ord: q.ord, kind: q.kind, max_select: q.max_select, text_en: q.text_en, text_te: q.text_te,
    options: os.filter((o) => o.question_id === q.id).map((o) => ({ id: o.id, ord: o.ord, label_en: o.label_en, label_te: o.label_te, prefer_not: !!o.prefer_not })),
  }));
}

function draftOf(s: SurveyRow): DraftData {
  return {
    topic_class: s.topic_class, election_choice: !!s.election_choice, title_en: s.title_en, title_te: s.title_te,
    scope: { state: s.scope_state, units: JSON.parse(s.scope_units) as ScopeUnits }, opens_at: s.opens_at, closes_at: s.closes_at, asks_party_preference: false,
    questions: loadQuestions(s.id).map((q) => ({ kind: q.kind, text_en: q.text_en, text_te: q.text_te, max_select: q.max_select, options: q.options.map((o) => ({ label_en: o.label_en, label_te: o.label_te, prefer_not: o.prefer_not })) })),
  };
}
const ctxOf = (s: SurveyRow): CreatorCtx => ({ kind: s.creator_org_kind, code: s.creator_org_code, department: s.department });

function writeQuestions(surveyId: string, qs: DraftData["questions"]): void {
  const iq = db().prepare("INSERT INTO survey_questions (id, survey_id, ord, kind, text_en, text_te, max_select) VALUES (?,?,?,?,?,?,?)");
  const io = db().prepare("INSERT INTO survey_options (id, question_id, ord, label_en, label_te, prefer_not) VALUES (?,?,?,?,?,?)");
  qs.forEach((q, i) => {
    const qid = crypto.randomUUID();
    iq.run(qid, surveyId, i + 1, q.kind, q.text_en, q.text_te ?? null, q.max_select ?? null);
    q.options.forEach((o, j) => io.run(crypto.randomUUID(), qid, j + 1, o.label_en, o.label_te ?? null, o.prefer_not ? 1 : 0));
  });
}

// ---------------------------------------------------------------------------------------------
// Public payloads
// ---------------------------------------------------------------------------------------------

const cancellationOf = (id: string) => {
  const c = db().prepare("SELECT reason_code, reason_text, at FROM cancellations WHERE survey_id = ?").get(id) as { reason_code: string; reason_text: string; at: string } | undefined;
  return c ? { reason_code: c.reason_code, reason_text: c.reason_text, at: c.at } : null;
};

function summary(s: SurveyRow, now: Date) {
  return {
    id: s.id, status: s.status, topic_class: s.topic_class, election_choice: !!s.election_choice, title_en: s.title_en, title_te: s.title_te,
    creator: { org_kind: s.creator_org_kind, org_code: s.creator_org_code, department: s.department },
    scope: { state: s.scope_state, units: JSON.parse(s.scope_units) as ScopeUnits },
    opens_at: s.opens_at, closes_at: s.closes_at, registered_at: s.registered_at, approved_at: s.approved_at, opened_at: s.opened_at, closed_at: s.closed_at,
    version: s.version, wording_hash: s.wording_hash, hidden_reason: hiddenReason(s, now), cancellation: s.status === "cancelled" ? cancellationOf(s.id) : null,
    ...disclaimer(),
  };
}

function panelSummary(s: SurveyRow) {
  const rows = db().prepare("SELECT version, wording_hash, decision, notes, at FROM panel_reviews WHERE survey_id = ? ORDER BY at, rowid").all(s.id) as unknown as
    { version: number; wording_hash: string; decision: "approve" | "reject"; notes: string | null; at: string }[];
  const cur = rows.filter((r) => r.wording_hash === s.wording_hash);
  return {
    required_approvals: surveyPolicy().panel.min_approvals,
    approvals: cur.filter((r) => r.decision === "approve").length,
    rejections: cur.filter((r) => r.decision === "reject").length,
    decisions: rows.map((r) => ({ version: r.version, wording_hash: r.wording_hash, decision: r.decision, notes: r.notes, at: r.at, current: r.wording_hash === s.wording_hash })),
  };
}

function detail(s: SurveyRow, now: Date) {
  const sm = summary(s, now);
  const versions = db().prepare("SELECT version, wording_hash, registered_at FROM survey_versions WHERE survey_id = ? ORDER BY version").all(s.id) as unknown as { version: number; wording_hash: string; registered_at: string }[];
  return {
    ...sm,
    questions: sm.hidden_reason ? [] : loadQuestions(s.id),
    versions, panel: panelSummary(s),
  };
}

const PUBLIC_STATUSES: SurveyStatus[] = ["in_review", "approved", "open", "closed", "cancelled"];
const pubLimit = (name: string, limit: number) => (req: Request, res: Response, next: express.NextFunction): void => {
  if (!rateAllow(`surveypub:${name}:${req.ip || "?"}`, limit, 60 * 1000)) return void fail(res, 429, "too_many_requests");
  next();
};
const cacheShort = (res: Response) => res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");

const enc = (a: string, b: string) => Buffer.from(`${a}|${b}`).toString("base64url");
const dec = (c: string): [string, string] | null => { try { const [a, b] = Buffer.from(c, "base64url").toString().split("|"); return a && b ? [a, b] : null; } catch { return null; } };

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export const registryRouter = Router();
registryRouter.use(express.json({ limit: "64kb" }));

registryRouter.get("/", pubLimit("list", 120), wrap((req, res) => {
  const now = registryNow();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 20));
  const status = str(req.query.status), topic = str(req.query.topic), state = str(req.query.state).toUpperCase(), q = str(req.query.q).trim().slice(0, 100);
  const includeHidden = req.query.include_hidden === "1";
  if (status && !(SURVEY_STATUSES as readonly string[]).includes(status)) return fail(res, 400, "status_invalid");
  if (topic && !(TOPIC_CLASSES as readonly string[]).includes(topic)) return fail(res, 400, "topic_invalid");
  const cur = req.query.cursor ? dec(str(req.query.cursor)) : null;
  if (req.query.cursor && !cur) return fail(res, 400, "cursor_invalid");
  const out: ReturnType<typeof summary>[] = [];
  const statuses = (status ? [status] : PUBLIC_STATUSES).filter((x) => (PUBLIC_STATUSES as string[]).includes(x));
  let after = cur;
  let nextCursor: string | null = null;
  const BATCH = 100;
  outer: for (let guard = 0; guard < 100 && statuses.length; guard++) {
    const where = [`status IN (${statuses.map(() => "?").join(",")})`, "registered_at IS NOT NULL"];
    const args: (string | number)[] = [...statuses];
    if (topic) { where.push("topic_class = ?"); args.push(topic); }
    if (state) { where.push("scope_state = ?"); args.push(state); }
    if (q) { const like = "%" + q.replace(/[!%_]/g, "!$&") + "%"; where.push("(title_en LIKE ? ESCAPE '!' OR title_te LIKE ? ESCAPE '!')"); args.push(like, like); }
    if (after) { where.push("(registered_at < ? OR (registered_at = ? AND id < ?))"); args.push(after[0], after[0], after[1]); }
    const rows = db().prepare(`SELECT * FROM surveys WHERE ${where.join(" AND ")} ORDER BY registered_at DESC, id DESC LIMIT ${BATCH}`).all(...args) as unknown as SurveyRow[];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      after = [r.registered_at!, r.id];
      if (!includeHidden && hiddenReason(r, now)) continue;
      out.push(summary(r, now));
      if (out.length >= limit) { if (i < rows.length - 1 || rows.length === BATCH) nextCursor = enc(r.registered_at!, r.id); break outer; }
    }
    if (rows.length < BATCH) break;
  }
  cacheShort(res);
  res.json({ surveys: out, next_cursor: nextCursor, ...disclaimer() });
}));

registryRouter.get("/registry/log", pubLimit("log", 60), wrap((req, res) => {
  const after = Math.max(0, Math.floor(Number(req.query.after)) || 0);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 100));
  const kind = str(req.query.kind);
  const rows = db().prepare(`SELECT seq, survey_id, kind, at, detail FROM survey_registry_log WHERE seq > ? ${kind ? "AND kind = ?" : ""} ORDER BY seq LIMIT ?`)
    .all(...(kind ? [after, kind, limit] : [after, limit])) as unknown as { seq: number; survey_id: string; kind: string; at: string; detail: string }[];
  cacheShort(res);
  res.json({ entries: rows.map((r) => ({ seq: r.seq, survey_id: r.survey_id, kind: r.kind, at: r.at, detail: JSON.parse(r.detail) })), next_after: rows.length === limit ? rows[rows.length - 1].seq : null, ...disclaimer() });
}));

registryRouter.get("/mine", requireRole("politician", "officer", "journalist", "admin"), wrap((req, res) => {
  const now = registryNow();
  const rows = db().prepare("SELECT * FROM surveys WHERE creator_pseudonym = ? ORDER BY created_at DESC LIMIT 200").all(surveyActorPseudonym(req.person!.id)) as unknown as SurveyRow[];
  res.json({
    surveys: rows.map((s) => ({ ...detail(s, now), findings: s.status === "draft" ? checkWording(s.title_en, s.title_te, draftOf(s).questions) : [] })),
    ...disclaimer(),
  });
}));

registryRouter.get("/quota", requireRole("politician", "officer", "journalist", "admin"), wrap((req, res) => {
  const topic = str(req.query.topic_class) as TopicClass;
  if (!(TOPIC_CLASSES as readonly string[]).includes(topic)) return fail(res, 400, "topic_class_invalid");
  const c = resolveCreator(req.person!.id, { org_kind: str(req.query.org_kind), org_code: str(req.query.org_code) });
  if (c.ok === false) return fail(res, c.status, c.code);
  const key = quotaKey(c.ctx.kind, c.ctx.code, c.ctx.department, surveyActorPseudonym(req.person!.id));
  res.json({ org_kind: c.ctx.kind, org_code: c.ctx.code, department: c.ctx.department, window_days: surveyPolicy().quota.window_days, ...quotaStatus(c.ctx.kind, key, topic, registryNow()) });
}));

registryRouter.get("/:id", pubLimit("get", 240), wrap((req, res) => {
  const s = UUID.test(req.params.id) ? getSurvey(req.params.id) : undefined;
  if (!s || s.status === "draft" || !s.registered_at) return fail(res, 404, "not_found");
  cacheShort(res);
  res.json(detail(s, registryNow()));
}));

registryRouter.get("/:id/versions/:n", pubLimit("ver", 240), wrap((req, res) => {
  const s = UUID.test(req.params.id) ? getSurvey(req.params.id) : undefined;
  if (!s || s.status === "draft" || !s.registered_at) return fail(res, 404, "not_found");
  if (hiddenReason(s, registryNow())) return fail(res, 404, "hidden", { hidden_reason: "election_window" });
  const v = db().prepare("SELECT version, wording_json, wording_hash, registered_at FROM survey_versions WHERE survey_id = ? AND version = ?").get(s.id, Number(req.params.n)) as unknown as
    { version: number; wording_json: string; wording_hash: string; registered_at: string } | undefined;
  if (!v) return fail(res, 404, "not_found");
  res.json({ version: v.version, wording_hash: v.wording_hash, registered_at: v.registered_at, wording: JSON.parse(v.wording_json), hash_algorithm: "sha256(canonical JSON of wording)", ...disclaimer() });
}));

// ---- create / edit ----------------------------------------------------------------------------

function electionDenied(res: Response, reason: string): void { fail(res, 403, "election_choice_disabled", { reason }); }

registryRouter.post("/", requireRole("politician", "officer", "journalist", "admin"), wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const c = resolveCreator(me, { org_kind: str(body.org_kind), org_code: str(body.org_code) });
  if (c.ok === false) return fail(res, c.status, c.code);
  const d = parseDraft(body, now);
  if ("status" in d) return fail(res, d.status, d.code, d.extra);
  if (d.election_choice) { const g = electionGate(d.scope.state, now); if (g.ok === false) return electionDenied(res, g.reason); }
  const rule = surveyPolicy().quota.kinds[c.ctx.kind];
  if (!rule || !rule.allowed.includes(d.topic_class)) return fail(res, 403, "topic_not_allowed_for_org", { org_kind: c.ctx.kind, allowed: rule?.allowed ?? [] });
  const snap = snapshotOf(d, c.ctx), hash = hashOf(snap), id = crypto.randomUUID();
  runInStore("survey", () => {
    db().prepare(`INSERT INTO surveys (id, creator_pseudonym, creator_org_kind, creator_org_code, department, topic_class, election_choice, title_en, title_te, status, scope_state, scope_units, opens_at, closes_at, version, wording_hash, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?,1,?,?)`)
      .run(id, surveyActorPseudonym(me), c.ctx.kind, c.ctx.code, c.ctx.department, d.topic_class, d.election_choice ? 1 : 0, d.title_en, d.title_te, d.scope.state, JSON.stringify(d.scope.units), d.opens_at, d.closes_at, hash, iso(now));
    writeQuestions(id, d.questions);
    audit(me, "survey.create", "survey:" + id, { org_kind: c.ctx.kind, topic_class: d.topic_class, election_choice: d.election_choice });
  });
  res.status(201).json({ id, status: "draft", version: 1, wording_hash: hash, election_choice: d.election_choice, creator: { org_kind: c.ctx.kind, org_code: c.ctx.code, department: c.ctx.department }, findings: checkWording(d.title_en, d.title_te, d.questions), ...disclaimer() });
}));

/** Loads a survey for a creator-only action; sends the failure itself. */
function ownSurvey(req: Request, res: Response, opts: { allowAdmin?: boolean } = {}): SurveyRow | null {
  const s = UUID.test(req.params.id) ? getSurvey(req.params.id) : undefined;
  if (!s) { fail(res, 404, "not_found"); return null; }
  const mine = s.creator_pseudonym === surveyActorPseudonym(req.person!.id);
  const admin = !!opts.allowAdmin && hasRole(req.person!.id, "admin");
  if (!mine && !(admin && s.status !== "draft")) { fail(res, s.status === "draft" ? 404 : 403, s.status === "draft" ? "not_found" : "creator_only"); return null; }
  return s;
}

registryRouter.patch("/:id", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const s = ownSurvey(req, res); if (!s) return;
  if (s.status !== "draft") return fail(res, 409, "wording_frozen", { status: s.status, hint: "a changed wording needs a new survey" });
  const cur = draftOf(s);
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const merged = {
    topic_class: body.topic_class ?? cur.topic_class, title_en: body.title_en ?? cur.title_en, title_te: "title_te" in body ? body.title_te : cur.title_te,
    scope: body.scope ?? cur.scope, opens_at: body.opens_at ?? cur.opens_at, closes_at: body.closes_at ?? cur.closes_at,
    questions: body.questions ?? cur.questions.map((q) => (q.kind === "scale5" ? { ...q, options: q.options.filter((o) => o.prefer_not) } : q)), asks_party_preference: "asks_party_preference" in body ? body.asks_party_preference : false,
  };
  const d = parseDraft(merged, now);
  if ("status" in d) return fail(res, d.status, d.code, d.extra);
  if (d.election_choice) { const g = electionGate(d.scope.state, now); if (g.ok === false) return electionDenied(res, g.reason); }
  const rule = surveyPolicy().quota.kinds[s.creator_org_kind];
  if (!rule || !rule.allowed.includes(d.topic_class)) return fail(res, 403, "topic_not_allowed_for_org", { org_kind: s.creator_org_kind, allowed: rule?.allowed ?? [] });
  const snap = snapshotOf(d, ctxOf(s)), hash = hashOf(snap);
  runInStore("survey", () => {
    db().prepare("DELETE FROM survey_options WHERE question_id IN (SELECT id FROM survey_questions WHERE survey_id = ?)").run(s.id);
    db().prepare("DELETE FROM survey_questions WHERE survey_id = ?").run(s.id);
    writeQuestions(s.id, d.questions);
    db().prepare(`UPDATE surveys SET topic_class = ?, election_choice = ?, title_en = ?, title_te = ?, scope_state = ?, scope_units = ?, opens_at = ?, closes_at = ?, version = version + 1, wording_hash = ? WHERE id = ?`)
      .run(d.topic_class, d.election_choice ? 1 : 0, d.title_en, d.title_te, d.scope.state, JSON.stringify(d.scope.units), d.opens_at, d.closes_at, hash, s.id);
    audit(me, "survey.update", "survey:" + s.id, { version: s.version + 1 });
  });
  res.json({ id: s.id, status: "draft", version: s.version + 1, wording_hash: hash, election_choice: d.election_choice, findings: checkWording(d.title_en, d.title_te, d.questions), ...disclaimer() });
}));

// ---- submit / panel ---------------------------------------------------------------------------

registryRouter.post("/:id/submit", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const s = ownSurvey(req, res); if (!s) return;
  if (s.status !== "draft") return fail(res, 409, "not_draft", { status: s.status });
  const d = draftOf(s);
  const L = surveyPolicy().limits;
  if (L.require_telugu_at_submit && (!s.title_te || d.questions.some((q) => !q.text_te || q.options.some((o) => !o.label_te)))) return fail(res, 400, "telugu_required");
  if (Date.parse(s.closes_at) <= now.getTime()) return fail(res, 400, "closes_in_past");
  const findings: Finding[] = checkWording(s.title_en, s.title_te, d.questions);
  const blocking = findings.filter((f) => f.severity === "block");
  if (blocking.length) return fail(res, 400, "wording_check_failed", { findings });
  const missing = missingPreferNot(s.topic_class, !!s.election_choice, d.questions);
  if (missing.length) return fail(res, 400, "prefer_not_required", { questions: missing });
  if (s.election_choice) { const g = electionGate(s.scope_state, now); if (g.ok === false) return electionDenied(res, g.reason); }
  const key = quotaKey(s.creator_org_kind, s.creator_org_code, s.department, s.creator_pseudonym);
  const first = !hasConsumed(s.id);
  if (first) {
    const q = quotaStatus(s.creator_org_kind, key, s.topic_class, now);
    if (!q.allowed) return fail(res, q.reason === "topic_not_allowed_for_org" ? 403 : 429, q.reason ?? "quota_exceeded", { limit: q.limit, used: q.used, resets_at: q.resets_at, window_days: surveyPolicy().quota.window_days });
  }
  const snap = snapshotOf(d, ctxOf(s));
  const wordingJson = canonicalJson(snap);
  runInStore("survey", () => {
    db().prepare("INSERT OR IGNORE INTO survey_versions (survey_id, version, wording_json, wording_hash, registered_at) VALUES (?,?,?,?,?)").run(s.id, s.version, wordingJson, s.wording_hash, iso(now));
    db().prepare("UPDATE surveys SET status = 'in_review', registered_at = COALESCE(registered_at, ?) WHERE id = ?").run(iso(now), s.id);
    if (first) consumeQuota(s.id, s.creator_org_kind, key, s.topic_class, now);
    logEvent(s.id, first ? "registered" : "resubmitted", { version: s.version, wording_hash: s.wording_hash, org_kind: s.creator_org_kind, org_code: s.creator_org_code, topic_class: s.topic_class }, now);
    audit(me, "survey.submit", "survey:" + s.id, { version: s.version, wording_hash: s.wording_hash, quota_consumed: first });
  });
  res.json({ id: s.id, status: "in_review", version: s.version, wording_hash: s.wording_hash, warnings: findings, ...disclaimer() });
}));

registryRouter.post("/:id/panel/review", requireRole("admin", "survey_panel"), wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const s = UUID.test(req.params.id) ? getSurvey(req.params.id) : undefined;
  if (!s || s.status === "draft") return fail(res, 404, "not_found");
  if (s.status !== "in_review") return fail(res, 409, "not_in_review", { status: s.status });
  const decision = str(req.body?.decision);
  const notes = str(req.body?.notes).trim().slice(0, 1000);
  if (decision !== "approve" && decision !== "reject") return fail(res, 400, "decision_invalid");
  if (decision === "reject" && notes.length < surveyPolicy().panel.min_reject_note_chars) return fail(res, 400, "rejection_needs_notes", { min_chars: surveyPolicy().panel.min_reject_note_chars });
  const rp = surveyActorPseudonym(me);
  const conflict = reviewerConflict(me, rp, s.creator_pseudonym, s.creator_org_kind, s.creator_org_code, s.department);
  if (conflict) { audit(me, "survey.panel.conflict_refused", "survey:" + s.id, { reason: conflict }); return fail(res, 403, "reviewer_conflict", { reason: conflict }); }
  if (db().prepare("SELECT 1 AS x FROM panel_reviews WHERE survey_id = ? AND wording_hash = ? AND reviewer_pseudonym = ?").get(s.id, s.wording_hash, rp)) return fail(res, 409, "already_reviewed");
  let next: SurveyStatus = "in_review";
  runInStore("survey", () => {
    db().prepare("INSERT INTO panel_reviews (id, survey_id, version, wording_hash, reviewer_pseudonym, decision, notes, at) VALUES (?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), s.id, s.version, s.wording_hash, rp, decision, notes || null, iso(now));
    logEvent(s.id, "panel_decision", { decision, version: s.version }, now);
    audit(me, "survey.panel.review", "survey:" + s.id, { decision, version: s.version });
    if (decision === "reject") {
      db().prepare("UPDATE surveys SET status = 'draft' WHERE id = ?").run(s.id);
      logEvent(s.id, "returned", { version: s.version, notes }, now);
      audit(me, "survey.return", "survey:" + s.id, { version: s.version });
      next = "draft";
    } else {
      const n = (db().prepare("SELECT COUNT(DISTINCT reviewer_pseudonym) AS c FROM panel_reviews WHERE survey_id = ? AND wording_hash = ? AND decision = 'approve'").get(s.id, s.wording_hash) as { c: number }).c;
      if (n >= surveyPolicy().panel.min_approvals) {
        db().prepare("UPDATE surveys SET status = 'approved', approved_at = ? WHERE id = ?").run(iso(now), s.id);
        logEvent(s.id, "approved", { version: s.version, wording_hash: s.wording_hash, approvals: n }, now);
        audit("system", "survey.approve", "survey:" + s.id, { version: s.version, approvals: n });
        next = "approved";
      }
    }
  });
  res.json({ id: s.id, status: next, panel: panelSummary({ ...s, status: next }) });
}));

// ---- lifecycle --------------------------------------------------------------------------------

registryRouter.post("/:id/open", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const s = ownSurvey(req, res); if (!s) return;
  if (s.status !== "approved") return fail(res, 409, "not_approved", { status: s.status });
  if (now.getTime() < Date.parse(s.opens_at)) return fail(res, 409, "not_yet_open", { opens_at: s.opens_at });
  if (now.getTime() >= Date.parse(s.closes_at)) return fail(res, 409, "window_closed", { closes_at: s.closes_at });
  if (s.election_choice) { const g = electionGate(s.scope_state, now); if (g.ok === false) return electionDenied(res, g.reason); }
  runInStore("survey", () => {
    db().prepare("UPDATE surveys SET status = 'open', opened_at = ? WHERE id = ?").run(iso(now), s.id);
    logEvent(s.id, "opened", { closes_at: s.closes_at }, now);
    audit(me, "survey.open", "survey:" + s.id, {});
  });
  res.json({ id: s.id, status: "open", opened_at: iso(now), closes_at: s.closes_at, ...disclaimer() });
}));

registryRouter.post("/:id/cancel", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const s = ownSurvey(req, res, { allowAdmin: true }); if (!s) return;
  const P = surveyPolicy().cancellation;
  const code = str(req.body?.reason_code), text = str(req.body?.reason_text).trim();
  if (!P.reason_codes.includes(code)) return fail(res, 400, "reason_required", { reason_codes: P.reason_codes });
  if (text.length < P.min_reason_text_chars || text.length > P.max_reason_text_chars) return fail(res, 400, "reason_required", { min_chars: P.min_reason_text_chars, max_chars: P.max_reason_text_chars });
  if (s.status === "draft") return fail(res, 409, "draft_not_registered", { hint: "drafts are not public; edit or leave it" });
  if (s.status === "closed" || s.status === "cancelled") return fail(res, 409, "already_final", { status: s.status });
  runInStore("survey", () => {
    db().prepare("INSERT INTO cancellations (id, survey_id, reason_code, reason_text, actor_pseudonym, at) VALUES (?,?,?,?,?,?)").run(crypto.randomUUID(), s.id, code, text, surveyActorPseudonym(me), iso(now));
    db().prepare("UPDATE surveys SET status = 'cancelled', closed_at = ?, close_reason = ? WHERE id = ?").run(iso(now), code, s.id);
    logEvent(s.id, "cancelled", { reason_code: code, reason_text: text, previous_status: s.status }, now);
    audit(me, "survey.cancel", "survey:" + s.id, { reason_code: code, previous_status: s.status });
  });
  res.json({ id: s.id, status: "cancelled", cancellation: { reason_code: code, reason_text: text, at: iso(now) }, ...disclaimer() });
}));

registryRouter.post("/:id/close", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const s = ownSurvey(req, res, { allowAdmin: true }); if (!s) return;
  if (s.status !== "open") return fail(res, 409, "not_open", { status: s.status });
  runInStore("survey", () => {
    db().prepare("UPDATE surveys SET status = 'closed', closed_at = ?, close_reason = 'manual' WHERE id = ?").run(iso(now), s.id);
    logEvent(s.id, "closed", { reason: "manual" }, now);
    audit(me, "survey.close", "survey:" + s.id, {});
  });
  res.json({ id: s.id, status: "closed", closed_at: iso(now), ...disclaimer() });
}));

// ---------------------------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------------------------

/** Closes open surveys at closes_at; approved or in-review surveys whose window passed unopened are closed as expired. Idempotent. */
export function closeDueSurveys(now: Date = new Date()): { closed: number; expired: number } {
  const due = db().prepare("SELECT id, status FROM surveys WHERE status IN ('open','approved','in_review') AND closes_at <= ?").all(iso(now)) as unknown as { id: string; status: SurveyStatus }[];
  let closed = 0, expired = 0;
  for (const s of due) {
    runInStore("survey", () => {
      const reason = s.status === "open" ? "closes_at" : "expired_unopened";
      db().prepare("UPDATE surveys SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ? AND status = ?").run(iso(now), reason, s.id, s.status);
      logEvent(s.id, "closed", { reason }, now);
      audit("system", "survey.auto_close", "survey:" + s.id, { reason });
    });
    if (s.status === "open") closed++; else expired++;
  }
  return { closed, expired };
}

export { ORG_KINDS, asksPartyPreference };

// Seam for the credential / response module (./source): the registry is its default survey lookup. Fail closed: while the election gate
// is shut, an election-choice survey is reported with status "election_window_hold" so it cannot be answered.
registerRegistryLookup((id) => {
  const s = UUID.test(id) ? getSurvey(id) : undefined;
  if (!s || !s.registered_at || s.status === "draft") return null;
  const held = s.election_choice && !electionChoiceAllowed(s.scope_state, registryNow());
  return {
    id: s.id, status: held ? "election_window_hold" : s.status, topic_class: s.topic_class,
    scope: { state: s.scope_state, units: JSON.parse(s.scope_units) as ScopeUnits }, opens_at: s.opens_at, closes_at: s.closes_at, wording_hash: s.wording_hash,
    questions: loadQuestions(s.id).map((q) => ({ id: q.id, kind: q.kind, max_select: q.max_select, options: q.options.filter((o) => q.kind !== "scale5" || o.prefer_not).map((o) => o.id) })),
  };
});
