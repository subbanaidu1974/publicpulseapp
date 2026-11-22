/**
 * Moderation curation (S-142): the held queue with rule-id reasons, versioned lexicon changes with independent review, and the
 * metrics that tell moderators whether the lexicon is too tight (hold rate, false-positive rate, appeal turnaround).
 *
 * Roles: moderator or admin (core roles or the local officer_role stub, via service.isModerator). Reading the queue is itself an
 * audited privileged read. Reasons are rule ids only, never the matched text.
 *
 * Lexicon changes (never applied directly):
 *   propose (add | retire a term in a list)  ->  review by OTHER moderators  ->  applied to the lexicon file, version bumped, changelog
 *   entry written. An add needs CIVIC_LEXICON_ADD_APPROVALS independent approvals (default 1); a retirement weakens moderation, so it
 *   needs CIVIC_LEXICON_RETIRE_APPROVALS (default 2) distinct approvers, none of them the proposer. One rejection closes a proposal.
 *   The changelog stores counts, never person ids.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audit, auditPrivilegedRead, getStore, runInStore } from "../core";
import { actorPseudonym } from "../core/pseudonyms";

/** The issues store (S-74): moderator ids appear in it only as actor pseudonyms. */
const getDb = () => getStore("issues");
const runInTransaction = <T>(fn: () => T): T => runInStore("issues", fn);
import { loadLexicon, lexiconPath, resetLexiconCache, type Lexicon } from "./moderation";
import { HttpError, clock, isModerator } from "./service";
import { sanitizeDescription } from "./public";

const iso = (d: Date) => d.toISOString();
export const addApprovalsNeeded = () => Math.max(1, Number(process.env.CIVIC_LEXICON_ADD_APPROVALS || 1));
export const retireApprovalsNeeded = () => Math.max(1, Number(process.env.CIVIC_LEXICON_RETIRE_APPROVALS || 2));

function needModerator(actor: string): void {
  if (!isModerator(actor)) throw new HttpError(403, "moderator role required");
}

// ---------- held queue ----------
export function heldQueue(actor: string, q: { status?: string; limit?: number; cursor?: string } = {}, now = clock.now()) {
  needModerator(actor);
  const status = q.status === "taken_down" ? "taken_down" : q.status === "escalated" ? "escalated" : "held";
  const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 50, 1), 200);
  const where = status === "escalated" ? "i.moderation<>'ok' AND i.mod_escalated=1" : `i.moderation='${status}'`;
  const after = q.cursor ? Buffer.from(String(q.cursor), "base64url").toString("utf8").split("|") : null;
  const rows = getDb().prepare(`SELECT i.id, i.category, i.village_lgd, i.created_at, i.moderation, i.moderation_reason, i.mod_escalated, i.desc_en, i.desc_te,
      (SELECT a.id FROM issue_appeal a WHERE a.issue_id=i.id AND a.status='pending' LIMIT 1) AS appeal_id,
      (SELECT a.at FROM issue_appeal a WHERE a.issue_id=i.id AND a.status='pending' LIMIT 1) AS appeal_at,
      (SELECT a.reason FROM issue_appeal a WHERE a.issue_id=i.id AND a.status='pending' LIMIT 1) AS appeal_reason
    FROM issue i WHERE ${where} AND (? IS NULL OR i.created_at > ? OR (i.created_at = ? AND i.id > ?)) ORDER BY i.created_at, i.id LIMIT ?`)
    .all(after?.[0] ?? null, after?.[0] ?? "", after?.[0] ?? "", after?.[1] ?? "", limit + 1) as any[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  auditPrivilegedRead(actor, "moderation_queue", `list ${status}`);
  const last = page[page.length - 1];
  return {
    status, count: page.length, has_more: more,
    metrics: (() => { const m = moderationMetrics(actor, {}); return { hold_rate: m.hold_rate, false_positive_rate: m.false_positive_rate, held: m.held, total: m.reports }; })(),
    next_cursor: more && last ? Buffer.from(`${last.created_at}|${last.id}`).toString("base64url") : null,
    waiting_hours_oldest: page.length ? Math.round(((now.getTime() - Date.parse(page[0].created_at)) / 3600_000) * 10) / 10 : 0,
    items: page.map(r => ({
      id: r.id, category: r.category, village_lgd: r.village_lgd, created_at: r.created_at, moderation: r.moderation, escalated: !!r.mod_escalated,
      reasons: r.moderation_reason ? String(r.moderation_reason).split(",") : [],
      description_en: sanitizeDescription(r.desc_en), description_te: sanitizeDescription(r.desc_te),
      appeal: r.appeal_id ? { id: r.appeal_id, at: r.appeal_at, reason: sanitizeDescription(r.appeal_reason, 1000) } : null,
    })),
  };
}

