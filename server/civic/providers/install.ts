/**
 * Install providers from the environment at startup (called by createCivicRouter). A provider that something else already installed
 * (setKeyProvider / setSmsProvider / setNumberIntelligence from a vendor adapter module) is left alone.
 *
 *   CIVIC_KMS_URL    -> RemoteKmsKeyProvider (needs CIVIC_KMS_SECRET + CIVIC_KMS_KEK_ID). Keys are unwrapped asynchronously after migrate():
 *                       until that finishes the civic router answers 503 "keys_warming" (fail closed) instead of touching any key.
 *   CIVIC_SMS_URL    -> HttpSmsProvider (needs CIVIC_SMS_SECRET), templates from CIVIC_SMS_TEMPLATES_FILE.
 *   CIVIC_NUMINTEL_URL -> HttpNumberIntel (needs CIVIC_NUMINTEL_SECRET).
 * A vendor adapter replaces any of these by calling the setter in its own module before createCivicRouter() runs.
 */
import fs from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { AwsKmsKeyProvider } from "./awskms";
import { GenericHttpNumberIntel, type GenericIntelMapping } from "./numberintelHttp";
import { isDevKeyProvider, isDevSmsProvider, setKeyProvider, setSmsProvider, getKeys } from "../core";
import { isDevNumberIntelligence, setNumberIntelligence } from "../identity/service";
import { RemoteKmsKeyProvider, SqlKeyRegistry, isKeyProviderV2 } from "./keys";
import { HttpNumberIntel } from "./numberintel";
import { GenericHttpSmsProvider, genericSmsConfigFromEnv } from "./smsgeneric";
import { HttpSmsProvider, loadTemplateRegistry, setSmsGateway, startSmsRetryLoop } from "./sms";
import { providerLog } from "./util";

export interface InstalledProviders { keys: boolean; sms: boolean; numberIntel: boolean }

const n = (v: string | undefined): number | undefined => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

