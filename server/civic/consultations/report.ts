/**
 * Analyst tools and the MANDATORY closing report (S-36). Routes (under /api/v1/civic/consultations):
 *
 *  GET  /:id/analyst                       staff: flags, clusters (size, window, representative; comment text of the representative), coverage, suggested sample
 *  POST /:id/review/comments               staff: {feedback_ids: []} record that a human read these comments
 *  POST /:id/review/run                    staff: run the installed CommentReviewer (the default is a no-op: nothing is summarised)
 *  POST /:id/themes                        staff: {label_en, label_te?, clause?} human-entered theme
 *  GET  /:id/closing-report                public once published (404 report_not_published with due_at / overdue otherwise)
 *  GET  /:id/closing-report/preview        staff: what a report would say now, with the list of what still blocks publication
 *  POST /:id/closing-report/responses      officer of the department: {clause, kind: response|no_change, text_en, text_te?}
 *  POST /:id/closing-report/publish        panel (admin | survey_panel): refuses without a department response per clause
 *  POST /:id/complete                      owner: refuses (409 closing_report_required) unless the closing report is published
 */
import crypto from "node:crypto";
import { Router } from "express";
import express from "express";
import { audit, canonicalJson, hasRole, requireAuth, requireRole, runInStore } from "../core";
import { reviewerConflict } from "../surveys/panel";
import { registryNow } from "../surveys/types";
import { antiAstroturf, buildReport, commentClusters, reviewCoverage, runReviewer, suggestSample, themesOf } from "./analysis";
import { currentContent, getConsultation, isOwner, logEvent, officerDepartment, reportRow, reportState, staffRole, visible } from "./registry";
import { cdb } from "./schema";
import { consultActor, disclaimer, fail, iso, lim, sha256, str, trim, wrap } from "./types";
import type { ConsultationRow } from "./types";

export const reportRouter = Router();
reportRouter.use(express.json({ limit: "64kb" }));

/** Loads a consultation for a staff action; sends the failure itself. */
function staffCtx(req: express.Request, res: express.Response, roles?: ("admin" | "officer" | "moderator" | "panel")[]): { c: ConsultationRow; role: "admin" | "officer" | "moderator" | "panel" } | null {
  const c = getConsultation(req.params.id);
  if (!visible(c)) { fail(res, 404, "not_found"); return null; }
  const role = staffRole(req.person!.id, c);
  if (!role || (roles && !roles.includes(role))) { fail(res, 403, "forbidden"); return null; }
  return { c, role };
}

reportRouter.get("/:id/analyst", requireAuth, wrap((req, res) => {
  const s = staffCtx(req, res); if (!s) return;
  const clusters = commentClusters(s.c);
  const text = new Map((cdb().prepare("SELECT id, comment FROM consultation_feedback WHERE consultation_id = ? AND comment IS NOT NULL").all(s.c.id) as unknown as { id: string; comment: string }[]).map((r) => [r.id, r.comment]));
  audit(req.person!.id, "consultation.analyst.read", "consultation:" + s.c.id, {});
  res.setHeader("Cache-Control", "no-store");
  res.json({
    consultation_id: s.c.id, flags: antiAstroturf(s.c),
    // a cluster is ONE item for the analyst: a count, the window and the representative text; the other copies are not listed
    clusters: clusters.map((x) => ({ clause: x.clause, size: x.size, flagged: x.flagged, first_at: x.first_at, last_at: x.last_at, span_seconds: x.span_seconds, representative: { feedback_id: x.representative_id, text: text.get(x.representative_id) ?? null } })),
    coverage: reviewCoverage(s.c), suggested_sample: suggestSample(s.c), themes: themesOf(s.c.id), ...disclaimer(),
  });
}));

