/**
 * Webhook authentication for the telecom aggregator endpoints (S-56).
 *  - CIVIC_IVR_WEBHOOK_SECRET: each request carries `x-civic-timestamp` (epoch ms or s, within 5 minutes) and
 *    `x-civic-signature` = hex HMAC-SHA256 over `${timestamp}.${rawBody}`. A signature is accepted once (replay protected).
 *  - CIVIC_IVR_ALLOWED_IPS: comma list of source IPs accepted instead of a signature.
 *  - Neither configured: allowed only when NODE_ENV is not production (warning logged once); in production it fails closed.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { isProductionEnv } from "../guards";

export const WEBHOOK_SKEW_MS = 5 * 60_000;

export function webhookSignature(secret: string, timestamp: string | number, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

const ipOf = (req: Request) => String(req.ip ?? req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");

/** True when an authenticated aggregator is configured (so a call must carry its own aggregator call id). */
export const webhookAuthConfigured = (): boolean => !!process.env.CIVIC_IVR_WEBHOOK_SECRET || !!(process.env.CIVIC_IVR_ALLOWED_IPS ?? "").trim();

export function createWebhookAuth(now: () => number = () => Date.now()) {
  const seen = new Map<string, number>(); // signature -> expiry
  let warned = false;
  const reject = (res: Response, why: string) => { res.status(401).json({ error: "unauthorized", reason: why }); };

  return function webhookAuth(req: Request & { rawBody?: Buffer }, res: Response, next: NextFunction): void {
    const secret = process.env.CIVIC_IVR_WEBHOOK_SECRET;
    const ips = (process.env.CIVIC_IVR_ALLOWED_IPS ?? "").split(",").map((s) => s.trim().replace(/^::ffff:/i, "")).filter(Boolean);
    if (!secret && !ips.length) {
      if (isProductionEnv()) return reject(res, "webhook auth not configured");
      if (!warned && !process.env.VITEST) { warned = true; console.warn("[civic] WARNING: IVR webhooks are unauthenticated (set CIVIC_IVR_WEBHOOK_SECRET or CIVIC_IVR_ALLOWED_IPS); allowed because this is not production."); }
      return next();
    }
    if (ips.length && ips.includes(ipOf(req))) return next();
    if (secret) {
      const ts = String(req.headers["x-civic-timestamp"] ?? "");
      const sig = String(req.headers["x-civic-signature"] ?? "").toLowerCase();
      const n = Number(ts);
      if (!ts || !Number.isFinite(n) || !/^[0-9a-f]{64}$/.test(sig)) return reject(res, "missing signature");
      const tsMs = n < 1e11 ? n * 1000 : n;
      const t = now();
      if (Math.abs(t - tsMs) > WEBHOOK_SKEW_MS) return reject(res, "stale timestamp");
      const raw = req.rawBody ? req.rawBody.toString("utf8") : "";
      const want = webhookSignature(secret, ts, raw);
      const a = Buffer.from(want), b = Buffer.from(sig);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reject(res, "bad signature");
      for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
      if (seen.has(sig)) return reject(res, "replay");
      seen.set(sig, t + 2 * WEBHOOK_SKEW_MS);
      return next();
    }
    return reject(res, "source not allowed");
  };
}
