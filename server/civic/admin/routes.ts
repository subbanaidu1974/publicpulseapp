/**
 * Admin API (S-140) mounted at /api/v1/civic/admin, and the public audit transparency API (S-144) mounted at /api/v1/civic/audit.
 *
 * Roles are changed only through DUAL CONTROL: an admin (with a TOTP code) files a request; a DIFFERENT admin (with their own TOTP code)
 * approves it, and only then is the role granted or revoked. Requests expire after 72 hours. Every step is audited and every list read
 * is logged as a privileged read. Bootstrap the first two admins with ops tooling (`grantRole("system", ...)`).
 *
 *  GET  /admin/me                         any signed-in person: own roles (+ scope, department) and MFA state
 *  POST /admin/mfa/enrol                  admin: start TOTP enrolment -> {secret, otpauth_uri, recovery_codes} (shown once)
 *  POST /admin/mfa/confirm|verify {code} admin: finish enrolment with the first code (verify also checks a code once enrolled)
 *  (/admin/role-requests is an alias of /admin/roles/requests)
 *  GET  /admin/roles?person_id=&role=     admin: current role holders (privileged read)
 *  GET  /admin/roles/requests?status=     admin: dual-control queue (privileged read)
 *  POST /admin/roles/requests             admin + MFA: {action: grant|revoke, person_id, role, jurisdiction?, department?, reason}
 *  POST /admin/roles/requests/:id/approve admin + MFA, not the requester
 *  POST /admin/roles/requests/:id/reject  admin + MFA (the requester may withdraw)
 *  MFA is sent as header `x-totp-code: 123456` (or body `totp`), or a one-time `recovery_code`.
 *
 *  GET /audit/head                        public: latest hash, entry count, anchor info
 *  GET /audit/entries?from=&limit=        public, redacted: seq, hour bucket, action class, hashes (no actor/object/meta)
 *  GET /audit/verify                      public: chain check + local head vs last anchored value (+ the witness's own copy when reachable)
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import {
  ROLE_NAMES, anchorStatus, audit, auditHead, auditPrivilegedRead, auditPublicEntries, getAnchorSink, getDb, getStore, grantRole, hasRole, listRoles, listRolesDetailed,
  requireRole, requireAuth, revokeRole, runInTransaction,
} from "../core";
import type { RoleName } from "../core";
import { rateAllow } from "../identity/service";
import { confirmMfa, enrolMfa, mfaStatus, verifyMfa } from "./mfa";

export * from "./mfa";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const REQUEST_TTL_MS = 72 * 60 * 60 * 1000;
const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { res.status(status).json({ error, ...extra }); };
const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (e) { if (!res.headersSent) fail(res, 500, "internal error"); void e; }
};

/** Requires a valid TOTP (or recovery) code from the signed-in admin on the request. */
function requireMfa(req: Request, res: Response, next: NextFunction): void {
  const pid = req.person!.id;
  if (!rateAllow("mfa:" + pid, 10, 15 * 60 * 1000)) return void fail(res, 429, "too many MFA attempts; wait and retry");
  const st = mfaStatus(pid);
  if (!st.confirmed) return void fail(res, 403, "multi-factor authentication must be set up first (POST /admin/mfa/enrol)", { code: "mfa_enrol_required" });
  const code = str(req.headers["x-totp-code"] || req.body?.totp).replace(/\s/g, "");
  const recovery = str(req.headers["x-recovery-code"] || req.body?.recovery_code);
  if (!code && !recovery) return void fail(res, 403, "a current authenticator code is required (x-totp-code)", { code: "mfa_required" });
  const r = verifyMfa(pid, { code, recovery });
  if (!r.ok) { audit(pid, "admin.mfa.failed", "person:" + pid, {}); return void fail(res, 403, "invalid or reused authenticator code", { code: "mfa_invalid" }); }
  next();
}

export const adminRouter = Router();
adminRouter.use(express.json({ limit: "10kb" }));

adminRouter.get("/me", requireAuth, wrap((req, res) => {
  const pid = req.person!.id;
  const detailed = listRolesDetailed(pid);
  const details = [...detailed.map((r) => ({ role: r.role, jurisdiction: r.jurisdiction, department: r.department }))];
  for (const r of listRoles(pid)) if (!details.some((x) => x.role === r.role)) details.push({ role: r.role, jurisdiction: r.jurisdiction, department: null }); // bridged (volunteer)
  const isAdmin = hasRole(pid, "admin");
  // roles = role names (empty for a plain citizen, so no console tabs show); role_details carries scope + department.
  res.json({ person_id: pid, roles: [...new Set(details.map((d) => d.role))], role_details: details, is_admin: isAdmin, mfa: mfaStatus(pid) });
}));

