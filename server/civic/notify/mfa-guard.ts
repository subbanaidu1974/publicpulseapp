/** TOTP guard for notify admin routes (same rules as admin/routes.ts requireMfa: header x-totp-code or body totp, or a one-time recovery code). */
import type { NextFunction, Request, Response } from "express";
import { audit } from "../core";
import { rateAllow } from "../identity/service";
import { mfaStatus, verifyMfa } from "../admin/mfa";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
export function confirmMfaGuard(req: Request, res: Response, next: NextFunction): void {
  const id = req.person!.id;
  if (!rateAllow("mfa:" + id, 10, 15 * 60 * 1000)) return void res.status(429).json({ error: "too many MFA attempts; wait and retry" });
  if (!mfaStatus(id).confirmed) return void res.status(403).json({ error: "multi-factor authentication must be set up first (POST /admin/mfa/enrol)", code: "mfa_enrol_required" });
  const code = str(req.headers["x-totp-code"] || req.body?.totp).replace(/\s/g, "");
  const recovery = str(req.headers["x-recovery-code"] || req.body?.recovery_code);
  if (!code && !recovery) return void res.status(403).json({ error: "a current authenticator code is required (x-totp-code)", code: "mfa_required" });
  if (!verifyMfa(id, { code, recovery }).ok) { audit(id, "admin.mfa.failed", "person:" + id, {}); return void res.status(403).json({ error: "invalid or reused authenticator code", code: "mfa_invalid" }); }
  next();
}
