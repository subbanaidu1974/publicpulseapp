/**
 * Broadcast polls (S-185): an admin pushes a short opinion poll to every registered user, who must answer it before using the app.
 * Mounted at /api/v1/civic/broadcast. See docs/BROADCAST_POLLS.md.
 *
 *   POST /admin               admin: create AND open a poll now
 *   GET  /admin               admin: all polls, with response counts
 *   GET  /admin/:id/results   admin: per-question counts (suppressed below the minimum response count)
 *   POST /admin/:id/close     admin: close it; nobody is blocked by it afterwards
 *   GET  /pending             signed-in: the oldest open poll this person has not answered, or {poll: null}
 *   POST /:id/answer          signed-in: {answers: [[optionIndex, ...], ...]}, one entry per question; every question must be answered
 *
 * This is NOT a Pulse Survey: no weighting, no representativeness claim, no published figures. It is a self-selected opinion poll among
 * signed-in accounts and every payload says so. Privacy: the survey store keeps only per-option counters and, per poll, a keyed
 * pseudonym saying "this account answered" (no persons.id, no per-response rows), so an answer cannot be tied back to an account.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { audit, getDb, getKeys, getStore, registerMigration, requireAuth, requireRole } from "../core";
import { asksPartyPreference as policyAsksParty } from "../surveys/panel";

registerMigration("bpoll_001_core", `
CREATE TABLE bpoll_polls (
  id TEXT PRIMARY KEY, title_en TEXT NOT NULL, title_te TEXT, intro_en TEXT, intro_te TEXT,
  questions_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_by_pseudonym TEXT NOT NULL, opened_at TEXT NOT NULL, closes_at TEXT, closed_at TEXT
);
CREATE INDEX idx_bpoll_polls_status ON bpoll_polls(status, opened_at);
CREATE TABLE bpoll_done (poll_id TEXT NOT NULL, pseudonym TEXT NOT NULL, PRIMARY KEY (poll_id, pseudonym));
CREATE TABLE bpoll_counts (poll_id TEXT NOT NULL, q INTEGER NOT NULL, opt INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (poll_id, q, opt));
`, "survey");

const db = () => getStore("survey");
export const MIN_RESULTS = 10; // per-question counts are hidden until this many people answered
const MAX_OPEN = 3, MAX_QUESTIONS = 5, MAX_OPTIONS = 6, MIN_OPTIONS = 2;
const NOTE = {
  note_en: "An opinion poll among people signed in to People Pulse. Anyone can answer once, so it is self-selected and not a representative survey.",
  note_te: "People Pulse‌లో సైన్ ఇన్ అయిన వారి అభిప్రాయ సేకరణ. ఎవరైనా ఒకసారి సమాధానం ఇవ్వవచ్చు, కాబట్టి ఇది స్వచ్ఛందంగా పాల్గొన్నవారిది మాత్రమే; ప్రతినిధి సర్వే కాదు.",
};
const PREFER_NOT = { label_en: "Prefer not to say", label_te: "చెప్పదలచుకోలేదు" };
const SCALE5 = [
  ["Strongly disagree", "పూర్తిగా అంగీకరించను"], ["Disagree", "అంగీకరించను"], ["Neutral", "తటస్థం"], ["Agree", "అంగీకరిస్తాను"], ["Strongly agree", "పూర్తిగా అంగీకరిస్తాను"],
];

interface Opt { label_en: string; label_te: string | null; prefer_not: boolean }
interface Q { kind: "single" | "multi" | "scale5"; text_en: string; text_te: string | null; max_select: number; options: Opt[] }
interface PollRow { id: string; title_en: string; title_te: string | null; intro_en: string | null; intro_te: string | null; questions_json: string; status: string; opened_at: string; closes_at: string | null; closed_at: string | null }

const str = (v: unknown): string => (typeof v === "string" ? v.normalize("NFKC").trim() : "");
const fail = (res: express.Response, status: number, code: string, message: string): void => { res.status(status).json({ error: code, code, message }); };
const pseud = (pollId: string, personId: string): string => getKeys().hmac("survey-actor", `bpoll:${pollId}:${personId}`);
const hasLink = (s: string): boolean => /https?:|www\.|\.(com|in|org|net|gov)\b|bit\.ly/i.test(s);
const asksSecret = (s: string): boolean => /\b(otp|pin|password|aadhaar|bank account|card number)\b/i.test(s) || /ఓటీపీ|పాస్‌వర్డ్|ఆధార్/.test(s);

/** The survey policy lint plus vote-intention wording ("who will you vote for", Telugu party / candidate words next to a vote word). */
const asksPartyPreference = (t: string): boolean =>
  policyAsksParty(t) || (/\b(vote|voting|ballot)\b|ఓటు/i.test(t) && /\b(part(y|ies)|candidates?|alliance|mla|mp|chief minister)\b|పార్టీ|అభ్యర్థి|ముఖ్యమంత్రి/i.test(t));

