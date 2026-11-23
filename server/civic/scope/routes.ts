/**
 * Scoped dashboards (S-40, E2E-49) at /api/v1/civic/scope. READ-ONLY by construction: every route is GET, anything else is 405.
 * Nobody gets early access or individual data here: the surveys and export routes return exactly what the public routes return.
 * Matrix of who may call what: docs/ROLES.md (a test parses it).
 *
 *  GET /scope/me                       any signed-in person: own roles, scope, and which dashboards they may open
 *  GET /scope/issues/summary?unit=     politician | officer | journalist | admin: issue counts at the caller's scope, cells under 30 withheld
 *  GET /scope/surveys/summary          politician | officer | journalist | eci_liaison | admin: the PUBLISHED survey figures (same as /surveys/:id/results)
 *  GET /scope/audit/summary            eci_liaison | admin: audit head, anchors, job health, block-log counts (no actor ids)
 *  GET /scope/export?format=&cursor=   journalist: byte-identical to GET /issues/export (same rows, same headers)
 */
import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { anchorStatus, audit, auditHead, auditPrivilegedRead, getStore, listRolesDetailed, requireAuth } from "../core";
import type { RoleName } from "../core";
import { jobsStatus } from "../jobs";
import { MIN_CELL } from "../issues/service";
import * as pub from "../issues/public";
import { ancestors, getUnit } from "../geo/service";
import { isPoliticalTopic } from "../surveys/publish";
import { registryNow } from "../surveys/types";
import { surveysAllowed } from "../../window";
import { describeUnit, grantsOf, scopeCovers, unitsReaching } from "./model";
import type { Grant } from "./model";

declare module "express-serve-static-core" {
  interface Request { scope?: { role: RoleName; grant: Grant; unit: string | null; department: string | null } }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, 64) : "");
const deny = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { res.status(status).json({ error, ...extra }); };

/** Record a refusal (who, what unit, which rule) in the audit log. The unit code is a public identifier, never personal data. */
function denied(req: Request, res: Response, roles: RoleName[], unit: string | null, reason: "role_required" | "outside_scope" | "department_mismatch" | "unknown_unit", status: number): void {
  audit(req.person?.id ?? "anonymous", "scope.denied", "unit:" + (unit ?? "-"), { roles: roles.join("|"), reason, method: req.method });
  if (reason === "role_required") return deny(res, status, "forbidden", { code: reason });
  deny(res, status, reason, { code: reason });
}

/**
 * Middleware factory. Authenticates, then needs one of `roles` whose grant reaches the unit asked for (`unitFromReq`; null/empty = the
 * caller's own scope). Sets req.scope. 403 `outside_scope` when a grant exists but does not reach the unit; officers must also match the
 * department when their grant names one. Every refusal is audited.
 */
export function requireScope(roles: RoleName | RoleName[], unitFromReq: (req: Request) => string | null | undefined, opts: { department?: (req: Request) => string | null | undefined; asOf?: (req: Request) => string | undefined } = {}): RequestHandler {
  const list = Array.isArray(roles) ? roles : [roles];
  return (req: Request, res: Response, next: NextFunction): void => {
    requireAuth(req, res, () => {
      const pid = req.person!.id;
      const grants = list.flatMap((r) => grantsOf(pid, r));
      const asked = (unitFromReq(req) ?? "").trim() || null;
      if (!grants.length) return denied(req, res, list, asked, "role_required", 403);
      const asOf = opts.asOf?.(req);
      const dept = (opts.department?.(req) ?? "").trim() || null;
      // Default unit: the caller's own jurisdiction (the first scoped grant), else "everything" (state-level).
      const own = grants.find((g) => g.jurisdiction)?.jurisdiction ?? null;
      const unit = asked ?? own;
      let sawOutside = false, sawDept = false;
      for (const g of grants) {
        if (unit && !scopeCovers(g, unit, asOf)) { sawOutside = true; continue; }
        if (!unit && g.role === "politician") { sawOutside = true; continue; }
        if (g.department && dept && g.department.toLowerCase() !== dept.toLowerCase()) { sawDept = true; continue; }
        if (unit && !unitsReaching(unit, asOf)) return denied(req, res, list, unit, "unknown_unit", 400);
        req.scope = { role: g.role, grant: g, unit, department: dept ?? g.department };
        return next();
      }
      if (sawDept && !sawOutside) return denied(req, res, list, unit, "department_mismatch", 403);
      denied(req, res, list, unit, "outside_scope", 403);
    });
  };
}

