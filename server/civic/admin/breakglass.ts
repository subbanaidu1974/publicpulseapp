/**
 * Break-glass admin API wiring (S-163). The dual-control engine is providers/breakglass.ts (S-64); this file binds ONE instance of it to the
 * installed key provider and maps its errors to HTTP answers.
 *
 *   POST /admin/breakglass/requests                {purpose, version?, reason}  admin + TOTP: request (reason of at least 10 characters)
 *   GET  /admin/breakglass/requests                admin: every request, newest first (privileged read; no key material)
 *   POST /admin/breakglass/requests/:id/approve    admin + TOTP, not the requester, each admin once; two approvals make it usable
 *   POST /admin/breakglass/requests/:id/deny       admin + TOTP
 *   POST /admin/breakglass/requests/:id/export     admin + TOTP: ONE use, within 15 minutes of the request: the data key wrapped under the
 *                                                  recovery KEK (CIVIC_KMS_RECOVERY_KEY_ID); the clear key never leaves the process
 *   GET  /audit/summary                            public: counts by action class and the break-glass counters (requests, approvals, denials, uses)
 *
 * Grants are held in memory on purpose (a restart cancels every open request); the audit log is the durable record. Without an envelope key
 * provider (the dev provider has none) every route answers 501.
 */
import { getKeys } from "../core";
import { BreakGlass } from "../providers/breakglass";
import type { BreakGlassAccess } from "../providers/keys";

let installed: BreakGlass | null = null;
let installedFor: unknown = null;

/** Tests, and ops code that wants a specific engine (custom clock, custom admin check). Pass null to forget it. */
export function setBreakGlass(bg: BreakGlass | null): void { installed = bg; installedFor = bg ? "explicit" : null; }

/** The engine for the installed key provider, created on first use (the provider hands out its break-glass capability only once). */
export function getBreakGlass(): BreakGlass | null {
  if (installedFor === "explicit") return installed;
  const k = getKeys() as unknown as { breakGlassAccess?: () => BreakGlassAccess };
  if (installed && installedFor === k) return installed;
  if (typeof k.breakGlassAccess !== "function") return null;
  try { installed = new BreakGlass({ access: k.breakGlassAccess() }); installedFor = k; return installed; } catch { return null; }
}

/** Map an engine error to an HTTP status and a stable code. */
export function breakGlassError(e: unknown): { status: number; error: string; code: string } {
  const m = (e as Error)?.message ?? "";
  if (/unknown break-glass request/.test(m)) return { status: 404, error: "request not found", code: "not_found" };
  if (/own break-glass/.test(m)) return { status: 403, error: "a different admin must approve this request", code: "dual_control" };
  if (/already approved/.test(m)) return { status: 409, error: "you already approved this request", code: "already_approved" };
  if (/only an admin/.test(m)) return { status: 403, error: "admin role required", code: "admin_required" };
  if (/request is expired/.test(m)) return { status: 410, error: "this request expired; file a new one", code: "request_expired" };
  if (/not usable: request is used/.test(m) || /request is used/.test(m)) return { status: 409, error: "this grant was already used (single use)", code: "already_used" };
  if (/not usable|request is /.test(m)) return { status: 409, error: m.replace(/^break-glass is /, "").slice(0, 120), code: "not_ready" };
  if (/reason/.test(m)) return { status: 400, error: "a written reason of at least 10 characters is required", code: "reason_required" };
  if (/recovery KEK/.test(m)) return { status: 501, error: "no recovery KEK is configured (CIVIC_KMS_RECOVERY_KEY_ID)", code: "no_recovery_kek" };
  return { status: 500, error: "internal error", code: "error" };
}

/** What an admin sees of a request: ids and counts, never key material. */
export function publicBreakGlass(r: { id: string; purpose: string; version: number; requestedBy: string; reason: string; approvals: string[]; status: string; createdAt: number; expiresAt: number; mode?: string }) {
  return {
    id: r.id, purpose: r.purpose, version: r.version, requested_by: r.requestedBy, reason: r.reason, approvals: r.approvals.length, approved_by: r.approvals,
    status: r.status, created_at: new Date(r.createdAt).toISOString(), expires_at: new Date(r.expiresAt).toISOString(), mode: r.mode ?? null,
  };
}
