/**
 * Representative reply role (S-145, docs/REPRESENTATIVES.md). Mounted at /api/v1/civic/representatives.
 *
 * A verified elected representative (role "politician", granted only through the dual-control admin API with a constituency) may post ONE
 * clearly labelled official reply on an issue in that constituency, with up to three scheme tags from the registry.
 *  - One reply thread per issue. A revision APPENDS a new version; nothing is edited in place, and earlier visible versions stay listed.
 *  - Text goes through the same moderation rules as reports. A flagged version is HELD (not public) until a moderator approves it; a
 *    moderator may also hold or remove a version. The previous visible version keeps showing while a newer one is held.
 *  - The reply never changes an issue's status, order, counts or visibility: it is shown beside the report, not ranked above it.
 *  - Every step is audited (actor, issue, version, status; never the text).
 *
 *  GET  /schemes                          public: scheme tag registry
 *  POST /issues/:id/reply                 politician: {text, scheme_tags?} -> v1 (201)
 *  POST /issues/:id/reply/revise          politician (the author): {text, scheme_tags?} -> next version
 *  GET  /issues/:id/reply/mine            politician (the author): every version with its status
 *  POST /issues/:id/grievance             politician covering the issue: forward the public issue text to the installed grievance system
 *  GET  /issues/:id/grievance             same caller: the link and the system's current status
 *  GET  /moderation/queue                 moderator or admin: held versions
 *  POST /replies/:id/review               moderator or admin: {decision: approve|hold|remove, note}
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { audit, auditPrivilegedRead, getStore, requireAuth } from "../core";
import { actorPseudonym } from "../core/pseudonyms";
import { rateAllow } from "../identity/service";
import { grantsOf, scopeCovers } from "../scope/model";
import { assessText } from "../issues/moderation";
import { isModerator } from "../issues/service";
import { sanitizeDescription } from "../issues/public";
import { parseSchemeTags, schemeRegistry } from "./schemes";
import { getGrievanceAdapter, validateTicket } from "./grievance";
import { repliesOf, type ReplyRow } from "./store";

export * from "./store";
export * from "./schemes";
export * from "./grievance";

export class ReplyError extends Error { constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); } }

const idb = () => getStore("issues");
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const REPLY_MIN = 20, REPLY_MAX = 1000, MAX_VERSIONS = 20;
const perDay = () => Number(process.env.CIVIC_REP_REPLIES_PER_DAY || 10);
const cleanText = (v: unknown): string => str(v).normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

interface IssueRow { id: string; village_lgd: string; category: string; department: string; desc_en: string | null; desc_te: string | null }
function publicIssueRow(id: string): IssueRow {
  const i = idb().prepare("SELECT id, village_lgd, category, department, desc_en, desc_te FROM issue WHERE id = ? AND moderation = 'ok'").get(id) as unknown as IssueRow | undefined;
  if (!i) throw new ReplyError(404, "issue not found");
  return i;
}
/** The constituency of the person's politician grant that reaches the issue's village, or a refusal. */
function coveringConstituency(personId: string, issue: IssueRow): string {
  const grants = grantsOf(personId, "politician").filter((g) => (g.jurisdiction ?? "").trim());
  if (!grants.length) throw new ReplyError(403, "a verified representative role is required", { code: "role_required" });
  const g = grants.find((x) => scopeCovers(x, issue.village_lgd));
  if (!g) { audit(personId, "scope.denied", "issue:" + issue.id, { reason: "outside_scope", role: "politician" }); throw new ReplyError(403, "this issue is outside your constituency", { code: "outside_scope" }); }
  return g.jurisdiction!.trim();
}