export const scopeRouter = Router();
scopeRouter.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  res.set("Allow", "GET, HEAD");
  deny(res, 405, "read_only", { notice_en: "These dashboards are read-only." });
});
scopeRouter.use((_req, res, next) => { res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); next(); });

// ---------------------------------------------------------------------------------------------
// capabilities (the single place that says who may open what; docs/ROLES.md is the readable copy and a test keeps them equal)
// ---------------------------------------------------------------------------------------------
export const DASHBOARDS = {
  issues_summary: ["politician", "officer", "journalist", "admin"],
  surveys_summary: ["politician", "officer", "journalist", "eci_liaison", "admin"],
  audit_summary: ["eci_liaison", "admin"],
  export: ["journalist"],
} as const satisfies Record<string, readonly RoleName[]>;
export type Dashboard = keyof typeof DASHBOARDS;

scopeRouter.get("/me", requireAuth, (req, res) => {
  const held = listRolesDetailed(req.person!.id).filter((r) => ["politician", "officer", "journalist", "eci_liaison", "admin"].includes(r.role));
  const names = new Set(held.map((r) => r.role as string));
  const roles = held.map((r) => ({ role: r.role, jurisdiction: r.jurisdiction, department: r.department, unit: r.jurisdiction ? describeUnit(getUnit(r.jurisdiction)) : null, scope: r.jurisdiction ? "unit" : r.role === "politician" ? "none" : "state" }));
  const can = Object.fromEntries((Object.keys(DASHBOARDS) as Dashboard[]).map((d) => [d, (DASHBOARDS[d] as readonly string[]).some((r) => names.has(r))]));
  res.json({ roles, can, read_only: true, early_access: false, individual_data: false, min_cell: MIN_CELL, notice_en: "You see the same published data as everyone, within your scope.", notice_te: "మీ పరిధిలో అందరికీ కనిపించే ప్రచురిత సమాచారమే మీకు కనిపిస్తుంది." });
});

// ---------------------------------------------------------------------------------------------
// issues summary
// ---------------------------------------------------------------------------------------------
const FILTER_KEY: Record<string, string> = { village: "village", mandal: "mandal", district: "district", constituency: "constituency" };
const CLOSED = new Set(["Resolved", "Confirmed", "Closed", "Rejected", "Withdrawn"]);
const MAX_PAGES = 20;

scopeRouter.get("/issues/summary", requireScope(["politician", "officer", "journalist", "admin"], (r) => str(r.query.unit), { department: (r) => str(r.query.department) }), (req, res) => {
  const sc = req.scope!;
  const unit = sc.unit ? getUnit(sc.unit) : null;
  if (sc.unit && !unit) return deny(res, 400, "unknown_unit");
  auditPrivilegedRead(req.person!.id, "scope:issues_summary:" + (sc.unit ?? "state"), "scoped dashboard read (" + sc.role + ")");
  const key = unit ? FILTER_KEY[unit.level] : undefined;
  const byDept = new Map<string, { total: number; open: number; resolved: number; by_status: Record<string, number> }>();
  let cursor: string | undefined, truncated = false;
  const reach = new Map<string, boolean>();
  for (let page = 0; ; page++) {
    const { rows, next_cursor } = pub.exportRows({ ...(key && unit ? { [key]: unit.lgd } : {}), ...(cursor ? { cursor } : {}) });
    for (const r of rows as Record<string, any>[]) {
      if (unit && !key) { // state level: no query filter exists, so test the village against the unit's descendants
        let ok = reach.get(r.village_lgd);
        if (ok === undefined) { ok = ancestors(r.village_lgd).some((a) => a.lgd === unit.lgd); reach.set(r.village_lgd, ok); }
        if (!ok) continue;
      }
      if (sc.department && sc.role === "officer" && String(r.department).toLowerCase() !== sc.department.toLowerCase()) continue;
      const c = byDept.get(r.department) ?? { total: 0, open: 0, resolved: 0, by_status: {} };
      c.total++;
      if (!CLOSED.has(r.status)) c.open++;
      if (r.status === "Resolved" || r.status === "Confirmed") c.resolved++;
      c.by_status[r.status] = (c.by_status[r.status] ?? 0) + 1;
      byDept.set(r.department, c);
    }
    if (!next_cursor) break;
    cursor = next_cursor;
    if (page >= MAX_PAGES - 1) { truncated = true; break; }
  }
  const cells: unknown[] = [], masked: string[] = [];
  let shown = 0;
  for (const [department, c] of [...byDept].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (c.total >= MIN_CELL) { cells.push({ department, ...c, resolution_rate: Math.round((c.resolved / c.total) * 100) / 100 }); shown += c.total; }
    else masked.push(department);
  }
  // Withheld cells are named but never counted; the total only sums the shown cells so it cannot be subtracted to recover a small cell.
  res.json({ role: sc.role, unit: describeUnit(unit), department: sc.department, min_cell: MIN_CELL, cells, masked: masked.map((department) => ({ department, reason: `fewer than ${MIN_CELL} reports` })), total_shown: shown, truncated });
});