adminRouter.post("/mfa/enrol", requireRole("admin"), wrap((req, res) => {
  try { res.status(201).json(enrolMfa(req.person!.id)); } catch { fail(res, 409, "multi-factor authentication is already set up"); }
}));
adminRouter.post("/mfa/confirm", requireRole("admin"), wrap((req, res) => {
  if (!rateAllow("mfa:" + req.person!.id, 10, 15 * 60 * 1000)) return fail(res, 429, "too many attempts; wait and retry");
  if (!confirmMfa(req.person!.id, str(req.body?.code).replace(/\s/g, ""))) return fail(res, 400, "invalid code, or nothing to confirm");
  res.json({ ok: true, mfa: mfaStatus(req.person!.id) });
}));

adminRouter.post("/mfa/verify", requireRole("admin"), wrap((req, res) => {
  const pid = req.person!.id;
  if (!rateAllow("mfa:" + pid, 10, 15 * 60 * 1000)) return fail(res, 429, "too many attempts; wait and retry");
  const code = str(req.body?.code).replace(/\s/g, "");
  if (!mfaStatus(pid).confirmed) { if (!confirmMfa(pid, code)) return fail(res, 400, "invalid code, or nothing to confirm"); return void res.json({ ok: true, mfa: mfaStatus(pid) }); }
  const r = verifyMfa(pid, { code, recovery: str(req.body?.recovery_code) });
  if (!r.ok) return fail(res, 403, "invalid or reused authenticator code", { code: "mfa_invalid" });
  res.json({ ok: true, mfa: mfaStatus(pid) });
}));

adminRouter.get("/roles", requireRole("admin"), wrap((req, res) => {
  const where: string[] = ["p.deleted_at IS NULL"], args: string[] = [];
  const pid = str(req.query.person_id), role = str(req.query.role);
  if (pid) { where.push("r.person_id = ?"); args.push(pid); }
  if (role) { where.push("r.role = ?"); args.push(role); }
  const rows = getDb().prepare(
    `SELECT r.person_id, r.role, r.jurisdiction, r.department, r.granted_by, r.granted_at FROM roles r JOIN persons p ON p.id = r.person_id
      WHERE ${where.join(" AND ")} ORDER BY r.granted_at DESC LIMIT 200`).all(...args) as unknown as Record<string, string>[];
  auditPrivilegedRead(req.person!.id, "roles", "admin lists role holders");
  res.json({ roles: rows.map((r) => ({ ...r, jurisdiction: r.jurisdiction || null, department: r.department || null })) });
}));

