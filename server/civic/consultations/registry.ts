/**
 * Consultation registry (S-35 / E2E-44; DESIGN_2028 3.6). Routes are assembled in ./index (mounted at /api/v1/civic/consultations).
 *
 * Lifecycle: draft -> in_review (public from here) -> approved (two panel approvals on the content hash) -> open (publish) -> closed
 * -> completed (only with a published closing report). Content (clauses, EN/TE plain-language summaries, audio metadata) is frozen
 * once submitted; a correction is a new version (sha256 of canonical JSON) that needs the same panel approvals and writes a public
 * change log entry. Anyone may READ without login.
 */
import crypto from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import express from "express";
import { audit, canonicalJson, hasRole, listRolesDetailed, requireAuth, requireRole, runInStore } from "../core";
import { rateAllow } from "../identity/service";
import { checkWording, reviewerConflict } from "../surveys/panel";
import { SCOPE_UNIT_KEYS, registryNow } from "../surveys/types";
import type { Scope, ScopeUnits } from "../surveys/types";
import { cdb } from "./schema";
import {
  UUID, cfg, consultActor, consultationPolicy, disclaimer, fail, hashContent, iso, lim, str, trim, wrap,
} from "./types";
import type { AudioRef, ClauseContent, ConsultationContent, ConsultationRow } from "./types";

export const getConsultation = (id: string): ConsultationRow | undefined =>
  UUID.test(id) ? (cdb().prepare("SELECT * FROM consultations WHERE id = ?").get(id) as unknown as ConsultationRow | undefined) : undefined;

export function logEvent(id: string, kind: string, detail: Record<string, unknown>, at: Date): void {
  cdb().prepare("INSERT INTO consultation_log (consultation_id, kind, at, detail) VALUES (?,?,?,?)").run(id, kind, iso(at), canonicalJson(detail));
}

/** The content of the CURRENT public version (the draft while unregistered). */
export function currentContent(c: ConsultationRow): ConsultationContent {
  if (!c.registered_at) return JSON.parse(c.draft_json) as ConsultationContent;
  const v = cdb().prepare("SELECT content_json FROM consultation_versions WHERE consultation_id = ? AND version = ?").get(c.id, c.version) as { content_json: string } | undefined;
  return JSON.parse(v ? v.content_json : c.draft_json) as ConsultationContent;
}

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

/** The department a person may act for: an officer's own department; an admin names one. */
export function officerDepartment(personId: string): string | null {
  const r = listRolesDetailed(personId).find((x) => x.role === "officer" && x.department);
  return r ? r.department!.slice(0, 64) : null;
}
const sameDept = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Staff role of a person for one consultation: admin, officer of the department, moderator, survey_panel. */
export function staffRole(personId: string, c: ConsultationRow): "admin" | "officer" | "moderator" | "panel" | null {
  if (hasRole(personId, "admin")) return "admin";
  const d = officerDepartment(personId);
  if (d && sameDept(d, c.department) && hasRole(personId, "officer")) return "officer";
  if (hasRole(personId, "moderator")) return "moderator";
  if (hasRole(personId, "survey_panel")) return "panel";
  return null;
}
/** May this person act as the owning department (creator, or an officer of that department, or an admin)? */
export const isOwner = (personId: string, c: ConsultationRow): boolean => {
  const r = staffRole(personId, c);
  return r === "admin" || r === "officer" || c.creator_pseudonym === consultActor(personId);
};

// ---------------------------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------------------------

type Bad = { status: 400; code: string; extra?: Record<string, unknown> };
const bad = (code: string, extra?: Record<string, unknown>): Bad => ({ status: 400, code, extra });
export const isBad = (x: unknown): x is Bad => !!x && typeof x === "object" && (x as Bad).status === 400 && "code" in (x as object);

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
  if (total > 200) return bad("scope_too_large");
  return { state, units };
}

/** True when the URL is an https link on an official (government) domain. */
export function officialUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    return consultationPolicy().official_domain_suffixes.some((s) => h === s || h.endsWith("." + s));
  } catch { return false; }
}

