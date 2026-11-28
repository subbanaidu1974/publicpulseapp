/** TOTP guard for notify admin routes (same rules as admin/routes.ts requireMfa: header x-totp-code or body totp, or a one-time recovery code). */
import type { NextFunction, Request, Response } from "express";
import { audit } from "../core";
import { rateAllow } from "../identity/service";
import { mfaStatus, verifyMfa } from "../admin/mfa";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
export function confirmMfaGuard(req: Request, res: Response, next: NextFunction): void {
  check(req, res).then((ok) => { if (ok) next(); }, next);
}
async function check(req: Request, res: Response): Promise<boolean> {
  const id = req.person!.id;
  const no = (status: number, body: Record<string, unknown>): boolean => { res.status(status).json(body); return false; };
  if (!rateAllow("mfa:" + id, 10, 15 * 60 * 1000)) return no(429, { error: "too many MFA attempts; wait and retry" });
  if (!(await mfaStatus(id)).confirmed) return no(403, { error: "multi-factor authentication must be set up first (POST /admin/mfa/enrol)", code: "mfa_enrol_required" });
  const code = str(req.headers["x-totp-code"] || req.body?.totp).replace(/\s/g, "");
  const recovery = str(req.headers["x-recovery-code"] || req.body?.recovery_code);
  if (!code && !recovery) return no(403, { error: "a current authenticator code is required (x-totp-code)", code: "mfa_required" });
  if (!(await verifyMfa(id, { code, recovery })).ok) { audit(id, "admin.mfa.failed", "person:" + id, {}); return no(403, { error: "invalid or reused authenticator code", code: "mfa_invalid" }); }
  return true;
}