class Bad extends Error { constructor(public code: string, m: string) { super(m); } }

function parseQuestions(raw: unknown): Q[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_QUESTIONS) throw new Bad("bad_questions", `a poll needs 1 to ${MAX_QUESTIONS} questions`);
  return raw.map((r, i) => {
    const x = (r ?? {}) as Record<string, unknown>;
    const kind = x.kind === "multi" || x.kind === "scale5" ? x.kind : "single";
    const text_en = str(x.text_en), text_te = str(x.text_te) || null;
    if (text_en.length < 5 || text_en.length > 300 || (text_te && text_te.length > 400)) throw new Bad("bad_question_text", `question ${i + 1}: 5 to 300 characters`);
    for (const t of [text_en, text_te ?? ""]) {
      if (hasLink(t) || asksSecret(t)) throw new Bad("question_refused", `question ${i + 1} contains a link or asks for a code, PIN, password or ID number`);
      if (t && asksPartyPreference(t)) throw new Bad("party_preference_refused", `question ${i + 1} asks people to choose a party or candidate; use a Pulse Survey for that`);
    }
    let options: Opt[];
    if (kind === "scale5") options = SCALE5.map(([en, te]) => ({ label_en: en, label_te: te, prefer_not: false }));
    else {
      const given = Array.isArray(x.options) ? x.options : [];
      if (given.length < MIN_OPTIONS || given.length > MAX_OPTIONS) throw new Bad("bad_options", `question ${i + 1}: ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
      options = given.map((o) => {
        const y = (o ?? {}) as Record<string, unknown>; const en = str(y.label_en), te = str(y.label_te) || null;
        if (en.length < 1 || en.length > 120 || (te && te.length > 160)) throw new Bad("bad_options", `question ${i + 1}: each option is 1 to 120 characters`);
        if (hasLink(en) || asksSecret(en) || asksPartyPreference(en)) throw new Bad("question_refused", `question ${i + 1}: an option is not allowed`);
        return { label_en: en, label_te: te, prefer_not: false };
      });
      if (new Set(options.map((o) => o.label_en.toLowerCase())).size !== options.length) throw new Bad("bad_options", `question ${i + 1}: options must differ`);
    }
    options.push({ ...PREFER_NOT, prefer_not: true }); // every question can be answered without taking a stance
    if (kind === "multi" && x.max_select !== undefined && x.max_select !== null && x.max_select !== "") {
      const n = Number(x.max_select);
      if (!Number.isInteger(n) || n < 1 || n > options.length - 1) throw new Bad("bad_max_select", `question ${i + 1}: maximum choices must be a whole number from 1 to ${options.length - 1}`);
    }
    const max = kind === "multi" ? Math.min(Math.max(Number(x.max_select) || options.length - 1, 1), options.length - 1) : 1;
    return { kind, text_en, text_te, max_select: max, options };
  });
}

const pollPublic = (p: PollRow) => ({
  id: p.id, title_en: p.title_en, title_te: p.title_te, intro_en: p.intro_en, intro_te: p.intro_te, opened_at: p.opened_at, closes_at: p.closes_at,
  questions: (JSON.parse(p.questions_json) as Q[]).map((q) => ({ kind: q.kind, text_en: q.text_en, text_te: q.text_te, max_select: q.max_select, options: q.options })), ...NOTE,
});

/** Closes polls whose end time passed (called on every read, so no job is needed). */
export function closeDuePolls(now: Date = new Date()): number {
  return Number(db().prepare("UPDATE bpoll_polls SET status = 'closed', closed_at = ? WHERE status = 'open' AND closes_at IS NOT NULL AND closes_at <= ?").run(now.toISOString(), now.toISOString()).changes);
}

/** The oldest open poll this person has not answered. Admins are never blocked: they run the polls (they can still answer through the same route). */
export function pendingFor(personId: string, roles: string[], now: Date = new Date()): ReturnType<typeof pollPublic> | null {
  if (roles.includes("admin")) return null;
  closeDuePolls(now);
  const open = db().prepare("SELECT * FROM bpoll_polls WHERE status = 'open' AND opened_at <= ? ORDER BY opened_at, id").all(now.toISOString()) as unknown as PollRow[];
  for (const p of open) {
    if (!db().prepare("SELECT 1 FROM bpoll_done WHERE poll_id = ? AND pseudonym = ?").get(p.id, pseud(p.id, personId))) return pollPublic(p);
  }
  return null;
}

export function createPoll(adminId: string, body: Record<string, unknown>, now: Date = new Date()): ReturnType<typeof pollPublic> {
  const title_en = str(body.title_en), title_te = str(body.title_te) || null, intro_en = str(body.intro_en) || null, intro_te = str(body.intro_te) || null;
  if (title_en.length < 5 || title_en.length > 120 || (title_te && title_te.length > 160)) throw new Bad("bad_title", "title: 5 to 120 characters");
  for (const t of [title_en, title_te ?? "", intro_en ?? "", intro_te ?? ""]) if (t && (hasLink(t) || asksSecret(t) || asksPartyPreference(t))) throw new Bad("question_refused", "the title or introduction contains a link, asks for a secret, or asks for a party choice");
  if ((intro_en?.length ?? 0) > 400 || (intro_te?.length ?? 0) > 600) throw new Bad("bad_intro", "introduction: at most 400 characters");
  const questions = parseQuestions(body.questions);
  // Scheduled start (S-186): opens_at in the future means the poll goes live by itself at that moment; absent or already past means now.
  let start = now;
  if (body.opens_at !== undefined && body.opens_at !== null && body.opens_at !== "") {
    const t = new Date(String(body.opens_at));
    if (Number.isNaN(t.getTime()) || t.getTime() > now.getTime() + 30 * 86_400_000) throw new Bad("bad_opens_at", "opens_at must be a valid time within the next 30 days");
    if (t.getTime() > now.getTime()) start = t;
  }
  let closes_at: string | null = null;
  if (body.closes_at !== undefined && body.closes_at !== null && body.closes_at !== "") {
    const t = new Date(String(body.closes_at));
    if (Number.isNaN(t.getTime()) || t.getTime() <= start.getTime() || t.getTime() > start.getTime() + 30 * 86_400_000) throw new Bad("bad_closes_at", "closes_at must be after the start and within 30 days of it");
    closes_at = t.toISOString();
  }
  closeDuePolls(now);
  if ((db().prepare("SELECT COUNT(*) AS c FROM bpoll_polls WHERE status = 'open'").get() as { c: number }).c >= MAX_OPEN) throw new Bad("too_many_open", `at most ${MAX_OPEN} polls can be open or scheduled at once; close one first`);
  const id = crypto.randomUUID();
  db().prepare("INSERT INTO bpoll_polls (id, title_en, title_te, intro_en, intro_te, questions_json, status, created_by_pseudonym, opened_at, closes_at) VALUES (?,?,?,?,?,?, 'open', ?,?,?)")
    .run(id, title_en, title_te, intro_en, intro_te, JSON.stringify(questions), getKeys().hmac("survey-actor", adminId), start.toISOString(), closes_at);
  for (let q = 0; q < questions.length; q++) for (let o = 0; o < questions[q].options.length; o++) db().prepare("INSERT INTO bpoll_counts (poll_id, q, opt, n) VALUES (?,?,?,0)").run(id, q, o);
  audit(adminId, start > now ? "broadcast.schedule" : "broadcast.open", "bpoll:" + id, { questions: questions.length });
  return pollPublic(db().prepare("SELECT * FROM bpoll_polls WHERE id = ?").get(id) as unknown as PollRow);
}

export function answerPoll(personId: string, pollId: string, answers: unknown, now: Date = new Date()): void {
  closeDuePolls(now);
  const p = db().prepare("SELECT * FROM bpoll_polls WHERE id = ?").get(pollId) as unknown as PollRow | undefined;
  if (!p) throw new Bad("not_found", "no such poll");
  if (p.status !== "open") throw new Bad("closed", "this poll is closed");
  if (p.opened_at > now.toISOString()) throw new Bad("not_started", "this poll has not started yet");
  const qs = JSON.parse(p.questions_json) as Q[];
  if (!Array.isArray(answers) || answers.length !== qs.length) throw new Bad("incomplete", "answer every question");
  const picked = qs.map((q, i) => {
    const a = answers[i];
    if (!Array.isArray(a) || a.length < 1) throw new Bad("incomplete", `question ${i + 1} has no answer`);
    const idx = [...new Set(a.map(Number))];
    if (idx.some((n) => !Number.isInteger(n) || n < 0 || n >= q.options.length)) throw new Bad("bad_option", `question ${i + 1}: unknown option`);
    const prefer = idx.some((n) => q.options[n].prefer_not);
    if (prefer && idx.length > 1) throw new Bad("bad_option", `question ${i + 1}: "prefer not to say" cannot be combined`);
    if (idx.length > q.max_select) throw new Bad("bad_option", `question ${i + 1}: choose at most ${q.max_select}`);
    return idx;
  });
  const s = db(); s.exec("BEGIN IMMEDIATE");
  try {
    const r = s.prepare("INSERT OR IGNORE INTO bpoll_done (poll_id, pseudonym) VALUES (?,?)").run(pollId, pseud(pollId, personId));
    if (Number(r.changes) === 0) throw new Bad("already_answered", "you have already answered this poll");
    picked.forEach((idx, q) => idx.forEach((o) => s.prepare("UPDATE bpoll_counts SET n = n + 1 WHERE poll_id = ? AND q = ? AND opt = ?").run(pollId, q, o)));
    s.exec("COMMIT");
  } catch (e) { s.exec("ROLLBACK"); throw e; }
}

function results(id: string) {
  const p = db().prepare("SELECT * FROM bpoll_polls WHERE id = ?").get(id) as unknown as PollRow | undefined;
  if (!p) throw new Bad("not_found", "no such poll");
  const responses = (db().prepare("SELECT COUNT(*) AS c FROM bpoll_done WHERE poll_id = ?").get(id) as { c: number }).c;
  const shown = responses >= MIN_RESULTS;
  const counts = db().prepare("SELECT q, opt, n FROM bpoll_counts WHERE poll_id = ?").all(id) as { q: number; opt: number; n: number }[];
  const qs = JSON.parse(p.questions_json) as Q[];
  return {
    ...pollPublic(p), status: p.status === "open" && p.opened_at > new Date().toISOString() ? "scheduled" : p.status, closed_at: p.closed_at, responses, min_results: MIN_RESULTS, suppressed: !shown,
    results: qs.map((q, qi) => ({ text_en: q.text_en, options: q.options.map((o, oi) => ({ label_en: o.label_en, prefer_not: o.prefer_not, n: shown ? counts.find((c) => c.q === qi && c.opt === oi)?.n ?? 0 : null })) })),
  };
}

export const broadcastRouter = Router();
broadcastRouter.use(express.json({ limit: "32kb" }));
const wrap = (fn: (req: express.Request, res: express.Response) => void) => (req: express.Request, res: express.Response): void => {
  try { fn(req, res); } catch (e) { if (e instanceof Bad) fail(res, e.code === "not_found" ? 404 : e.code === "already_answered" || e.code === "closed" || e.code === "too_many_open" || e.code === "not_started" ? 409 : 400, e.code, e.message); else { console.error(e); fail(res, 500, "error", "server error"); } }
};

broadcastRouter.post("/admin", requireAuth, requireRole("admin"), wrap((req, res) => { res.status(201).json(createPoll(req.person!.id, req.body ?? {})); }));
broadcastRouter.get("/admin", requireAuth, requireRole("admin"), wrap((_req, res) => {
  closeDuePolls();
  const rows = db().prepare("SELECT id FROM bpoll_polls ORDER BY opened_at DESC LIMIT 100").all() as { id: string }[];
  res.json({ polls: rows.map((r) => { const x = results(r.id); return { id: x.id, title_en: x.title_en, status: x.status, opened_at: x.opened_at, closes_at: x.closes_at, closed_at: x.closed_at, responses: x.responses }; }), registered_users: (getDb().prepare("SELECT COUNT(*) AS c FROM persons WHERE deleted_at IS NULL").get() as { c: number }).c });
}));
broadcastRouter.get("/admin/:id/results", requireAuth, requireRole("admin"), wrap((req, res) => { res.json(results(String(req.params.id))); }));
broadcastRouter.post("/admin/:id/close", requireAuth, requireRole("admin"), wrap((req, res) => {
  const r = db().prepare("UPDATE bpoll_polls SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(new Date().toISOString(), String(req.params.id));
  if (Number(r.changes) === 0) throw new Bad("not_found", "no open poll with that id");
  audit(req.person!.id, "broadcast.close", "bpoll:" + String(req.params.id));
  res.json({ ok: true });
}));
broadcastRouter.get("/pending", requireAuth, wrap((req, res) => { res.set("Cache-Control", "no-store"); res.json({ poll: pendingFor(req.person!.id, req.person!.roles) }); }));
broadcastRouter.post("/:id/answer", requireAuth, wrap((req, res) => { answerPoll(req.person!.id, String(req.params.id), req.body?.answers); res.json({ ok: true }); }));

