/**
 * Aggregates, anti-astroturf analysis, review coverage and the closing-report snapshot (S-35 figures, S-36 a/b/c).
 *
 * Counting rule: ONE feedback row per (person, clause), so a person counts once per clause in every aggregate no matter how many
 * near-identical comments a campaign posts. Clusters are reported to analysts and in the closing report as sizes only; they never
 * add to or subtract from a figure. Aggregates reuse the Pulse Survey publishing helpers (k-suppression with complementary
 * suppression, minority merge, rounding, no live figures: ../surveys/publish).
 */
import crypto from "node:crypto";
import { getUnit } from "../geo/service";
import { accumulate, publishGate, publishTree, policyFromEnv, roundTo } from "../surveys/publish";
import type { AnswerRecord, PublishPolicy } from "../surveys/publish";
import { cdb } from "./schema";
import { clusterComments } from "./similarity";
import { currentContent } from "./registry";
import { STANCES, cfg, consultationPolicy, sha256 } from "./types";
import type { ConsultationRow } from "./types";
import { getCommentReviewer } from "./reviewer";

export interface FeedbackRow {
  id: string; clause_n: number; person_key: string; stance: string; comment: string | null; public_ok: number; mod_verdict: string;
  mandal: string | null; tier: string; created_at: string; updated_at: string;
}

const STANCE_IDS: string[] = [...STANCES];

/** Figures exist only after close + delay (never live), like survey figures. */
export function figuresGate(c: ConsultationRow, now: Date) {
  const closed = c.status === "closed" || c.status === "completed";
  return publishGate({ status: closed ? "closed" : c.status, closeAt: c.closed_at && Date.parse(c.closed_at) < Date.parse(c.closes_at) ? c.closed_at : c.closes_at, topic: "bill", state: c.scope_state, now });
}

const unitLabel = (lgd: string | null) => {
  if (!lgd) return { en: "Unassigned", te: null as string | null };
  const u = getUnit(lgd) as unknown as { name_en?: string; name_te?: string } | undefined;
  return { en: u?.name_en ?? lgd, te: u?.name_te ?? null };
};

function clauseFigures(c: ConsultationRow, n: number, pol: PublishPolicy) {
  const rows = cdb().prepare("SELECT stance, mandal FROM consultation_feedback WHERE consultation_id = ? AND clause_n = ?").all(c.id, n) as unknown as { stance: string; mandal: string | null }[];
  const recs: AnswerRecord[] = rows.map((r) => {
    const l = unitLabel(r.mandal);
    return { path: [{ id: c.scope_state, level: "state" }, { id: r.mandal ?? "unassigned", level: "mandal", label_en: l.en, label_te: l.te }], options: [r.stance], w: 1 };
  });
  const tree = publishTree(accumulate(recs), STANCE_IDS, pol);
  const root = tree.cells.find((x) => x.parent === null);
  return {
    clause: n, published: tree.published && !!root,
    participants: root ? root.n : null,
    stances: root ? root.unweighted.options.map((o) => ({ id: o.id, count: o.count, share: o.share })) : [],
    other: root?.unweighted.other ?? null,
    cells: tree.cells.map((x) => ({ id: x.id, level: x.level, parent: x.parent, label_en: x.label_en, label_te: x.label_te, n: x.n, hidden_children: x.hidden_children, stances: x.unweighted.options, other: x.unweighted.other ?? null })),
    suppressed_reason: tree.published ? null : "fewer_than_k_participants",
    stats: tree.stats,
  };
}