function parseAudio(v: unknown, groups: string[], clause: number): AudioRef[] | Bad {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad("audio_invalid", { clause });
  const out: AudioRef[] = [];
  for (const a of v) {
    const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const group = trim(o.group, lim("max_group_chars"));
    if (!groups.includes(group)) return bad("audio_group_unknown", { clause, group });
    const status = str(o.status) || "placeholder";
    if (status === "reviewed") return bad("audio_review_is_a_human_step", { clause, hint: "a recording is marked reviewed only by a panel reviewer, never by input" });
    if (status !== "placeholder" && status !== "recorded") return bad("audio_status_invalid", { clause });
    const file_id = o.file_id === null || o.file_id === undefined || o.file_id === "" ? null : str(o.file_id);
    if (file_id !== null && !/^[A-Za-z0-9_.-]{1,80}$/.test(file_id)) return bad("audio_file_invalid", { clause });
    if (status === "recorded" && !file_id) return bad("audio_file_required", { clause });
    const d = Number(o.duration_s);
    if (!Number.isFinite(d) || d <= 0 || d > lim("max_audio_seconds")) return bad("audio_duration_invalid", { clause, max_seconds: lim("max_audio_seconds") });
    if (out.some((x) => x.group === group)) return bad("audio_group_duplicate", { clause, group });
    out.push({ group, file_id, duration_s: Math.round(d * 10) / 10, status });
  }
  return out;
}

/**
 * Parse a content document. `strict` (submit) also requires both summaries on every clause and Telugu text; a draft may be partial
 * but every supplied value is still checked.
 */
export function parseContent(body: Record<string, unknown>, department: string, strict: boolean, now: Date): ConsultationContent | Bad {
  const title_en = trim(body.title_en, lim("max_title_chars") + 1);
  if (title_en.length < 3 || title_en.length > lim("max_title_chars")) return bad("title_invalid");
  const title_te = trim(body.title_te, lim("max_title_chars") + 1) || null;
  if (title_te && title_te.length > lim("max_title_chars")) return bad("title_invalid");
  if (strict && lim("require_telugu_at_submit") && !title_te) return bad("telugu_required", { where: "title" });
  const bill_ref = trim(body.bill_ref, lim("max_bill_ref_chars") + 1);
  if (bill_ref.length < 3 || bill_ref.length > lim("max_bill_ref_chars")) return bad("bill_ref_invalid");
  const source_url = str(body.source_url).trim();
  if (!officialUrl(source_url)) return bad("source_url_not_official", { allowed_suffixes: consultationPolicy().official_domain_suffixes });
  const scope = parseScope(body.scope);
  if (isBad(scope)) return scope;
  const opens_at = parseIso(body.opens_at), closes_at = parseIso(body.closes_at);
  if (!opens_at || !closes_at || Date.parse(closes_at) <= Date.parse(opens_at)) return bad("window_invalid");
  if (Date.parse(closes_at) <= now.getTime()) return bad("closes_in_past");
  if (Date.parse(closes_at) - Date.parse(opens_at) > lim("max_duration_days") * 86_400_000) return bad("window_too_long", { max_days: lim("max_duration_days") });
  const rawGroups = Array.isArray(body.affected_groups) ? body.affected_groups : [];
  const affected_groups = [...new Set(rawGroups.map((g) => trim(g, lim("max_group_chars") + 1).toLowerCase()))].filter(Boolean);
  if (!affected_groups.length || affected_groups.length > lim("max_groups") || affected_groups.some((g) => g.length > lim("max_group_chars"))) return bad("affected_groups_invalid", { max: lim("max_groups") });
  const rc = body.clauses;
  if (!Array.isArray(rc) || rc.length < 1) return bad("clauses_required");
  if (rc.length > lim("max_clauses")) return bad("too_many_clauses", { max: lim("max_clauses") });
  const clauses: ClauseContent[] = [];
  for (let i = 0; i < rc.length; i++) {
    const c = (rc[i] && typeof rc[i] === "object" ? rc[i] : {}) as Record<string, unknown>;
    const n = i + 1;
    if (c.n !== undefined && Number(c.n) !== n) return bad("clause_numbering", { expected: n });
    const original_text = str(c.original_text).trim().slice(0, lim("max_original_chars") + 1) || null;
    const original_ref = trim(c.original_ref, lim("max_ref_chars") + 1) || null;
    if ((original_text && original_text.length > lim("max_original_chars")) || (original_ref && original_ref.length > lim("max_ref_chars"))) return bad("clause_text_invalid", { clause: n });
    if (strict && !original_text && !original_ref) return bad("clause_original_required", { clause: n });
    const summary_en = trim(c.summary_en, lim("max_summary_chars") + 1), summary_te = trim(c.summary_te, lim("max_summary_chars") + 1);
    if (summary_en.length > lim("max_summary_chars") || summary_te.length > lim("max_summary_chars")) return bad("summary_invalid", { clause: n });
    if (strict && (summary_en.length < lim("min_summary_chars") || summary_te.length < lim("min_summary_chars"))) return bad("summaries_required", { clause: n, hint: "both EN and TE plain-language summaries are required" });
    const audio = parseAudio(c.audio, affected_groups, n);
    if (isBad(audio)) return audio;
    clauses.push({ n, original_text, original_ref, summary_en, summary_te, audio });
  }
  return { title_en, title_te, department, bill_ref, source_url, scope, opens_at, closes_at, affected_groups, clauses };
}