const publicRequest = (r: Record<string, unknown>) => ({
  id: r.id, action: r.action, person_id: r.person_id, role: r.role, jurisdiction: r.jurisdiction || null, department: r.department || null, reason: r.reason,
  requested_by: r.requested_by, status: r.status, created_at: r.created_at, expires_at: r.expires_at, decided_by: r.decided_by ?? null, decided_at: r.decided_at ?? null,
});
function expireRequests(): void {
  getDb().prepare("UPDATE role_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(new Date().toISOString());
}

adminRouter.get(["/roles/requests", "/role-requests"], requireRole("admin"), wrap((req, res) => {
  expireRequests();
  const status = str(req.query.status) || "pending";
  const rows = getDb().prepare("SELECT * FROM role_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200").all(status) as unknown as Record<string, unknown>[];
  auditPrivilegedRead(req.person!.id, "role_requests", "admin lists dual-control queue");
  res.json({ requests: rows.map(publicRequest) });
}));

adminRouter.post(["/roles/requests", "/role-requests"], requireRole("admin"), requireMfa, wrap((req, res) => {
  const me = req.person!.id;
  const action = str(req.body?.action), personId = str(req.body?.person_id), role = str(req.body?.role) as RoleName;
  const jurisdiction = str(req.body?.jurisdiction).slice(0, 64), department = str(req.body?.department).slice(0, 64), reason = str(req.body?.reason).trim();
  if (action !== "grant" && action !== "revoke") return fail(res, 400, "action must be grant or revoke");
  if (!ROLE_NAMES.includes(role)) return fail(res, 400, "unknown role", { roles: ROLE_NAMES });
  if (reason.length < 5 || reason.length > 300) return fail(res, 400, "reason (5 to 300 characters) is required");
  const d = getDb();
  if (!d.prepare("SELECT 1 AS x FROM persons WHERE id = ? AND deleted_at IS NULL").get(personId)) return fail(res, 404, "person not found");
  if (action === "grant" && personId === me) return fail(res, 403, "you cannot request a role for yourself", { code: "self_grant" });
  expireRequests();
  if (d.prepare("SELECT 1 AS x FROM role_requests WHERE status = 'pending' AND action = ? AND person_id = ? AND role = ? AND jurisdiction = ?").get(action, personId, role, jurisdiction)) {
    return fail(res, 409, "an identical request is already waiting for approval");
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  d.prepare("INSERT INTO role_requests (id, action, person_id, role, jurisdiction, department, reason, requested_by, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)")
    .run(id, action, personId, role, jurisdiction, department, reason, me, new Date(now).toISOString(), new Date(now + REQUEST_TTL_MS).toISOString());
  audit(me, "admin.role_request.create", "person:" + personId, { request: id, action, role, jurisdiction });
  res.status(201).json({ id, status: "pending", expires_at: new Date(now + REQUEST_TTL_MS).toISOString() });
}));

adminRouter.post(["/roles/requests/:id/approve", "/role-requests/:id/approve"], requireRole("admin"), requireMfa, wrap((req, res) => {
  const me = req.person!.id;
  expireRequests();
  const r = getDb().prepare("SELECT * FROM role_requests WHERE id = ?").get(str(req.params.id)) as unknown as Record<string, string> | undefined;
  if (!r) return fail(res, 404, "request not found");
  if (r.status === "expired") return fail(res, 410, "request expired", { code: "request_expired" });
  if (r.status !== "pending") return fail(res, 409, `request already ${r.status}`);
  if (r.requested_by === me) { audit(me, "admin.role_request.self_approval_refused", "request:" + r.id, {}); return fail(res, 403, "a different admin must approve this request", { code: "dual_control" }); }
  try {
    runInTransaction(() => {
      if (r.action === "grant") grantRole(me, r.person_id, r.role as RoleName, r.jurisdiction || null, r.department || null);
      else {
        if (r.role === "admin" && (getDb().prepare("SELECT COUNT(DISTINCT person_id) AS c FROM roles WHERE role = 'admin'").get() as { c: number }).c <= 1) throw new Error("last_admin");
        revokeRole(me, r.person_id, r.role as RoleName);
      }
      getDb().prepare("UPDATE role_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(me, new Date().toISOString(), r.id);
      audit(me, "admin.role_request.approve", "person:" + r.person_id, { request: r.id, requested_by: r.requested_by, action: r.action, role: r.role });
    });
  } catch (e) {
    if ((e as Error).message === "last_admin") return fail(res, 409, "cannot revoke the last admin", { code: "last_admin" });
    throw e;
  }
  res.json({ ok: true, status: "approved" });
}));

adminRouter.post(["/roles/requests/:id/reject", "/role-requests/:id/reject"], requireRole("admin"), requireMfa, wrap((req, res) => {
  const me = req.person!.id;
  expireRequests();
  const r = getDb().prepare("SELECT * FROM role_requests WHERE id = ?").get(str(req.params.id)) as unknown as Record<string, string> | undefined;
  if (!r) return fail(res, 404, "request not found");
  if (r.status !== "pending") return fail(res, 409, `request already ${r.status}`);
  getDb().prepare("UPDATE role_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(me, new Date().toISOString(), r.id);
  audit(me, "admin.role_request.reject", "person:" + r.person_id, { request: r.id, requested_by: r.requested_by });
  res.json({ ok: true, status: "rejected" });
}));

// ---------------------------------------------------------------------------------------------
// Public audit transparency (S-144)
// ---------------------------------------------------------------------------------------------

export const auditRouter = Router();
const pubLimit = (name: string, limit: number) => (req: Request, res: Response, next: NextFunction): void => {
  if (!rateAllow(`auditpub:${name}:${req.ip || "?"}`, limit, 60 * 1000)) return void fail(res, 429, "too many requests; wait and retry");
  next();
};

auditRouter.get("/head", pubLimit("head", 120), wrap((_req, res) => {
  const h = auditHead();
  const a = anchorStatus();
  res.json({
    head: h ? { seq: h.seq, hash: h.hash, ts: h.ts } : null,
    count: h?.count ?? 0,
    anchor: { sink: a.sink, configured: a.sink !== "none", last: a.last_anchor, unanchored_entries: a.unanchored_entries },
  });
}));

auditRouter.get("/entries", pubLimit("entries", 60), wrap((req, res) => {
  res.json(auditPublicEntries(Number(req.query.from) || 1, Number(req.query.limit) || 200));
}));

auditRouter.get("/verify", pubLimit("verify", 6), wrap(async (_req, res) => {
  const a = anchorStatus();
  const sink = getAnchorSink();
  let witness: { reachable: boolean; seq?: number; hash?: string; matches_local?: boolean } | null = null;
  if (sink.fetchLast) {
    try {
      const w = await sink.fetchLast();
      if (w) {
        const row = getStore("audit").prepare("SELECT hash FROM audit_log WHERE seq = ?").get(w.seq) as { hash: string } | undefined;
        witness = { reachable: true, seq: w.seq, hash: w.hash, matches_local: !!row && row.hash === w.hash };
      } else witness = { reachable: true };
    } catch { witness = { reachable: false }; }
  }
  const ok = a.chain_ok && a.anchor_matches_chain !== false && witness?.matches_local !== false;
  res.status(ok ? 200 : 409).json({ ok, ...a, witness });
}));