// ---------------------------------------------------------------------------------------------
// surveys: the public list of published figures, nothing earlier
// ---------------------------------------------------------------------------------------------
scopeRouter.get("/surveys/summary", requireScope(["politician", "officer", "journalist", "eci_liaison", "admin"], () => null), (_req, res) => {
  const now = registryNow();
  let rows: { survey_id: string; topic_class: string; state: string; sha256: string; published_at: string }[] = [];
  try { rows = getStore("survey").prepare("SELECT survey_id, topic_class, state, sha256, published_at FROM survey_results ORDER BY published_at DESC LIMIT 200").all() as unknown as typeof rows; } catch { /* survey store not migrated */ }
  const published = rows.filter((r) => !(isPoliticalTopic(r.topic_class as never) && !surveysAllowed(r.state as never, now))) // the same fail-closed gate as the public route
    .map((r) => ({ survey_id: r.survey_id, topic_class: r.topic_class, state: r.state, snapshot_sha256: r.sha256, published_at: r.published_at, results_url: `/api/v1/civic/surveys/${encodeURIComponent(r.survey_id)}/results`, method_url: `/api/v1/civic/surveys/${encodeURIComponent(r.survey_id)}/results/method` }));
  res.json({ published, early_access: false, note_en: "Only figures already public are listed. Nobody sees results before they are published.", note_te: "ఇప్పటికే ప్రచురితమైన గణాంకాలు మాత్రమే ఇక్కడ ఉంటాయి. ప్రచురణకు ముందు ఎవరికీ ఫలితాలు కనిపించవు." });
});

// ---------------------------------------------------------------------------------------------
// audit and integrity (election commission liaison)
// ---------------------------------------------------------------------------------------------
scopeRouter.get("/audit/summary", requireScope(["eci_liaison", "admin"], () => null), (req, res) => {
  auditPrivilegedRead(req.person!.id, "scope:audit_summary", "integrity dashboard read (" + req.scope!.role + ")");
  const head = auditHead();
  const a = anchorStatus();
  const j = jobsStatus();
  let blocks: { action: string; n: number }[] = [];
  try { blocks = getStore("audit").prepare("SELECT action, COUNT(*) AS n FROM audit_log WHERE action LIKE '%block%' GROUP BY action ORDER BY action").all() as unknown as typeof blocks; } catch { /* audit store missing */ }
  res.json({
    head: head ? { seq: head.seq, hash: head.hash, ts: head.ts, count: head.count } : null,
    anchors: { sink: a.sink, last_anchor: a.last_anchor, anchor_matches_chain: a.anchor_matches_chain, unanchored_entries: a.unanchored_entries, chain_ok: a.chain_ok },
    jobs: { started: j.started, alarm: j.alarm ? { kind: j.alarm.kind, at: j.alarm.at } : null, jobs: j.jobs.map((x) => ({ name: x.name, runs: x.runs, failures: x.failures, lastOk: x.lastOk, lastRunAt: x.lastRunAt })) },
    block_log: { total: blocks.reduce((s, b) => s + b.n, 0), by_action: blocks },
    read_only: true,
  });
});

// ---------------------------------------------------------------------------------------------
// journalist bulk export: the SAME bytes as the public export
// ---------------------------------------------------------------------------------------------
scopeRouter.get("/export", requireScope("journalist", () => null), (req, res) => {
  const gate = pub.exportRateAllow("scope:" + req.person!.id);
  if (!gate.ok) { res.set("Retry-After", String(gate.retryAfterSec)); return deny(res, 429, "export rate limit reached", { retry_after_seconds: gate.retryAfterSec }); }
  const csv = String(req.query.format ?? "ndjson") === "csv";
  const { rows, next_cursor } = pub.exportRows(req.query);
  res.set({ "Content-Type": csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="issues.${csv ? "csv" : "ndjson"}"` });
  if (next_cursor) res.set("X-Next-Cursor", next_cursor);
  res.send(csv ? pub.toCsv(rows) : pub.toNdjson(rows));
});