/** Machine wording checks (banned framing, leading words) on the title and every plain-language summary. */
export function contentFindings(c: ConsultationContent) {
  const out = checkWording(c.title_en, c.title_te, []);
  for (const cl of c.clauses) {
    out.push(...checkWording(cl.summary_en, cl.summary_te || null, []).map((f) => ({ ...f, where: `clause${cl.n}.${f.where === "title_te" ? "summary_te" : "summary_en"}` })));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public payloads
// ---------------------------------------------------------------------------------------------

export const reportRow = (id: string) => cdb().prepare("SELECT snapshot_json, snapshot_hash, published_at FROM consultation_reports WHERE consultation_id = ?").get(id) as
  { snapshot_json: string; snapshot_hash: string; published_at: string } | undefined;

export function reportState(c: ConsultationRow, now: Date) {
  const published = !!reportRow(c.id);
  const closed = c.status === "closed" || c.status === "completed";
  const due = closed && c.closed_at && c.close_reason !== "expired_unopened" ? new Date(Date.parse(c.closes_at) + cfg.reportDueDays() * 86_400_000).toISOString() : null;
  return {
    status: published ? "published" : closed ? "pending" : "not_due",
    due_at: due,
    overdue: !!due && !published && now.getTime() > Date.parse(due),
  };
}

function summary(c: ConsultationRow, now: Date) {
  return {
    id: c.id, status: c.status, department: c.department, title_en: c.title_en, title_te: c.title_te, bill_ref: c.bill_ref, source_url: c.source_url,
    scope: { state: c.scope_state, units: JSON.parse(c.scope_units) as ScopeUnits }, opens_at: c.opens_at, closes_at: c.closes_at,
    registered_at: c.registered_at, approved_at: c.approved_at, published_at: c.published_at, closed_at: c.closed_at, completed_at: c.completed_at,
    version: c.version, content_hash: c.content_hash, closing_report: reportState(c, now), ...disclaimer(),
  };
}

/** A registry list item: the summary plus what a card shows (affected groups, clause count) so no per-card detail fetch is needed. */
function listItem(c: ConsultationRow, now: Date) {
  const content = currentContent(c);
  return { ...summary(c, now), affected_groups: content.affected_groups, clause_count: content.clauses.length };
}

/** Audio status as the public sees it: a human review row turns "recorded" into "reviewed"; nothing else ever does. */
function clausePublic(c: ConsultationRow, cl: ClauseContent) {
  const reviewed = new Set((cdb().prepare("SELECT group_key, file_id FROM consultation_audio_reviews WHERE consultation_id = ? AND clause_n = ?").all(c.id, cl.n) as { group_key: string; file_id: string }[]).map((r) => r.group_key + "|" + r.file_id));
  return {
    n: cl.n, original_text: cl.original_text, original_ref: cl.original_ref, summary_en: cl.summary_en, summary_te: cl.summary_te,
    audio: cl.audio.map((a) => ({ ...a, status: a.status === "recorded" && a.file_id && reviewed.has(a.group + "|" + a.file_id) ? "reviewed" : a.status })),
  };
}

export function panelSummary(c: ConsultationRow, hash = c.content_hash) {
  const rows = cdb().prepare("SELECT version, content_hash, decision, notes, at FROM consultation_panel_reviews WHERE consultation_id = ? ORDER BY at, rowid").all(c.id) as unknown as
    { version: number; content_hash: string; decision: "approve" | "reject"; notes: string | null; at: string }[];
  const cur = rows.filter((r) => r.content_hash === hash);
  return {
    required_approvals: consultationPolicy().panel.min_approvals,
    approvals: cur.filter((r) => r.decision === "approve").length, rejections: cur.filter((r) => r.decision === "reject").length,
    decisions: rows.map((r) => ({ version: r.version, content_hash: r.content_hash, decision: r.decision, notes: r.notes, at: r.at, current: r.content_hash === hash })),
  };
}

function detail(c: ConsultationRow, now: Date) {
  const content = currentContent(c);
  const versions = cdb().prepare("SELECT version, content_hash, note_en, note_te, created_at FROM consultation_versions WHERE consultation_id = ? ORDER BY version").all(c.id);
  return {
    ...summary(c, now), affected_groups: content.affected_groups, clauses: content.clauses.map((cl) => clausePublic(c, cl)), versions, panel: panelSummary(c),
    stances: consultationPolicy().stances,
  };
}

const pubLimit = (name: string, limit: number) => (req: Request, res: Response, next: express.NextFunction): void => {
  if (!rateAllow(`consultpub:${name}:${req.ip || "?"}`, limit, 60 * 1000)) return void fail(res, 429, "too_many_requests");
  next();
};
const cacheShort = (res: Response) => res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
const enc = (a: string, b: string) => Buffer.from(`${a}|${b}`).toString("base64url");
const dec = (c: string): [string, string] | null => { try { const [a, b] = Buffer.from(c, "base64url").toString().split("|"); return a && b ? [a, b] : null; } catch { return null; } };

export const visible = (c: ConsultationRow | undefined): c is ConsultationRow => !!c && c.status !== "draft" && !!c.registered_at;

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export const registryRouter = Router();
registryRouter.use(express.json({ limit: "512kb" }));
const CREATORS = requireRole("officer", "admin");

registryRouter.get("/", pubLimit("list", 120), wrap((req, res) => {
  const now = registryNow();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 20));
  const status = str(req.query.status), dept = str(req.query.department).trim(), q = str(req.query.q).trim().slice(0, 100);
  const state = str(req.query.state).trim().toUpperCase();
  if (state && !/^[A-Z]{2,3}$/.test(state)) return fail(res, 400, "state_invalid");
  const overdueOnly = req.query.overdue === "1";
  const cur = req.query.cursor ? dec(str(req.query.cursor)) : null;
  if (req.query.cursor && !cur) return fail(res, 400, "cursor_invalid");
  const where = ["status <> 'draft'", "registered_at IS NOT NULL"];
  const args: (string | number)[] = [];
  if (status) { where.push("status = ?"); args.push(status); }
  if (dept) { where.push("lower(department) = lower(?)"); args.push(dept); }
  if (state) { where.push("scope_state = ?"); args.push(state); }
  if (q) { const like = "%" + q.replace(/[!%_]/g, "!$&") + "%"; where.push("(title_en LIKE ? ESCAPE '!' OR title_te LIKE ? ESCAPE '!' OR bill_ref LIKE ? ESCAPE '!')"); args.push(like, like, like); }
  if (cur) { where.push("(registered_at < ? OR (registered_at = ? AND id < ?))"); args.push(cur[0], cur[0], cur[1]); }
  const rows = cdb().prepare(`SELECT * FROM consultations WHERE ${where.join(" AND ")} ORDER BY registered_at DESC, id DESC LIMIT 500`).all(...args) as unknown as ConsultationRow[];
  const out: ReturnType<typeof listItem>[] = [];
  let next: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const s = listItem(rows[i], now);
    if (overdueOnly && !s.closing_report.overdue) continue;
    out.push(s);
    if (out.length >= limit) { if (i < rows.length - 1) next = enc(rows[i].registered_at!, rows[i].id); break; }
  }
  cacheShort(res);
  res.json({ consultations: out, next_cursor: next, ...disclaimer() });
}));