/** Participation and per-clause stance figures with k-suppression and rounding. `null` when the gate is shut. */
export function buildFigures(c: ConsultationRow, now: Date, env: NodeJS.ProcessEnv = process.env) {
  const gate = figuresGate(c, now);
  if (gate.ok === false) return { published: false as const, reason: gate.reason, due_at: gate.dueAt ?? null };
  const pol = policyFromEnv(env);
  const people = (cdb().prepare("SELECT COUNT(DISTINCT person_key) AS c FROM consultation_feedback WHERE consultation_id = ?").get(c.id) as { c: number }).c;
  const tiers = cdb().prepare("SELECT tier, COUNT(DISTINCT person_key) AS c FROM consultation_feedback WHERE consultation_id = ? GROUP BY tier").all(c.id) as unknown as { tier: string; c: number }[];
  const showParticipants = people >= pol.k;
  const tierOk = showParticipants && tiers.length > 0 && tiers.every((t) => t.c >= pol.k);
  const content = currentContent(c);
  return {
    published: true as const,
    consultation_id: c.id, version: c.version, content_hash: c.content_hash,
    participation: {
      participants: showParticipants ? roundTo(people, pol.roundTo) : null,
      suppressed: !showParticipants ? "fewer_than_k_participants" : null,
      by_tier: tierOk ? tiers.map((t) => ({ tier: t.tier, participants: roundTo(t.c, pol.roundTo) })) : null,
      by_tier_suppressed: tierOk ? null : "a_tier_cell_is_below_k",
      min_cell: pol.k, rounded_to: pol.roundTo,
    },
    clauses: content.clauses.map((cl) => clauseFigures(c, cl.n, pol)),
    weighted: { applied: false, reason: "no verified reference figures exist for consultation participants (no age or gender is collected); figures are unweighted" },
    counting_rule: "One feedback row per person and clause; near-duplicate comments never add to a count.",
    method_note: `Counts are rounded to a multiple of ${pol.roundTo}; cells with fewer than ${pol.k} participants are hidden and rolled up. Feedback is attributable to the platform account but published only in aggregate. A consultation is a signal, not a referendum.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Anti-astroturf
// ---------------------------------------------------------------------------------------------

const commentRows = (id: string, includeHeld = true) =>
  cdb().prepare(`SELECT id, clause_n, comment, mod_verdict, updated_at FROM consultation_feedback WHERE consultation_id = ? AND comment IS NOT NULL AND comment <> '' ${includeHeld ? "" : "AND mod_verdict <> 'hold'"} ORDER BY clause_n, updated_at, id`).all(id) as unknown as
    { id: string; clause_n: number; comment: string; mod_verdict: string; updated_at: string }[];

export interface ClusterInfo { clause: number; size: number; flagged: boolean; first_at: string; last_at: string; span_seconds: number; representative_id: string; ids: string[] }
export function commentClusters(c: ConsultationRow): ClusterInfo[] {
  const rows = commentRows(c.id);
  const out: ClusterInfo[] = [];
  const byClause = new Map<number, typeof rows>();
  for (const r of rows) (byClause.get(r.clause_n) ?? byClause.set(r.clause_n, []).get(r.clause_n)!).push(r);
  for (const [clause, list] of byClause) {
    const at = new Map(list.map((r) => [r.id, r.updated_at]));
    for (const cl of clusterComments(list.map((r) => ({ id: r.id, text: r.comment })), cfg.dupThreshold())) {
      const times = cl.ids.map((i) => at.get(i)!).sort();
      out.push({ clause, size: cl.size, flagged: cl.size >= cfg.clusterFlagMin(), first_at: times[0], last_at: times[times.length - 1], span_seconds: Math.round((Date.parse(times[times.length - 1]) - Date.parse(times[0])) / 1000), representative_id: cl.representative, ids: cl.ids });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

export function antiAstroturf(c: ConsultationRow) {
  const clusters = commentClusters(c);
  const bursts = cdb().prepare("SELECT minute, n, limited FROM consultation_burst WHERE consultation_id = ? AND (n >= ? OR limited > 0) ORDER BY minute").all(c.id, cfg.burstPerMin()) as unknown as { minute: string; n: number; limited: number }[];
  const limited = (cdb().prepare("SELECT COALESCE(SUM(limited),0) AS s FROM consultation_burst WHERE consultation_id = ?").get(c.id) as { s: number }).s;
  const peak = (cdb().prepare("SELECT COALESCE(MAX(n),0) AS m FROM consultation_burst WHERE consultation_id = ?").get(c.id) as { m: number }).m;
  return {
    clusters: clusters.map((x) => ({ clause: x.clause, size: x.size, flagged: x.flagged, first_at: x.first_at, last_at: x.last_at, span_seconds: x.span_seconds })),
    flagged_clusters: clusters.filter((x) => x.flagged).length,
    bursts: bursts.filter((b) => b.n >= cfg.burstPerMin()).map((b) => ({ minute: b.minute, feedback_in_minute: b.n })),
    burst_threshold_per_minute: cfg.burstPerMin(), peak_per_minute: peak,
    rate_limited_requests: limited,
    cluster_similarity_threshold: cfg.dupThreshold(), cluster_flag_min: cfg.clusterFlagMin(),
    counting_rule: "Each person counts once per clause; clustered comments never amplify an aggregate.",
  };
}

// ---------------------------------------------------------------------------------------------
// Review coverage
// ---------------------------------------------------------------------------------------------

export function reviewCoverage(c: ConsultationRow) {
  const n = (cdb().prepare("SELECT COUNT(*) AS c FROM consultation_feedback WHERE consultation_id = ? AND comment IS NOT NULL AND comment <> ''").get(c.id) as { c: number }).c;
  const human = (cdb().prepare("SELECT COUNT(*) AS c FROM consultation_comment_reviews r JOIN consultation_feedback f ON f.id = r.feedback_id WHERE r.consultation_id = ?").get(c.id) as { c: number }).c;
  const machine = (cdb().prepare("SELECT COUNT(*) AS c FROM consultation_machine_items m JOIN consultation_feedback f ON f.id = m.feedback_id WHERE m.consultation_id = ?").get(c.id) as { c: number }).c;
  const roles = (cdb().prepare("SELECT reviewer_role AS r, COUNT(*) AS c FROM consultation_comment_reviews WHERE consultation_id = ? GROUP BY reviewer_role ORDER BY r").all(c.id) as unknown as { r: string; c: number }[]);
  const machines = (cdb().prepare("SELECT reviewer_name AS r, COUNT(*) AS c FROM consultation_machine_items WHERE consultation_id = ? GROUP BY reviewer_name ORDER BY r").all(c.id) as unknown as { r: string; c: number }[]);
  const method = [
    `Comments are NOT all read by a person. ${human} of ${n} comments were read by a human reviewer (a sample: one representative per near-duplicate cluster plus a seeded random pick).`,
    machine > 0 ? `${machine} comments were summarised by machine-assisted tooling (${machines.map((m) => m.r).join(", ")}); a machine summary is a triage aid and was not a substitute for human reading.` : "No machine summarisation was used.",
  ].join(" ");
  return {
    comments_total: n, reviewed_by_human: human, machine_summarised: machine, unreviewed: Math.max(0, n - human),
    machine_assisted: machine > 0, method,
    human_reviewer_roles: roles.map((x) => ({ role: x.r, comments_read: x.c })),
    machine_methods: machines.map((x) => ({ method: x.r, comments_summarised: x.c })),
  };
}

/** Suggested human sample: one representative per cluster plus a seeded pick of the rest (the sample is a suggestion, only recorded reads count). */
export function suggestSample(c: ConsultationRow) {
  const rows = commentRows(c.id, false);
  const clusters = commentClusters(c);
  const inCluster = new Set(clusters.flatMap((x) => x.ids));
  const reps = clusters.map((x) => x.representative_id);
  const rest = rows.filter((r) => !inCluster.has(r.id)).map((r) => ({ id: r.id, k: sha256(c.id + r.id) })).sort((a, b) => (a.k < b.k ? -1 : 1));
  const want = Math.max(consultationPolicy().review_sample.min, Math.ceil(rows.length * consultationPolicy().review_sample.share));
  return { representatives: reps, random: rest.slice(0, Math.max(0, want - reps.length)).map((r) => r.id), target: want };
}

export async function runReviewer(c: ConsultationRow, now: Date): Promise<{ reviewer: string; kind: string; summarised: number; themes: number }> {
  const rv = getCommentReviewer();
  const items = commentRows(c.id, false).map((r) => ({ id: r.id, clause: r.clause_n, text: r.comment }));
  const out = await rv.review(items);
  const ids = new Set(items.map((i) => i.id));
  let s = 0, t = 0;
  if (rv.kind === "machine") {
    for (const id of out.summarised_ids ?? []) if (ids.has(id)) s += Number(cdb().prepare("INSERT OR IGNORE INTO consultation_machine_items (consultation_id, feedback_id, reviewer_name, at) VALUES (?,?,?,?)").run(c.id, id, rv.name, now.toISOString()).changes);
    for (const th of out.themes ?? []) {
      if (!th.label_en || String(th.label_en).length > 200) continue;
      cdb().prepare("INSERT INTO consultation_themes (id, consultation_id, clause_n, label_en, label_te, source, author_role, at) VALUES (?,?,?,?,?, 'reviewer', ?, ?)")
        .run(crypto.randomUUID(), c.id, th.clause ?? null, String(th.label_en).slice(0, 200), th.label_te ? String(th.label_te).slice(0, 200) : null, "machine:" + rv.name, now.toISOString());
      t++;
    }
  }
  return { reviewer: rv.name, kind: rv.kind, summarised: s, themes: t };
}

// ---------------------------------------------------------------------------------------------
// Closing report
// ---------------------------------------------------------------------------------------------

export const themesOf = (id: string) => (cdb().prepare("SELECT id, clause_n, label_en, label_te, source, author_role FROM consultation_themes WHERE consultation_id = ? ORDER BY at, rowid").all(id) as unknown as
  { id: string; clause_n: number | null; label_en: string; label_te: string | null; source: "human" | "reviewer"; author_role: string }[]);
export const responsesOf = (id: string) => cdb().prepare("SELECT clause_n, kind, text_en, text_te, at FROM consultation_responses WHERE consultation_id = ? ORDER BY clause_n").all(id) as unknown as
  { clause_n: number; kind: "response" | "no_change"; text_en: string; text_te: string | null; at: string }[];

/** Everything the closing report must contain, built fresh. `missing` lists what still blocks publication. */
export function buildReport(c: ConsultationRow, now: Date, env: NodeJS.ProcessEnv = process.env) {
  const content = currentContent(c);
  const fig = buildFigures(c, now, env);
  const responses = responsesOf(c.id);
  const themes = themesOf(c.id);
  const coverage = reviewCoverage(c);
  const missing: { code: string; clauses?: number[] }[] = [];
  if (fig.published === false) missing.push({ code: "figures_not_yet_publishable:" + fig.reason });
  const noResp = content.clauses.filter((cl) => !responses.some((r) => r.clause_n === cl.n)).map((cl) => cl.n);
  if (noResp.length) missing.push({ code: "department_response_required", clauses: noResp });
  if (coverage.comments_total > 0 && themes.length === 0) missing.push({ code: "themes_required" });
  const snapshot = {
    consultation: { id: c.id, department: c.department, title_en: c.title_en, title_te: c.title_te, bill_ref: c.bill_ref, source_url: c.source_url, version: c.version, content_hash: c.content_hash, opens_at: c.opens_at, closes_at: c.closes_at, closed_at: c.closed_at },
    built_at: now.toISOString(),
    participation: fig.published ? fig.participation : null,
    clauses: content.clauses.map((cl) => ({
      n: cl.n, summary_en: cl.summary_en, summary_te: cl.summary_te,
      figures: fig.published ? fig.clauses.find((x) => x.clause === cl.n) ?? null : null,
      themes: themes.filter((t) => t.clause_n === cl.n).map((t) => ({ label_en: t.label_en, label_te: t.label_te, source: t.source, by: t.author_role })),
      department_response: responses.find((r) => r.clause_n === cl.n) ? (({ kind, text_en, text_te, at }) => ({ kind, text_en, text_te, at }))(responses.find((r) => r.clause_n === cl.n)!) : null,
    })),
    themes: themes.filter((t) => t.clause_n === null).map((t) => ({ label_en: t.label_en, label_te: t.label_te, source: t.source, by: t.author_role })),
    anti_astroturf: antiAstroturf(c),
    review_coverage: coverage,
    method_note: fig.published ? fig.method_note : null,
    signal_not_referendum: true,
  };
  return { snapshot, missing };
}