reportRouter.post("/:id/review/comments", requireAuth, wrap((req, res) => {
  const s = staffCtx(req, res); if (!s) return;
  if (reportRow(s.c.id)) return fail(res, 409, "report_published");
  const ids = Array.isArray(req.body?.feedback_ids) ? (req.body.feedback_ids as unknown[]).map(str).filter(Boolean).slice(0, 500) : [];
  if (!ids.length) return fail(res, 400, "feedback_ids_required");
  const now = registryNow();
  let recorded = 0;
  runInStore("survey", () => {
    for (const id of ids) {
      if (!cdb().prepare("SELECT 1 AS x FROM consultation_feedback WHERE id = ? AND consultation_id = ? AND comment IS NOT NULL AND comment <> ''").get(id, s.c.id)) continue;
      recorded += Number(cdb().prepare("INSERT OR IGNORE INTO consultation_comment_reviews (id, consultation_id, feedback_id, reviewer_pseudonym, reviewer_role, at) VALUES (?,?,?,?,?,?)")
        .run(crypto.randomUUID(), s.c.id, id, consultActor(req.person!.id), s.role, iso(now)).changes);
    }
    audit(req.person!.id, "consultation.review.comments", "consultation:" + s.c.id, { recorded });
  });
  res.json({ recorded, coverage: reviewCoverage(s.c) });
}));

reportRouter.post("/:id/review/run", requireAuth, wrap(async (req, res) => {
  const s = staffCtx(req, res, ["admin", "officer"]); if (!s) return;
  if (reportRow(s.c.id)) return fail(res, 409, "report_published");
  const r = await runReviewer(s.c, registryNow());
  audit(req.person!.id, "consultation.review.run", "consultation:" + s.c.id, { reviewer: r.reviewer, summarised: r.summarised });
  res.json({ ...r, coverage: reviewCoverage(s.c), note: r.kind === "none" ? "No machine reviewer is installed: nothing was summarised." : undefined });
}));

reportRouter.post("/:id/themes", requireAuth, wrap((req, res) => {
  const s = staffCtx(req, res, ["admin", "officer", "moderator"]); if (!s) return;
  if (reportRow(s.c.id)) return fail(res, 409, "report_published");
  const label_en = trim(req.body?.label_en, lim("max_theme_chars") + 1), label_te = trim(req.body?.label_te, lim("max_theme_chars") + 1) || null;
  if (label_en.length < 3 || label_en.length > lim("max_theme_chars") || (label_te && label_te.length > lim("max_theme_chars"))) return fail(res, 400, "theme_invalid");
  let clause: number | null = null;
  if (req.body?.clause !== undefined && req.body?.clause !== null) {
    clause = Number(req.body.clause);
    if (!currentContent(s.c).clauses.some((x) => x.n === clause)) return fail(res, 400, "clause_invalid");
  }
  const id = crypto.randomUUID();
  cdb().prepare("INSERT INTO consultation_themes (id, consultation_id, clause_n, label_en, label_te, source, author_role, at) VALUES (?,?,?,?,?, 'human', ?, ?)").run(id, s.c.id, clause, label_en, label_te, s.role, iso(registryNow()));
  res.status(201).json({ id, clause, label_en, label_te, source: "human" });
}));

reportRouter.get("/:id/closing-report", wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const r = reportRow(c.id);
  if (!r) return fail(res, 404, "report_not_published", { closing_report: reportState(c, registryNow()) });
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.json({ report: JSON.parse(r.snapshot_json), snapshot_hash: r.snapshot_hash, published_at: r.published_at, hash_algorithm: "sha256(canonical JSON of report)", ...disclaimer() });
}));

reportRouter.get("/:id/closing-report/preview", requireAuth, wrap((req, res) => {
  const s = staffCtx(req, res); if (!s) return;
  if (s.c.status !== "closed" && s.c.status !== "completed") return fail(res, 409, "not_closed", { status: s.c.status });
  const b = buildReport(s.c, registryNow());
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...b, closing_report: reportState(s.c, registryNow()) });
}));