registryRouter.get("/mine", CREATORS, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const dept = officerDepartment(me);
  const rows = (hasRole(me, "admin")
    ? cdb().prepare("SELECT * FROM consultations ORDER BY created_at DESC LIMIT 200").all()
    : cdb().prepare("SELECT * FROM consultations WHERE creator_pseudonym = ? OR lower(department) = lower(?) ORDER BY created_at DESC LIMIT 200").all(consultActor(me), dept ?? "")) as unknown as ConsultationRow[];
  res.json({ consultations: rows.map((c) => ({ ...detail(c, now), findings: c.status === "draft" ? contentFindings(currentContent(c)) : [] })), ...disclaimer() });
}));

registryRouter.get("/:id", pubLimit("get", 240), wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  cacheShort(res);
  res.json(detail(c, registryNow()));
}));

registryRouter.get("/:id/clauses/:n", pubLimit("clause", 240), wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const cl = currentContent(c).clauses.find((x) => x.n === Number(req.params.n));
  if (!cl) return fail(res, 404, "clause_not_found");
  cacheShort(res);
  res.json({ consultation_id: c.id, version: c.version, content_hash: c.content_hash, clause: clausePublic(c, cl), stances: consultationPolicy().stances, ...disclaimer() });
}));

registryRouter.get("/:id/versions/:n", pubLimit("ver", 240), wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const v = cdb().prepare("SELECT version, content_json, content_hash, note_en, note_te, created_at FROM consultation_versions WHERE consultation_id = ? AND version = ?").get(c.id, Number(req.params.n)) as unknown as
    { version: number; content_json: string; content_hash: string; note_en: string | null; note_te: string | null; created_at: string } | undefined;
  if (!v) return fail(res, 404, "not_found");
  res.json({ version: v.version, content_hash: v.content_hash, created_at: v.created_at, note_en: v.note_en, note_te: v.note_te, content: JSON.parse(v.content_json), hash_algorithm: "sha256(canonical JSON of content)" });
}));

