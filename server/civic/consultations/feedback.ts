/**
 * Feedback, public figures and public comments (S-35), with the anti-astroturf controls of S-36 (a).
 *
 *  POST /:id/feedback        auth: {clause, stance, comment?, public_ok?}; one row per (person, clause), editable until close, last edit wins
 *  GET  /:id/mine            auth: the caller's own feedback (all clauses) and eligibility
 *  GET  /:id/figures         public: per-clause aggregates (k-suppressed, rounded), only after close + delay
 *  GET  /:id/comments        public: opted-in comments that passed moderation, location at mandal level only, no name; flagged clusters marked
 *  POST /:id/comments/:fid/moderate   moderator | admin: release or keep a held comment
 */
import crypto from "node:crypto";
import { Router } from "express";
import express from "express";
import { audit, requireAuth, requireRole, runInStore } from "../core";
import { rateAllow } from "../identity/service";
import { assessText } from "../issues/moderation";
import { checkEligibility, isIneligible } from "../surveys/eligibility";
import { policyFromEnv } from "../surveys/publish";
import type { SurveyForResponse } from "../surveys/source";
import { registryNow } from "../surveys/types";
import type { ScopeUnits } from "../surveys/types";
import { buildFigures, commentClusters, figuresGate } from "./analysis";
import { currentContent, getConsultation, logEvent, visible } from "./registry";
import { cdb } from "./schema";
import { STANCES, UUID, cfg, disclaimer, feedbackKey, fail, iso, lim, netKey, netPrefix, str, wrap } from "./types";
import type { ConsultationRow, Stance } from "./types";
import { getUnit } from "../geo/service";

/** Eligibility reuses the survey rules (adult account, T1+, residence inside the scope, number checks, account age) via a survey-shaped view. */
function eligibility(personId: string, c: ConsultationRow, now: Date) {
  const view: SurveyForResponse = {
    id: c.id, status: c.status === "open" ? "open" : c.status, topic_class: "bill",
    scope: { state: c.scope_state, units: JSON.parse(c.scope_units) as ScopeUnits }, opens_at: c.opens_at, closes_at: c.closes_at, wording_hash: c.content_hash, questions: [],
  };
  return checkEligibility(personId, view, now);
}

const latinOrTelugu = (t: string): boolean => {
  const letters = [...t].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return true;
  return letters.filter((ch) => /[A-Za-zఀ-౿]/.test(ch)).length / letters.length >= 0.9;
};

export type SubmitResult =
  | { ok: true; clause: number; stance: Stance; edited: boolean; comment_status: "none" | "ok" | "held"; comment_public: boolean }
  | { ok: false; status: number; code: string; extra?: Record<string, unknown> };

