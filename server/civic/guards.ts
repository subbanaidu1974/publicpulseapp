/**
 * Production startup guards (S-55). `assertProductionSafe()` is called from createCivicRouter and throws when the process is
 * production (NODE_ENV=production or CIVIC_ENV=production) but would run on dev stand-ins. Unset NODE_ENV is treated as
 * non-production with a loud warning.
 */
import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";
import { isDevKeyProvider, isDevSmsProvider } from "./core";
import { isDevNumberIntelligence } from "./identity/service";
import { isDevAttestationVerifier } from "./identity/network";
import { getSmsGateway } from "./providers/sms";

export const isProductionEnv = (): boolean => process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production";

/** True when the request is addressed to this machine (localhost, 127.0.0.1, ::1). */
export function isLocalHost(req: Pick<Request, "hostname">): boolean {
  const h = String(req.hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

const generatedDir = () => process.env.CIVIC_GENERATED_DIR || path.resolve(process.cwd(), "data/generated");

/** Dataset files whose `provenance` is "demo" (fixtures). Missing or unreadable files are ignored. */
export function demoProvenance(): string[] {
  const out: string[] = [];
  for (const f of ["census.json", "elections.json"]) {
    try {
      const head = fs.readFileSync(path.join(generatedDir(), f), "utf8").slice(0, 4096);
      const m = /"provenance"\s*:\s*"([^"]*)"/.exec(head);
      if (m && /demo/i.test(m[1])) out.push(f);
    } catch { /* not present */ }
  }
  return out;
}

export function productionProblems(): string[] {
  const p: string[] = [];
  if (isDevKeyProvider()) p.push("dev key provider is the only key source (install an HSM/KMS provider with setKeyProvider, or set CIVIC_KMS_URL; CIVIC_DEV_MASTER_KEY is not acceptable)");
  if (isDevSmsProvider()) p.push("dev SMS provider is installed (use setSmsProvider with a DLT-registered provider, or set CIVIC_SMS_URL)");
  if (isDevAttestationVerifier() && process.env.CIVIC_ALLOW_NO_ATTESTATION !== "1") p.push("dev attestation verifier is active (install one with setAttestationVerifier; CIVIC_ALLOW_NO_ATTESTATION=1 accepts running without device attestation)");
  if (process.env.CIVIC_ANCHOR_URL && !process.env.CIVIC_ANCHOR_SECRET) p.push("CIVIC_ANCHOR_URL is set but CIVIC_ANCHOR_SECRET is missing (anchors would be unsigned)");
  if (process.env.CIVIC_KMS_URL) {
    if (!process.env.CIVIC_KMS_SECRET) p.push("CIVIC_KMS_URL is set but CIVIC_KMS_SECRET is missing");
    if (!process.env.CIVIC_KMS_KEK_ID) p.push("CIVIC_KMS_URL is set but CIVIC_KMS_KEK_ID is missing");
    if (!/^https:\/\//i.test(process.env.CIVIC_KMS_URL)) p.push("CIVIC_KMS_URL must be https");
  }
  if (process.env.CIVIC_SMS_URL) {
    if (!process.env.CIVIC_SMS_SECRET) p.push("CIVIC_SMS_URL is set but CIVIC_SMS_SECRET is missing");
    if (!process.env.CIVIC_SMS_RECEIPT_SECRET) p.push("CIVIC_SMS_URL is set but CIVIC_SMS_RECEIPT_SECRET is missing (delivery receipts could not be authenticated)");
    if (!/^https:\/\//i.test(process.env.CIVIC_SMS_URL)) p.push("CIVIC_SMS_URL must be https");
  }
  if (process.env.CIVIC_NUMINTEL_URL) {
    if (!process.env.CIVIC_NUMINTEL_SECRET) p.push("CIVIC_NUMINTEL_URL is set but CIVIC_NUMINTEL_SECRET is missing");
    if (!/^https:\/\//i.test(process.env.CIVIC_NUMINTEL_URL)) p.push("CIVIC_NUMINTEL_URL must be https (the clear number is sent)");
  }
  const gw = getSmsGateway();
  if (gw && !isDevSmsProvider()) {
    const missing = gw.registry.unregistered();
    if (missing.length) p.push(`SMS templates without a DLT template id (they would be refused at send time): ${missing.join(", ")} (CIVIC_SMS_TEMPLATES_FILE)`);
  }
  if (process.env.CIVIC_EXPOSE_DEV_OTP === "1") p.push("CIVIC_EXPOSE_DEV_OTP=1");
  if (isDevNumberIntelligence()) p.push("number-intelligence dev fixtures are active (use setNumberIntelligence)");
  if (process.env.CIVIC_ALLOW_DEMO !== "1") {
    const demo = demoProvenance();
    if (demo.length) p.push(`demo data provenance in data/generated: ${demo.join(", ")} (set CIVIC_ALLOW_DEMO=1 to override)`);
  }
  return p;
}

export function assertProductionSafe(): void {
  if (!isProductionEnv()) {
    if (process.env.NODE_ENV === undefined && process.env.CIVIC_ENV === undefined && !process.env.VITEST) {
      console.warn("[civic] WARNING: NODE_ENV is not set; running with DEV defaults (dev keys, dev SMS, demo data). Set NODE_ENV=production for a real deployment.");
    }
    return;
  }
  const problems = productionProblems();
  if (problems.length) throw new Error("civic refuses to start in production: " + problems.join("; "));
}