registryRouter.get("/:id/log", pubLimit("log", 120), wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const after = Math.max(0, Math.floor(Number(req.query.after)) || 0);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 100));
  const rows = cdb().prepare("SELECT seq, kind, at, detail FROM consultation_log WHERE consultation_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(c.id, after, limit) as unknown as { seq: number; kind: string; at: string; detail: string }[];
  cacheShort(res);
  res.json({ entries: rows.map((r) => ({ seq: r.seq, kind: r.kind, at: r.at, detail: JSON.parse(r.detail) })), next_after: rows.length === limit ? rows[rows.length - 1].seq : null });
}));

// ---- create / edit / submit ---------------------------------------------------------------------

function resolveDepartment(personId: string, body: Record<string, unknown>): { ok: true; dept: string } | { ok: false; status: number; code: string } {
  const own = officerDepartment(personId);
  if (hasRole(personId, "officer") && own) return { ok: true, dept: own };
  if (hasRole(personId, "admin")) {
    const d = trim(body.department, 64);
    return d.length >= 2 ? { ok: true, dept: d } : { ok: false, status: 400, code: "department_required" };
  }
  return { ok: false, status: 403, code: "department_required" };
}

function ownDraft(req: Request, res: Response): ConsultationRow | null {
  const c = getConsultation(req.params.id);
  if (!c) { fail(res, 404, "not_found"); return null; }
  const me = req.person!.id;
  if (!isOwner(me, c)) {
    fail(res, c.status === "draft" ? 404 : 403, c.status === "draft" ? "not_found" : "owner_only"); return null;
  }
  return c;
}

registryRouter.post("/", CREATORS, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const d = resolveDepartment(me, body);
  if (d.ok === false) return fail(res, d.status, d.code);
  const content = parseContent(body, d.dept, false, now);
  if (isBad(content)) return fail(res, content.status, content.code, content.extra);
  const id = crypto.randomUUID(), hash = hashContent(content);
  runInStore("survey", () => {
    cdb().prepare(`INSERT INTO consultations (id, creator_pseudonym, department, title_en, title_te, bill_ref, source_url, status, scope_state, scope_units, opens_at, closes_at, version, content_hash, draft_json, created_at)
                   VALUES (?,?,?,?,?,?,?, 'draft', ?,?,?,?,1,?,?,?)`)
      .run(id, consultActor(me), d.dept, content.title_en, content.title_te, content.bill_ref, content.source_url, content.scope.state, JSON.stringify(content.scope.units), content.opens_at, content.closes_at, hash, canonicalJson(content), iso(now));
    audit(me, "consultation.create", "consultation:" + id, { department: d.dept });
  });
  res.status(201).json({ id, status: "draft", version: 1, content_hash: hash, department: d.dept, findings: contentFindings(content), ...disclaimer() });
}));

registryRouter.patch("/:id", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = ownDraft(req, res); if (!c) return;
  if (c.status !== "draft") return fail(res, 409, "content_frozen", { status: c.status, hint: "after submission a change is a correction: POST /:id/corrections" });
  const cur = JSON.parse(c.draft_json) as ConsultationContent;
  const body = { ...cur, ...((req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>) };
  const content = parseContent(body, c.department, false, now);
  if (isBad(content)) return fail(res, content.status, content.code, content.extra);
  const hash = hashContent(content);
  runInStore("survey", () => {
    cdb().prepare(`UPDATE consultations SET title_en = ?, title_te = ?, bill_ref = ?, source_url = ?, scope_state = ?, scope_units = ?, opens_at = ?, closes_at = ?, version = version + 1, content_hash = ?, draft_json = ? WHERE id = ?`)
      .run(content.title_en, content.title_te, content.bill_ref, content.source_url, content.scope.state, JSON.stringify(content.scope.units), content.opens_at, content.closes_at, hash, canonicalJson(content), c.id);
    audit(me, "consultation.update", "consultation:" + c.id, { version: c.version + 1 });
  });
  res.json({ id: c.id, status: "draft", version: c.version + 1, content_hash: hash, findings: contentFindings(content), ...disclaimer() });
}));