function parseBody(body: Record<string, unknown> | undefined): { text: string; tags: string[] } {
  const text = cleanText(body?.text);
  if (text.length < REPLY_MIN || text.length > REPLY_MAX) throw new ReplyError(400, `the reply must be ${REPLY_MIN} to ${REPLY_MAX} characters`, { code: "bad_length" });
  const tags = parseSchemeTags(body?.scheme_tags);
  if ("code" in tags) throw new ReplyError(400, tags.code === "too_many_tags" ? "at most three scheme tags" : tags.code === "unknown_scheme" ? "unknown scheme tag" : "scheme_tags must be a list of ids", { code: tags.code });
  return { text, tags: "ids" in tags ? tags.ids : [] };
}

function append(personId: string, issue: IssueRow, constituency: string, version: number, text: string, tags: string[], now: Date): ReplyRow {
  const verdict = assessText(text);
  const status = verdict.verdict === "hold" ? "held" : "visible";
  const id = crypto.randomUUID();
  idb().prepare("INSERT INTO rep_reply (id, issue_id, version, author_id, constituency, body, scheme_tags, status, hold_reasons, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, issue.id, version, actorPseudonym(personId), constituency, text, JSON.stringify(tags), status, JSON.stringify(status === "held" ? verdict.reasons : []), now.toISOString());
  audit(personId, version === 1 ? "representative.reply.post" : "representative.reply.revise", "issue:" + issue.id, { reply: id, version, status, tags, constituency });
  return idb().prepare("SELECT * FROM rep_reply WHERE id = ?").get(id) as unknown as ReplyRow;
}
const mineView = (r: ReplyRow) => ({ id: r.id, version: r.version, status: r.status, text: r.body, scheme_tags: JSON.parse(r.scheme_tags) as string[], hold_reasons: JSON.parse(r.hold_reasons) as string[], note: r.status === "visible" ? null : r.note, created_at: r.created_at, decided_at: r.decided_at });

export function postReply(personId: string, issueId: string, body: Record<string, unknown> | undefined, now = new Date()) {
  const issue = publicIssueRow(issueId);
  const constituency = coveringConstituency(personId, issue);
  if (!rateAllow("rep-reply:" + personId, perDay(), 86400_000, now.getTime())) throw new ReplyError(429, "daily reply limit reached", { code: "rate_limited" });
  const { text, tags } = parseBody(body);
  if (repliesOf(issue.id).length) throw new ReplyError(409, "this issue already has an official reply; add a revision instead", { code: "reply_exists" });
  const row = append(personId, issue, constituency, 1, text, tags, now);
  return mineView(row);
}

export function reviseReply(personId: string, issueId: string, body: Record<string, unknown> | undefined, now = new Date()) {
  const issue = publicIssueRow(issueId);
  const constituency = coveringConstituency(personId, issue);
  const rows = repliesOf(issue.id);
  if (!rows.length) throw new ReplyError(404, "there is no reply to revise yet", { code: "no_reply" });
  if (rows[0].author_id !== actorPseudonym(personId)) throw new ReplyError(403, "only the author of the reply can revise it", { code: "not_author" });
  if (rows.length >= MAX_VERSIONS) throw new ReplyError(409, "revision limit reached", { code: "too_many_versions" });
  if (!rateAllow("rep-reply:" + personId, perDay(), 86400_000, now.getTime())) throw new ReplyError(429, "daily reply limit reached", { code: "rate_limited" });
  const { text, tags } = parseBody(body);
  const last = rows[rows.length - 1];
  if (last.status !== "removed" && last.body === text && last.scheme_tags === JSON.stringify(tags)) throw new ReplyError(409, "nothing changed", { code: "no_change" });
  const row = append(personId, issue, constituency, rows[rows.length - 1].version + 1, text, tags, now);
  return mineView(row);
}

export function myReplyThread(personId: string, issueId: string) {
  const rows = repliesOf(issueId);
  if (!rows.length || rows[0].author_id !== actorPseudonym(personId)) throw new ReplyError(404, "no reply of yours on this issue");
  return { issue_id: issueId, versions: rows.map(mineView) };
}

// ---------- moderation ----------
export function heldQueue(actor: string) {
  if (!isModerator(actor)) throw new ReplyError(403, "moderator role required");
  const rows = idb().prepare("SELECT * FROM rep_reply WHERE status = 'held' ORDER BY created_at LIMIT 200").all() as unknown as ReplyRow[];
  auditPrivilegedRead(actor, "rep_reply_queue", "moderator lists held representative replies");
  return { replies: rows.map((r) => ({ id: r.id, issue_id: r.issue_id, version: r.version, constituency: r.constituency, text: r.body, scheme_tags: JSON.parse(r.scheme_tags) as string[], reasons: JSON.parse(r.hold_reasons) as string[], created_at: r.created_at })) };
}
export function reviewReply(actor: string, replyId: string, decision: string, note: unknown, now = new Date()) {
  if (!isModerator(actor)) throw new ReplyError(403, "moderator role required");
  const r = idb().prepare("SELECT * FROM rep_reply WHERE id = ?").get(replyId) as unknown as ReplyRow | undefined;
  if (!r) throw new ReplyError(404, "reply not found");
  if (r.author_id && r.author_id === actorPseudonym(actor)) throw new ReplyError(403, "you cannot moderate your own reply", { code: "own_reply" });
  const n = cleanText(note).slice(0, 300);
  let next: string;
  if (decision === "approve") { if (r.status !== "held") throw new ReplyError(409, "only a held reply can be approved", { code: "not_held" }); next = "visible"; }
  else if (decision === "hold") { if (r.status !== "visible") throw new ReplyError(409, "only a visible reply can be held", { code: "not_visible" }); next = "held"; }
  else if (decision === "remove") { if (r.status === "removed") throw new ReplyError(409, "already removed", { code: "already_removed" }); next = "removed"; }
  else throw new ReplyError(400, "decision must be approve, hold or remove", { code: "bad_decision" });
  if (decision !== "approve" && n.length < 5) throw new ReplyError(400, "a short reason is required", { code: "note_required" });
  idb().prepare("UPDATE rep_reply SET status = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(next, n || null, actorPseudonym(actor), now.toISOString(), r.id);
  audit(actor, "representative.reply.review", "issue:" + r.issue_id, { reply: r.id, version: r.version, decision, from: r.status, to: next });
  return { id: r.id, status: next };
}

// ---------- grievance system forwarding ----------
interface LinkRow { id: string; issue_id: string; system: string; reference: string; status: string; created_at: string; updated_at: string }
const linkView = (l: LinkRow) => ({ system: l.system, reference: l.reference, status: l.status, created_at: l.created_at, updated_at: l.updated_at });

export async function forwardToGrievance(personId: string, issueId: string, now = new Date()) {
  const issue = publicIssueRow(issueId);
  const constituency = coveringConstituency(personId, issue);
  const adapter = getGrievanceAdapter();
  if (!adapter) throw new ReplyError(501, "no grievance system is connected", { code: "grievance_adapter_unavailable" });
  const existing = idb().prepare("SELECT * FROM grievance_link WHERE issue_id = ? AND system = ?").get(issue.id, adapter.name) as unknown as LinkRow | undefined;
  if (existing) return { created: false, ...linkView(existing) };
  if (!rateAllow("rep-grievance:" + personId, perDay(), 86400_000, now.getTime())) throw new ReplyError(429, "daily limit reached", { code: "rate_limited" });
  const tags = repliesOf(issue.id).filter((r) => r.status === "visible").slice(-1).flatMap((r) => JSON.parse(r.scheme_tags) as string[]);
  const ticket = validateTicket({
    issue_id: issue.id, category: issue.category, department: issue.department, village_lgd: issue.village_lgd, constituency_lgd: constituency,
    text_en: sanitizeDescription(issue.desc_en), text_te: sanitizeDescription(issue.desc_te), scheme_tags: tags,
  });
  let receipt;
  try { receipt = await adapter.submit(ticket, { idempotencyKey: `issue:${issue.id}:${adapter.name}` }); }
  catch { audit(personId, "representative.grievance.failed", "issue:" + issue.id, { system: adapter.name }); throw new ReplyError(502, "the grievance system did not accept the request", { code: "grievance_system_error" }); }
  const id = crypto.randomUUID(), t = now.toISOString();
  idb().prepare("INSERT OR IGNORE INTO grievance_link (id, issue_id, system, reference, status, requested_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, issue.id, adapter.name, receipt.reference, receipt.status, actorPseudonym(personId), t, t);
  audit(personId, "representative.grievance.forward", "issue:" + issue.id, { system: adapter.name, reference: receipt.reference });
  return { created: true, system: adapter.name, reference: receipt.reference, status: receipt.status, created_at: t, updated_at: t };
}

export async function grievanceStatus(personId: string, issueId: string, now = new Date()) {
  const issue = publicIssueRow(issueId);
  coveringConstituency(personId, issue);
  const adapter = getGrievanceAdapter();
  if (!adapter) throw new ReplyError(501, "no grievance system is connected", { code: "grievance_adapter_unavailable" });
  const l = idb().prepare("SELECT * FROM grievance_link WHERE issue_id = ? AND system = ?").get(issue.id, adapter.name) as unknown as LinkRow | undefined;
  if (!l) throw new ReplyError(404, "not forwarded");
  try {
    const s = await adapter.status(l.reference);
    if (s.status !== l.status) { idb().prepare("UPDATE grievance_link SET status = ?, updated_at = ? WHERE id = ?").run(s.status, now.toISOString(), l.id); return linkView({ ...l, status: s.status, updated_at: now.toISOString() }); }
  } catch { throw new ReplyError(502, "the grievance system did not answer", { code: "grievance_system_error" }); }
  return linkView(l);
}

// ---------- router ----------
export const representativesRouter = Router();
representativesRouter.use(express.json({ limit: "16kb" }));
const wrap = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response) => {
  const fail = (e: unknown) => { if (e instanceof ReplyError) return void res.status(e.status).json({ error: e.message, ...e.extra }); if (!res.headersSent) res.status(500).json({ error: "internal error" }); };
  try { Promise.resolve(fn(req, res)).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }, fail); } catch (e) { fail(e); }
};
const pid = (req: Request) => req.person!.id;
const idParam = (req: Request) => str(req.params.id).slice(0, 64);