reportRouter.post("/:id/closing-report/responses", requireAuth, wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  const me = req.person!.id, d = officerDepartment(me);
  if (!hasRole(me, "officer") || !d || d.trim().toLowerCase() !== c.department.trim().toLowerCase()) return fail(res, 403, "department_officer_required");
  if (c.status !== "closed") return fail(res, 409, "not_closed", { status: c.status });
  if (reportRow(c.id)) return fail(res, 409, "report_published");
  const n = Number(req.body?.clause), kind = str(req.body?.kind);
  if (!currentContent(c).clauses.some((x) => x.n === n)) return fail(res, 400, "clause_invalid");
  if (kind !== "response" && kind !== "no_change") return fail(res, 400, "kind_invalid", { kinds: ["response", "no_change"] });
  const text_en = trim(req.body?.text_en, 1500), text_te = trim(req.body?.text_te, 1500) || null;
  if (text_en.length < lim("min_response_chars")) return fail(res, 400, kind === "no_change" ? "reasons_required" : "response_required", { min_chars: lim("min_response_chars") });
  runInStore("survey", () => {
    cdb().prepare(`INSERT INTO consultation_responses (id, consultation_id, clause_n, kind, text_en, text_te, author_pseudonym, at) VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(consultation_id, clause_n) DO UPDATE SET kind = excluded.kind, text_en = excluded.text_en, text_te = excluded.text_te, author_pseudonym = excluded.author_pseudonym, at = excluded.at`)
      .run(crypto.randomUUID(), c.id, n, kind, text_en, text_te, consultActor(me), iso(registryNow()));
    audit(me, "consultation.report.response", "consultation:" + c.id, { clause: n, kind });
  });
  res.json({ ok: true, clause: n, kind });
}));

reportRouter.post("/:id/closing-report/publish", requireRole("admin", "survey_panel"), wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = getConsultation(req.params.id);
  if (!visible(c)) return fail(res, 404, "not_found");
  if (c.status !== "closed") return fail(res, 409, "not_closed", { status: c.status });
  if (reportRow(c.id)) return fail(res, 409, "report_published");
  const conflict = reviewerConflict(me, consultActor(me), c.creator_pseudonym, "government", null, c.department);
  if (conflict) return fail(res, 403, "reviewer_conflict", { reason: conflict });
  const b = buildReport(c, now);
  if (b.missing.length) return fail(res, 409, "closing_report_incomplete", { missing: b.missing });
  const json = canonicalJson(b.snapshot), hash = sha256(json);
  runInStore("survey", () => {
    cdb().prepare("INSERT INTO consultation_reports (consultation_id, status, snapshot_json, snapshot_hash, publisher_pseudonym, published_at) VALUES (?, 'published', ?,?,?,?)").run(c.id, json, hash, consultActor(me), iso(now));
    logEvent(c.id, "report_published", { snapshot_hash: hash }, now);
    audit(me, "consultation.report.publish", "consultation:" + c.id, { snapshot_hash: hash });
  });
  res.json({ id: c.id, published: true, snapshot_hash: hash, published_at: iso(now) });
}));

reportRouter.post("/:id/complete", requireAuth, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = getConsultation(req.params.id);
  if (!c || c.status === "draft") return fail(res, 404, "not_found");
  if (!isOwner(me, c)) return fail(res, 403, "owner_only");
  if (c.status === "completed") return fail(res, 409, "already_completed");
  if (c.status !== "closed") return fail(res, 409, "not_closed", { status: c.status });
  if (!reportRow(c.id)) return fail(res, 409, "closing_report_required", { closing_report: reportState(c, now), hint: "a consultation cannot be completed without a published closing report" });
  runInStore("survey", () => {
    cdb().prepare("UPDATE consultations SET status = 'completed', completed_at = ? WHERE id = ?").run(iso(now), c.id);
    logEvent(c.id, "completed", {}, now);
    audit(me, "consultation.complete", "consultation:" + c.id, {});
  });
  res.json({ id: c.id, status: "completed", completed_at: iso(now) });
}));