// ---------- lexicon ----------
const SIMPLE_LISTS = ["allowCapitalised", "stopAfterTitle"] as const;
const GROUPED_LISTS = ["honorifics", "roleTitles", "personSuffix", "introducers", "accusations", "communityTargeting", "abuse"] as const;
/** Valid list addresses: "abuse.en", "abuse.te", "abuse.translit" (accusations/communityTargeting/abuse only), "allowCapitalised" ... */
export function listAddresses(): string[] {
  const out: string[] = [...SIMPLE_LISTS];
  for (const g of GROUPED_LISTS) { out.push(`${g}.en`, `${g}.te`); if (["accusations", "communityTargeting", "abuse"].includes(g)) out.push(`${g}.translit`); }
  return out;
}
function getList(lx: Lexicon, address: string, create = false): string[] | null {
  const [a, b] = address.split(".");
  const root = lx as unknown as Record<string, unknown>;
  if (!b) return Array.isArray(root[a]) ? (root[a] as string[]) : null;
  const g = root[a] as Record<string, string[]> | undefined;
  if (!g) return null;
  if (!Array.isArray(g[b])) { if (!create) return null; g[b] = []; }
  return g[b];
}
const norm = (t: string) => t.normalize("NFKC").trim().toLowerCase();

export function lexiconInfo(actor: string) {
  needModerator(actor);
  const lx = loadLexicon();
  const counts: Record<string, number> = {};
  for (const a of listAddresses()) counts[a] = getList(lx, a)?.length ?? 0;
  return { version: lx.version, changes: listChanges(actor, "pending").items, changelog: lx.changelog ?? [], list_counts: counts, lists: listAddresses(), approvals_needed: { add: addApprovalsNeeded(), retire: retireApprovalsNeeded() } };
}

interface ChangeRow { id: string; op: "add" | "retire"; list: string; term: string; status: string; proposer_id: string; approvals: string; rejected_by: string | null; note: string | null; created_at: string; decided_at: string | null; applied_version: number | null }
const shape = (r: ChangeRow) => ({
  id: r.id, op: r.op, list: r.list, term: r.term, status: r.status, approvals: (JSON.parse(r.approvals) as string[]).length,
  approvals_needed: r.op === "add" ? addApprovalsNeeded() : retireApprovalsNeeded(), note: r.note, created_at: r.created_at, decided_at: r.decided_at, applied_version: r.applied_version,
});

export function listChanges(actor: string, status?: string) {
  needModerator(actor);
  const rows = (status
    ? getDb().prepare("SELECT * FROM lexicon_change WHERE status=? ORDER BY created_at DESC LIMIT 200").all(status)
    : getDb().prepare("SELECT * FROM lexicon_change ORDER BY created_at DESC LIMIT 200").all()) as unknown as ChangeRow[];
  return { items: rows.map(shape) };
}

export function proposeChange(actor: string, b: { op?: string; list?: string; term?: string; note?: string }, now = clock.now()) {
  needModerator(actor);
  if (b.op !== "add" && b.op !== "retire") throw new HttpError(400, "op must be add or retire");
  if (!b.list || !listAddresses().includes(b.list)) throw new HttpError(400, "unknown list", { lists: listAddresses() });
  const term = typeof b.term === "string" ? b.term.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  if (term.length < 2 || term.length > 60 || /[\u0000-\u001f]/.test(term)) throw new HttpError(400, "term must be 2 to 60 characters");
  if (/^\d+$/.test(term) || /@/.test(term)) throw new HttpError(400, "term must be a word or phrase, not a number or address");
  const lx = loadLexicon();
  const list = getList(lx, b.list, false) ?? [];
  const present = list.some(t => norm(t) === norm(term));
  if (b.op === "add" && present) throw new HttpError(409, "term already in the lexicon");
  if (b.op === "retire" && !present) throw new HttpError(404, "term not in that list");
  const db = getDb();
  const dup = db.prepare("SELECT id FROM lexicon_change WHERE status='pending' AND op=? AND list=? AND lower(term)=?").get(b.op, b.list, norm(term));
  if (dup) throw new HttpError(409, "an identical proposal is already pending", { id: (dup as { id: string }).id });
  const id = randomUUID();
  db.prepare("INSERT INTO lexicon_change (id,op,list,term,status,proposer_id,approvals,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, b.op, b.list, term, "pending", actorPseudonym(actor), "[]", (b.note ?? "").slice(0, 500) || null, iso(now));
  audit(actor, "lexicon.propose", `lexicon:${id}`, { op: b.op, list: b.list });
  return { id, status: "pending", approvals_needed: b.op === "add" ? addApprovalsNeeded() : retireApprovalsNeeded() };
}

export function reviewChange(actor: string, id: string, decision: string, now = clock.now()) {
  needModerator(actor);
  if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "decision must be approve or reject");
  const db = getDb();
  const r = db.prepare("SELECT * FROM lexicon_change WHERE id=?").get(id) as unknown as ChangeRow | undefined;
  if (!r) throw new HttpError(404, "proposal not found");
  if (r.status !== "pending") throw new HttpError(409, `proposal already ${r.status}`);
  const me = actorPseudonym(actor);
  if (r.proposer_id === me) throw new HttpError(403, "the proposer cannot review their own change", { hint: "independent_review_required" });
  if (decision === "reject") {
    db.prepare("UPDATE lexicon_change SET status='rejected', rejected_by=?, decided_at=? WHERE id=?").run(me, iso(now), id);
    audit(actor, "lexicon.reject", `lexicon:${id}`, { op: r.op, list: r.list });
    return { id, status: "rejected" };
  }
  const approvals = JSON.parse(r.approvals) as string[];
  if (approvals.includes(me)) throw new HttpError(409, "you already approved this change");
  approvals.push(me);
  const need = r.op === "add" ? addApprovalsNeeded() : retireApprovalsNeeded();
  if (approvals.length < need) {
    db.prepare("UPDATE lexicon_change SET approvals=? WHERE id=?").run(JSON.stringify(approvals), id);
    audit(actor, "lexicon.approve", `lexicon:${id}`, { op: r.op, list: r.list, have: approvals.length, need });
    return { id, status: "pending", approvals: approvals.length, approvals_needed: need };
  }
  return runInTransaction(() => {
    const version = applyChange(r, approvals.length, now);
    db.prepare("UPDATE lexicon_change SET approvals=?, status='applied', decided_at=?, applied_version=? WHERE id=?").run(JSON.stringify(approvals), iso(now), version, id);
    audit(actor, "lexicon.apply", `lexicon:${id}`, { op: r.op, list: r.list, version });
    return { id, status: "applied", version };
  });
}