representativesRouter.get("/schemes", (req, res) => {
  if (!rateAllow("rep-schemes:" + (req.ip || "?"), 60, 60_000)) return void res.status(429).json({ error: "too many requests; wait and retry" });
  res.set("Cache-Control", "public, max-age=3600");
  res.json({ schemes: schemeRegistry(), max_tags: 3 });
});
representativesRouter.post("/issues/:id/reply", requireAuth, wrap((req, res) => { const out = postReply(pid(req), idParam(req), req.body); res.status(201); return out; }));
representativesRouter.post("/issues/:id/reply/revise", requireAuth, wrap((req, res) => { const out = reviseReply(pid(req), idParam(req), req.body); res.status(201); return out; }));
representativesRouter.get("/issues/:id/reply/mine", requireAuth, wrap((req) => myReplyThread(pid(req), idParam(req))));
representativesRouter.post("/issues/:id/grievance", requireAuth, wrap(async (req, res) => { const out = await forwardToGrievance(pid(req), idParam(req)); res.status(out.created ? 201 : 200); return out; }));
representativesRouter.get("/issues/:id/grievance", requireAuth, wrap((req) => grievanceStatus(pid(req), idParam(req))));
representativesRouter.get("/moderation/queue", requireAuth, wrap((req) => heldQueue(pid(req))));
representativesRouter.post("/replies/:id/review", requireAuth, wrap((req) => reviewReply(pid(req), idParam(req), str(req.body?.decision), req.body?.note)));