/** The whole submission path (also used directly by tests and the 500-comment scenario). `ip` feeds the per-network limit. */
export function submitFeedback(personId: string, consultationId: string, input: Record<string, unknown>, ip: string | undefined, now: Date = registryNow()): SubmitResult {
  const c = getConsultation(consultationId);
  if (!visible(c)) return { ok: false, status: 404, code: "not_found" };
  if (c.status !== "open") return { ok: false, status: 409, code: c.status === "closed" || c.status === "completed" ? "consultation_closed" : "consultation_not_open", extra: { status: c.status } };
  const t = now.getTime();
  if (t < Date.parse(c.opens_at)) return { ok: false, status: 409, code: "not_yet_open", extra: { opens_at: c.opens_at } };
  if (t >= Date.parse(c.closes_at)) return { ok: false, status: 409, code: "consultation_closed" };
  const content = currentContent(c);
  const n = Number(input.clause);
  if (!Number.isInteger(n) || !content.clauses.some((x) => x.n === n)) return { ok: false, status: 400, code: "clause_invalid", extra: { clauses: content.clauses.length } };
  const stance = str(input.stance) as Stance;
  if (!(STANCES as readonly string[]).includes(stance)) return { ok: false, status: 400, code: "stance_invalid", extra: { stances: STANCES } };
  let comment: string | null = null;
  if (input.comment !== undefined && input.comment !== null) {
    if (typeof input.comment !== "string") return { ok: false, status: 400, code: "comment_invalid" };
    const text = input.comment.replace(/\r\n/g, "\n").trim();
    if ([...text].length > lim("max_comment_chars")) return { ok: false, status: 400, code: "comment_too_long", extra: { max_chars: lim("max_comment_chars") } };
    if (!latinOrTelugu(text)) return { ok: false, status: 400, code: "comment_language", extra: { hint: "write in English or Telugu" } };
    comment = text || null;
  }
  const el = eligibility(personId, c, now);
  if (isIneligible(el)) return { ok: false, status: el.status, code: el.code === "survey_not_open" ? "consultation_not_open" : el.code, extra: { message: el.message, ...(el.eligible_from ? { eligible_from: el.eligible_from } : {}) } };

  const prefix = netPrefix(ip), nk = netKey(c.id, prefix), minute = iso(now).slice(0, 16);
  const limitedBump = () => { cdb().prepare("INSERT INTO consultation_burst (consultation_id, minute, n, limited) VALUES (?,?,0,1) ON CONFLICT(consultation_id, minute) DO UPDATE SET limited = limited + 1").run(c.id, minute); };
  if (!rateAllow(`consult:p:${c.id}:${personId}`, cfg.perMinPerson(), 60_000, t)) { limitedBump(); return { ok: false, status: 429, code: "too_many_requests", extra: { scope: "person" } }; }
  if (!rateAllow(`consult:n:${c.id}:${prefix}`, cfg.perMinNet(), 60_000, t)) { limitedBump(); return { ok: false, status: 429, code: "too_many_requests", extra: { scope: "network" } }; }

  let verdict: "none" | "ok" | "hold" = "none", reasons: string[] = [];
  if (comment) { const a = assessText(comment); verdict = a.verdict === "hold" ? "hold" : "ok"; reasons = a.reasons; }
  const publicOk = input.public_ok === true ? 1 : 0;
  const key = feedbackKey(c.id, personId);
  const existed = !!cdb().prepare("SELECT 1 AS x FROM consultation_feedback WHERE consultation_id = ? AND clause_n = ? AND person_key = ?").get(c.id, n, key);
  runInStore("survey", () => {
    cdb().prepare(`INSERT INTO consultation_feedback (id, consultation_id, clause_n, person_key, stance, comment, public_ok, mod_verdict, mod_reasons, mandal, tier, quality, net_key, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(consultation_id, clause_n, person_key) DO UPDATE SET stance = excluded.stance, comment = excluded.comment, public_ok = excluded.public_ok,
                     mod_verdict = excluded.mod_verdict, mod_reasons = excluded.mod_reasons, mandal = excluded.mandal, tier = excluded.tier, quality = excluded.quality,
                     net_key = excluded.net_key, updated_at = excluded.updated_at, edits = consultation_feedback.edits + 1`)
      .run(crypto.randomUUID(), c.id, n, key, stance, comment, publicOk, verdict, JSON.stringify(reasons), el.mandal, el.tier, el.quality, nk, iso(now), iso(now));
    cdb().prepare("INSERT INTO consultation_burst (consultation_id, minute, n, limited) VALUES (?,?,1,0) ON CONFLICT(consultation_id, minute) DO UPDATE SET n = n + 1").run(c.id, minute);
  });
  return { ok: true, clause: n, stance, edited: existed, comment_status: verdict === "none" ? "none" : verdict === "hold" ? "held" : "ok", comment_public: !!publicOk && verdict === "ok" };
}

export const feedbackRouter = Router();
feedbackRouter.use(express.json({ limit: "64kb" }));

feedbackRouter.post("/:id/feedback", requireAuth, wrap((req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const r = submitFeedback(req.person!.id, req.params.id, body, req.ip);
  if (r.ok === false) return fail(res, r.status, r.code, r.extra);
  res.status(r.edited ? 200 : 201).json({ ...r, ...disclaimer() });
}));

feedbackRouter.get("/:id/mine", requireAuth, wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const key = feedbackKey(c.id, req.person!.id);
  const rows = cdb().prepare("SELECT clause_n, stance, comment, public_ok, mod_verdict, created_at, updated_at, edits FROM consultation_feedback WHERE consultation_id = ? AND person_key = ? ORDER BY clause_n").all(c.id, key) as unknown as
    { clause_n: number; stance: string; comment: string | null; public_ok: number; mod_verdict: string; created_at: string; updated_at: string; edits: number }[];
  const el = eligibility(req.person!.id, c, registryNow());
  res.setHeader("Cache-Control", "no-store");
  res.json({
    consultation_id: c.id, editable_until: c.closes_at, eligible: el.ok === true, ineligible: isIneligible(el) ? { code: el.code, message: el.message } : null,
    feedback: rows.map((r) => ({ clause: r.clause_n, stance: r.stance, comment: r.comment, public_ok: !!r.public_ok, comment_status: r.mod_verdict === "none" ? "none" : r.mod_verdict === "hold" ? "held" : "ok", created_at: r.created_at, updated_at: r.updated_at, edits: r.edits })),
    ...disclaimer(),
  });
}));