/** Write the lexicon file (temp file then rename), bump the version, append a changelog entry. Returns the new version. */
function applyChange(r: ChangeRow, approvals: number, now: Date): number {
  const file = lexiconPath();
  const lx = loadLexicon(file);
  const list = getList(lx, r.list, true)!;
  if (r.op === "add") { if (!list.some(t => norm(t) === norm(r.term))) list.push(r.term); }
  else { const keep = list.filter(t => norm(t) !== norm(r.term)); list.splice(0, list.length, ...keep); }
  const version = (lx.version ?? 0) + 1;
  lx.version = version;
  lx.changelog = [...(lx.changelog ?? []), { version, date: iso(now).slice(0, 10), op: r.op, list: r.list, term: r.term, change_id: r.id, approvals }];
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(lx, null, 2) + "\n");
  fs.renameSync(tmp, file);
  resetLexiconCache();
  return version;
}

// ---------- metrics ----------
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };
const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);

/**
 * hold_rate = issues ever held / issues reported.
 * false_positive_rate = held issues a moderator approved (released) / issues ever held.
 * appeal turnaround = hours from appeal to decision (mean and median over decided appeals), plus the pending count.
 * Window: reports created since `since` (ISO date) when given. Aggregate numbers only.
 */
export function moderationMetrics(actor: string, q: { since?: string } = {}) {
  needModerator(actor);
  const db = getDb();
  const since = typeof q.since === "string" && /^\d{4}-\d{2}-\d{2}/.test(q.since) ? q.since : "";
  const one = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { c: number }).c;
  const total = one("SELECT COUNT(*) c FROM issue WHERE created_at>=?", since);
  const held = one("SELECT COUNT(*) c FROM issue WHERE moderation_reason IS NOT NULL AND created_at>=?", since);
  const approved = one("SELECT COUNT(DISTINCT a.issue_id) c FROM moderation_action a JOIN issue i ON i.id=a.issue_id WHERE a.decision='approve' AND i.moderation_reason IS NOT NULL AND i.created_at>=?", since);
  const rejected = one("SELECT COUNT(DISTINCT a.issue_id) c FROM moderation_action a JOIN issue i ON i.id=a.issue_id WHERE a.decision='reject' AND i.created_at>=?", since);
  const pending = one("SELECT COUNT(*) c FROM issue WHERE moderation='held' AND created_at>=?", since);
  const appeals = db.prepare("SELECT at, decided_at, status FROM issue_appeal WHERE at>=?").all(since) as { at: string; decided_at: string | null; status: string }[];
  const hrs = appeals.filter(a => a.decided_at).map(a => (Date.parse(a.decided_at!) - Date.parse(a.at)) / 3600_000);
  const byRule: Record<string, number> = {};
  for (const r of db.prepare("SELECT moderation_reason r FROM issue WHERE moderation_reason IS NOT NULL AND created_at>=?").all(since) as { r: string }[])
    for (const rule of r.r.split(",")) byRule[rule] = (byRule[rule] ?? 0) + 1;
  return {
    since: since || null, lexicon_version: loadLexicon().version,
    reports: total, held, hold_rate: ratio(held, total),
    approved_after_hold: approved, rejected_after_hold: rejected, still_waiting: pending, false_positive_rate: ratio(approved, held),
    appeals: { total: appeals.length, decided: hrs.length, pending: appeals.length - hrs.length, mean_turnaround_hours: hrs.length ? Math.round((hrs.reduce((s, x) => s + x, 0) / hrs.length) * 10) / 10 : null, median_turnaround_hours: median(hrs) },
    held_by_rule: byRule,
  };
}