registryRouter.post("/:id/submit", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = ownDraft(req, res); if (!c) return;
  if (c.status !== "draft") return fail(res, 409, "not_draft", { status: c.status });
  const content = parseContent(JSON.parse(c.draft_json) as Record<string, unknown>, c.department, true, now);
  if (isBad(content)) return fail(res, content.status, content.code, content.extra);
  const findings = contentFindings(content);
  if (findings.some((f) => f.severity === "block")) return fail(res, 400, "wording_check_failed", { findings });
  const json = canonicalJson(content), hash = hashContent(content);
  runInStore("survey", () => {
    cdb().prepare("INSERT OR IGNORE INTO consultation_versions (consultation_id, version, content_json, content_hash, created_at) VALUES (?,?,?,?,?)").run(c.id, c.version, json, hash, iso(now));
    cdb().prepare("UPDATE consultations SET status = 'in_review', registered_at = COALESCE(registered_at, ?), content_hash = ? WHERE id = ?").run(iso(now), hash, c.id);
    logEvent(c.id, c.registered_at ? "resubmitted" : "registered", { version: c.version, content_hash: hash, department: c.department, bill_ref: content.bill_ref }, now);
    audit(me, "consultation.submit", "consultation:" + c.id, { version: c.version, content_hash: hash });
  });
  res.json({ id: c.id, status: "in_review", version: c.version, content_hash: hash, warnings: findings, ...disclaimer() });
}));

// ---- panel ----------------------------------------------------------------------------------------

function applyCorrection(c: ConsultationRow, corr: { id: string; to_version: number; content_json: string; content_hash: string; reason_en: string; reason_te: string | null }, now: Date): void {
  cdb().prepare("INSERT INTO consultation_versions (consultation_id, version, content_json, content_hash, note_en, note_te, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(c.id, corr.to_version, corr.content_json, corr.content_hash, corr.reason_en, corr.reason_te, iso(now));
  cdb().prepare("UPDATE consultations SET version = ?, content_hash = ? WHERE id = ?").run(corr.to_version, corr.content_hash, c.id);
  cdb().prepare("UPDATE consultation_corrections SET status = 'applied', decided_at = ? WHERE id = ?").run(iso(now), corr.id);
  logEvent(c.id, "corrected", { version: corr.to_version, content_hash: corr.content_hash, reason_en: corr.reason_en, reason_te: corr.reason_te }, now);
}

registryRouter.post("/:id/panel/review", requireRole("admin", "survey_panel"), wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const decision = str(req.body?.decision), notes = str(req.body?.notes).trim().slice(0, 1000);
  if (decision !== "approve" && decision !== "reject") return fail(res, 400, "decision_invalid");
  if (decision === "reject" && notes.length < consultationPolicy().panel.min_reject_note_chars) return fail(res, 400, "rejection_needs_notes", { min_chars: consultationPolicy().panel.min_reject_note_chars });
  // target: the registered content (in_review) or a pending correction
  const corrId = str(req.body?.correction_id);
  let target = { version: c.version, hash: c.content_hash };
  let corr: { id: string; to_version: number; content_json: string; content_hash: string; reason_en: string; reason_te: string | null; status: string } | undefined;
  if (corrId) {
    corr = cdb().prepare("SELECT id, to_version, content_json, content_hash, reason_en, reason_te, status FROM consultation_corrections WHERE id = ? AND consultation_id = ?").get(corrId, c.id) as typeof corr;
    if (!corr) return fail(res, 404, "correction_not_found");
    if (corr.status !== "pending") return fail(res, 409, "correction_not_pending", { status: corr.status });
    target = { version: corr.to_version, hash: corr.content_hash };
  } else if (c.status !== "in_review") return fail(res, 409, "not_in_review", { status: c.status });
  const rp = consultActor(me);
  const conflict = reviewerConflict(me, rp, c.creator_pseudonym, "government", null, c.department);
  if (conflict) { audit(me, "consultation.panel.conflict_refused", "consultation:" + c.id, { reason: conflict }); return fail(res, 403, "reviewer_conflict", { reason: conflict }); }
  if (cdb().prepare("SELECT 1 AS x FROM consultation_panel_reviews WHERE consultation_id = ? AND content_hash = ? AND reviewer_pseudonym = ?").get(c.id, target.hash, rp)) return fail(res, 409, "already_reviewed");
  let next: string = corr ? "correction_pending" : "in_review";
  runInStore("survey", () => {
    cdb().prepare("INSERT INTO consultation_panel_reviews (id, consultation_id, version, content_hash, reviewer_pseudonym, decision, notes, at) VALUES (?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), c.id, target.version, target.hash, rp, decision, notes || null, iso(now));
    logEvent(c.id, "panel_decision", { decision, version: target.version, correction: !!corr }, now);
    audit(me, "consultation.panel.review", "consultation:" + c.id, { decision, version: target.version });
    if (decision === "reject") {
      if (corr) { cdb().prepare("UPDATE consultation_corrections SET status = 'rejected', decided_at = ? WHERE id = ?").run(iso(now), corr.id); logEvent(c.id, "correction_rejected", { version: target.version, notes }, now); next = "correction_rejected"; }
      else { cdb().prepare("UPDATE consultations SET status = 'draft' WHERE id = ?").run(c.id); logEvent(c.id, "returned", { version: c.version, notes }, now); next = "draft"; }
      return;
    }
    const n = (cdb().prepare("SELECT COUNT(DISTINCT reviewer_pseudonym) AS c FROM consultation_panel_reviews WHERE consultation_id = ? AND content_hash = ? AND decision = 'approve'").get(c.id, target.hash) as { c: number }).c;
    if (n < consultationPolicy().panel.min_approvals) return;
    if (corr) { applyCorrection(c, corr, now); next = "correction_applied"; }
    else { cdb().prepare("UPDATE consultations SET status = 'approved', approved_at = ? WHERE id = ?").run(iso(now), c.id); logEvent(c.id, "approved", { version: c.version, content_hash: c.content_hash, approvals: n }, now); audit("system", "consultation.approve", "consultation:" + c.id, { approvals: n }); next = "approved"; }
  });
  res.json({ id: c.id, result: next, panel: panelSummary(getConsultation(c.id)!, target.hash) });
}));