feedbackRouter.get("/:id/figures", wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  if (!rateAllow(`consultpub:fig:${req.ip || "?"}:${c.id}`, 120, 60_000)) return fail(res, 429, "too_many_requests");
  const f = buildFigures(c, registryNow());
  if (f.published === false) return fail(res, 403, "not_published", { reason: f.reason, due_at: f.due_at });
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.json({ ...f, ...disclaimer() });
}));

feedbackRouter.get("/:id/comments", wrap((req, res) => {
  const now = registryNow();
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  if (!rateAllow(`consultpub:cm:${req.ip || "?"}:${c.id}`, 60, 60_000)) return fail(res, 429, "too_many_requests");
  const g = figuresGate(c, now);
  if (g.ok === false) return fail(res, 403, "not_published", { reason: g.reason });
  const k = policyFromEnv().k;
  const clauseQ = req.query.clause === undefined ? null : Number(req.query.clause);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 50));
  const offset = Math.max(0, Math.floor(Number(req.query.offset)) || 0);
  const rows = cdb().prepare(`SELECT id, clause_n, stance, comment, mandal, updated_at FROM consultation_feedback WHERE consultation_id = ? AND public_ok = 1 AND mod_verdict IN ('ok','released') AND comment IS NOT NULL ${clauseQ ? "AND clause_n = ?" : ""} ORDER BY updated_at, id`)
    .all(...(clauseQ ? [c.id, clauseQ] : [c.id])) as unknown as { id: string; clause_n: number; stance: string; comment: string; mandal: string | null; updated_at: string }[];
  const mandalN = new Map<string, number>();
  for (const r of cdb().prepare("SELECT clause_n, mandal, COUNT(*) AS n FROM consultation_feedback WHERE consultation_id = ? AND mandal IS NOT NULL GROUP BY clause_n, mandal").all(c.id) as unknown as { clause_n: number; mandal: string; n: number }[]) mandalN.set(r.clause_n + "|" + r.mandal, r.n);
  const size = new Map<string, number>();
  for (const cl of commentClusters(c)) for (const id of cl.ids) size.set(id, cl.size);
  const page = rows.slice(offset, offset + limit);
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.json({
    comments: page.map((r) => {
      const sz = size.get(r.id) ?? 1;
      const u = r.mandal && (mandalN.get(r.clause_n + "|" + r.mandal) ?? 0) >= k ? (getUnit(r.mandal) as unknown as { name_en?: string; name_te?: string } | undefined) : undefined;
      return {
        ref: crypto.createHash("sha256").update(c.id + r.id).digest("hex").slice(0, 12), clause: r.clause_n, stance: r.stance, comment: r.comment,
        location: u ? { level: "mandal", name_en: u.name_en ?? null, name_te: u.name_te ?? null } : null,
        flag: sz >= cfg.clusterFlagMin() ? "near_duplicate" : null, cluster_size: sz > 1 ? sz : null,
      };
    }),
    total: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null,
    note: "Only comments whose author chose to make them public and that passed moderation are listed. No names. Comments marked near_duplicate belong to a cluster of near-identical text and do not add to any count.",
    ...disclaimer(),
  });
}));

feedbackRouter.post("/:id/comments/:fid/moderate", requireRole("moderator", "admin"), wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const decision = str(req.body?.decision);
  if (decision !== "release" && decision !== "keep_held") return fail(res, 400, "decision_invalid");
  if (!UUID.test(req.params.fid)) return fail(res, 404, "not_found");
  const r = cdb().prepare("SELECT mod_verdict FROM consultation_feedback WHERE id = ? AND consultation_id = ?").get(req.params.fid, c.id) as { mod_verdict: string } | undefined;
  if (!r || r.mod_verdict === "none") return fail(res, 404, "not_found");
  const next = decision === "release" ? "released" : "hold";
  runInStore("survey", () => {
    cdb().prepare("UPDATE consultation_feedback SET mod_verdict = ? WHERE id = ?").run(next, req.params.fid);
    logEvent(c.id, "comment_moderated", { decision }, registryNow());
    audit(req.person!.id, "consultation.comment.moderate", "consultation:" + c.id, { decision });
  });
  res.json({ ok: true, decision });
}));