export function installProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): InstalledProviders {
  const out: InstalledProviders = { keys: false, sms: false, numberIntel: false };
  if (env.CIVIC_KMS_URL && isDevKeyProvider()) {
    if (!env.CIVIC_KMS_KEK_ID) throw new Error("CIVIC_KMS_URL is set but CIVIC_KMS_KEK_ID is missing");
    setKeyProvider(new RemoteKmsKeyProvider({ url: env.CIVIC_KMS_URL, secret: env.CIVIC_KMS_SECRET ?? "", kekId: env.CIVIC_KMS_KEK_ID, registry: new SqlKeyRegistry(), timeoutMs: n(env.CIVIC_KMS_TIMEOUT_MS), cacheTtlMs: n(env.CIVIC_KMS_CACHE_TTL_MS) }));
    warmState = "cold"; out.keys = true;
  } else if (env.CIVIC_AWS_KMS_KEY_ID && !env.CIVIC_KMS_URL && isDevKeyProvider()) {
    // AWS KMS (S-64). Static credentials from the environment; see docs/PROVIDERS.md (not yet run against real AWS).
    setKeyProvider(new AwsKmsKeyProvider({
      region: env.CIVIC_AWS_KMS_REGION || env.AWS_REGION || "", endpoint: env.CIVIC_AWS_KMS_ENDPOINT || undefined, kekId: env.CIVIC_AWS_KMS_KEY_ID,
      credentials: () => ({ accessKeyId: env.AWS_ACCESS_KEY_ID ?? "", secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "", sessionToken: env.AWS_SESSION_TOKEN || undefined }),
      registry: new SqlKeyRegistry(), timeoutMs: n(env.CIVIC_KMS_TIMEOUT_MS), cacheTtlMs: n(env.CIVIC_KMS_CACHE_TTL_MS),
    }));
    warmState = "cold"; out.keys = true;
  }
  if (env.CIVIC_SMS_URL && isDevSmsProvider()) {
    const p = new HttpSmsProvider({
      url: env.CIVIC_SMS_URL, secret: env.CIVIC_SMS_SECRET ?? "", receiptSecret: env.CIVIC_SMS_RECEIPT_SECRET, callbackUrl: env.CIVIC_SMS_RECEIPT_URL ?? null,
      registry: loadTemplateRegistry(), senderId: env.CIVIC_SMS_SENDER_ID, timeoutMs: n(env.CIVIC_SMS_TIMEOUT_MS), maxAttempts: n(env.CIVIC_SMS_MAX_ATTEMPTS),
    });
    setSmsProvider(p); setSmsGateway(p); startSmsRetryLoop(); out.sms = true;
  }
  if (env.CIVIC_SMSGW_URL && isDevSmsProvider()) { // generic configurable DLT gateway adapter (S-63); never run against a real gateway, see smsgeneric.ts
    const cfg = genericSmsConfigFromEnv(env);
    const p = new GenericHttpSmsProvider(cfg, {
      registry: loadTemplateRegistry(), senderId: env.CIVIC_SMS_SENDER_ID, timeoutMs: n(env.CIVIC_SMSGW_TIMEOUT_MS) ?? n(env.CIVIC_SMS_TIMEOUT_MS), maxAttempts: n(env.CIVIC_SMS_MAX_ATTEMPTS),
    });
    setSmsProvider(p); setSmsGateway(p); startSmsRetryLoop(); out.sms = true;
  }
  if (env.CIVIC_NUMINTEL_URL && isDevNumberIntelligence()) {
    // CIVIC_NUMINTEL_API_KEY selects the generic API-key adapter (mapping from CIVIC_NUMINTEL_MAPPING_FILE); otherwise the neutral signed shape.
    if (env.CIVIC_NUMINTEL_API_KEY) {
      const mapping = env.CIVIC_NUMINTEL_MAPPING_FILE ? JSON.parse(fs.readFileSync(env.CIVIC_NUMINTEL_MAPPING_FILE, "utf8")) as GenericIntelMapping : undefined;
      setNumberIntelligence(new GenericHttpNumberIntel({ url: env.CIVIC_NUMINTEL_URL, apiKey: env.CIVIC_NUMINTEL_API_KEY, mapping, timeoutMs: n(env.CIVIC_NUMINTEL_TIMEOUT_MS), cacheTtlMs: n(env.CIVIC_NUMINTEL_CACHE_TTL_MS) }));
    } else setNumberIntelligence(new HttpNumberIntel({ url: env.CIVIC_NUMINTEL_URL, secret: env.CIVIC_NUMINTEL_SECRET ?? "", timeoutMs: n(env.CIVIC_NUMINTEL_TIMEOUT_MS), cacheTtlMs: n(env.CIVIC_NUMINTEL_CACHE_TTL_MS) }));
    out.numberIntel = true;
  }
  return out;
}

// --- key warm-up (async; must run after migrate() because the registry is a table) -------------------------------------------------

type WarmState = "none" | "cold" | "warming" | "ready" | "failed";
let warmState: WarmState = "none";
let warmTimer: ReturnType<typeof setTimeout> | null = null;

/** Unwrap/provision every key of a v2 provider. Retries every 15 s on failure; the router stays closed (503) until it succeeds. */
export function startKeyWarmup(): Promise<void> {
  const k = getKeys();
  if (!isKeyProviderV2(k) || warmState === "none") return Promise.resolve();
  warmState = "warming";
  return k.warm().then(() => { warmState = "ready"; (k as { startRefresh?: () => void }).startRefresh?.(); }, (e: unknown) => {
    warmState = "failed";
    providerLog("kms", "warm_failed", { error: e instanceof Error ? e.message : "error" });
    if (process.env.NODE_ENV !== "test" && !process.env.VITEST) { warmTimer = setTimeout(() => { void startKeyWarmup(); }, 15_000); warmTimer.unref?.(); }
  });
}
export const keysReady = (): boolean => warmState === "none" || warmState === "ready";
export function resetProviderStateForTests(): void { warmState = "none"; if (warmTimer) clearTimeout(warmTimer); warmTimer = null; }
export function markKeysWarmForTests(): void { warmState = "ready"; }

/** Fail-closed gate mounted at the top of the civic router. */
export function requireKeysReady(_req: Request, res: Response, next: NextFunction): void {
  if (keysReady()) return next();
  res.status(503).set("Retry-After", "15").json({ error: "keys_warming", degraded: true });
}