// ---- publish / close -------------------------------------------------------------------------------

registryRouter.post("/:id/publish", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = ownDraft(req, res); if (!c) return;
  if (c.status !== "approved") return fail(res, 409, "not_approved", { status: c.status });
  if (now.getTime() >= Date.parse(c.closes_at)) return fail(res, 409, "window_closed", { closes_at: c.closes_at });
  runInStore("survey", () => {
    cdb().prepare("UPDATE consultations SET status = 'open', published_at = ? WHERE id = ?").run(iso(now), c.id);
    logEvent(c.id, "published", { opens_at: c.opens_at, closes_at: c.closes_at, version: c.version, content_hash: c.content_hash }, now);
    audit(me, "consultation.publish", "consultation:" + c.id, {});
  });
  res.json({ id: c.id, status: "open", published_at: iso(now), opens_at: c.opens_at, closes_at: c.closes_at, ...disclaimer() });
}));

export function closeConsultation(c: ConsultationRow, reason: string, now: Date, actor = "system"): void {
  runInStore("survey", () => {
    cdb().prepare("UPDATE consultations SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ? AND status IN ('open','approved','in_review')").run(iso(now), reason, c.id);
    logEvent(c.id, "closed", { reason }, now);
    audit(actor, "consultation.close", "consultation:" + c.id, { reason });
  });
}

registryRouter.post("/:id/close", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = ownDraft(req, res); if (!c) return;
  if (c.status !== "open") return fail(res, 409, "not_open", { status: c.status });
  closeConsultation(c, "manual", now, me);
  res.json({ id: c.id, status: "closed", closed_at: iso(now), closing_report: reportState({ ...c, status: "closed", closed_at: iso(now), close_reason: "manual" }, now), ...disclaimer() });
}));

// ---- corrections and audio review ---------------------------------------------------------------------

registryRouter.post("/:id/corrections", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = ownDraft(req, res); if (!c) return;
  if (c.status === "draft" || c.status === "in_review") return fail(res, 409, "not_registered_yet", { hint: "edit the draft or wait for the panel" });
  if (c.status === "completed" || reportRow(c.id)) return fail(res, 409, "consultation_final");
  if (cdb().prepare("SELECT 1 AS x FROM consultation_corrections WHERE consultation_id = ? AND status = 'pending'").get(c.id)) return fail(res, 409, "correction_pending");
  const reason_en = trim(req.body?.reason_en, 500), reason_te = trim(req.body?.reason_te, 500) || null;
  if (reason_en.length < lim("min_reason_chars")) return fail(res, 400, "reason_required", { min_chars: lim("min_reason_chars") });
  const cur = currentContent(c);
  const upd = Array.isArray(req.body?.clauses) ? (req.body.clauses as Record<string, unknown>[]) : [];
  if (!upd.length) return fail(res, 400, "no_changes");
  const merged = JSON.parse(JSON.stringify(cur)) as ConsultationContent;
  for (const u of upd) {
    const cl = merged.clauses.find((x) => x.n === Number(u?.n));
    if (!cl) return fail(res, 400, "clause_not_found", { clause: u?.n });
    for (const k of ["original_text", "original_ref", "summary_en", "summary_te", "audio"] as const) if (u[k] !== undefined) (cl as unknown as Record<string, unknown>)[k] = u[k];
  }
  // re-validate through the same parser (clause set, groups, lengths); corrections keep the registered window and scope
  const parsed = parseContent({ ...merged, opens_at: cur.opens_at, closes_at: new Date(Math.max(Date.parse(cur.closes_at), now.getTime() + 1000)).toISOString() }, c.department, true, new Date(Date.parse(cur.opens_at) - 1));
  if (isBad(parsed)) return fail(res, parsed.status, parsed.code, parsed.extra);
  const content: ConsultationContent = { ...parsed, opens_at: cur.opens_at, closes_at: cur.closes_at };
  const findings = contentFindings(content);
  if (findings.some((f) => f.severity === "block")) return fail(res, 400, "wording_check_failed", { findings });
  const hash = hashContent(content);
  if (hash === c.content_hash) return fail(res, 400, "no_changes");
  const id = crypto.randomUUID();
  runInStore("survey", () => {
    cdb().prepare("INSERT INTO consultation_corrections (id, consultation_id, from_version, to_version, content_json, content_hash, reason_en, reason_te, creator_pseudonym, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, c.id, c.version, c.version + 1, canonicalJson(content), hash, reason_en, reason_te, consultActor(me), iso(now));
    logEvent(c.id, "correction_proposed", { to_version: c.version + 1, content_hash: hash, reason_en, reason_te }, now);
    audit(me, "consultation.correction", "consultation:" + c.id, { to_version: c.version + 1 });
  });
  res.status(201).json({ id, consultation_id: c.id, to_version: c.version + 1, content_hash: hash, status: "pending", hint: "needs the same panel approvals (POST /:id/panel/review with correction_id)", findings });
}));

registryRouter.post("/:id/audio/review", requireRole("admin", "survey_panel"), wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const n = Number(req.body?.clause), group = trim(req.body?.group, lim("max_group_chars"));
  const a = currentContent(c).clauses.find((x) => x.n === n)?.audio.find((x) => x.group === group);
  if (!a) return fail(res, 404, "audio_not_found");
  if (a.status !== "recorded" || !a.file_id) return fail(res, 409, "audio_not_recorded", { hint: "a placeholder has nothing to review; a human recording must exist first" });
  const conflict = reviewerConflict(me, consultActor(me), c.creator_pseudonym, "government", null, c.department);
  if (conflict) return fail(res, 403, "reviewer_conflict", { reason: conflict });
  const r = cdb().prepare("INSERT OR IGNORE INTO consultation_audio_reviews (id, consultation_id, clause_n, group_key, file_id, reviewer_pseudonym, at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), c.id, n, group, a.file_id, consultActor(me), iso(now));
  if (Number(r.changes) > 0) { logEvent(c.id, "audio_reviewed", { clause: n, group, file_id: a.file_id }, now); audit(me, "consultation.audio.review", "consultation:" + c.id, { clause: n, group }); }
  res.json({ ok: true, clause: n, group, status: "reviewed" });
}));

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

/** Closes open consultations at closes_at (unopened ones expire), and flags overdue closing reports once in the public log. Idempotent. */
export function runConsultationJobs(now: Date = new Date()): { closed: number; expired: number; overdue_flagged: number } {
  const due = cdb().prepare("SELECT * FROM consultations WHERE status IN ('open','approved','in_review') AND closes_at <= ?").all(iso(now)) as unknown as ConsultationRow[];
  let closed = 0, expired = 0;
  for (const c of due) { closeConsultation(c, c.status === "open" ? "closes_at" : "expired_unopened", now); if (c.status === "open") closed++; else expired++; }
  let overdue_flagged = 0;
  const pending = cdb().prepare("SELECT * FROM consultations WHERE status = 'closed' AND close_reason <> 'expired_unopened'").all() as unknown as ConsultationRow[];
  for (const c of pending) {
    const st = reportState(c, now);
    if (!st.overdue || cdb().prepare("SELECT 1 AS x FROM consultation_log WHERE consultation_id = ? AND kind = 'report_overdue'").get(c.id)) continue;
    runInStore("survey", () => { logEvent(c.id, "report_overdue", { due_at: st.due_at, department: c.department }, now); audit("system", "consultation.report_overdue", "consultation:" + c.id, { due_at: st.due_at }); });
    overdue_flagged++;
  }
  return { closed, expired, overdue_flagged };
}
