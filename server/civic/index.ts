import express, { Router } from "express";
import { identityRouter } from "./identity/routes";
import { householdRouter } from "./households/routes";
import { geoRouter } from "./geo/routes";
import { issuesRouter } from "./issues/routes";
import { channelsRouter } from "./channels/routes";
import { adminRouter, auditRouter } from "./admin/routes";
import { surveysRouter } from "./surveys";
import { consultationsRouter } from "./consultations";
import { getKeys, migrate, requireRole } from "./core";
import { startIssueSweeper } from "./issues/service";
import { assertProductionSafe } from "./guards";
import { jobsStatus, startJobs } from "./jobs";
import { createE2eSeedRouter, e2eSeedEnabled } from "./e2e-seed";
import { installProvidersFromEnv, requireKeysReady, startKeyWarmup } from "./providers/install";
import { createSmsReceiptRouter, getSmsGateway } from "./providers/sms";
import { isKeyProviderV2 } from "./providers/keys";
import { getNumberIntelligence } from "./identity/service";
import { scopeRouter } from "./scope";
import { degradedGate, degradedPayload } from "../degraded";
import { notifyRouter } from "./notify";
import { officersRouter } from "./officers";
import { representativesRouter } from "./representatives";
import { assistedRouter } from "./assisted/routes";

/** Default JSON body cap for civic routes (the app mounts this router before its own global parser). */
export const CIVIC_JSON_LIMIT = "64kb";

/** Mounted at /api/v1/civic by server.ts. Each sub-router is owned by one agent (see docs/PHASE1_PLAN.md). */
export function createCivicRouter(): Router {
  installProvidersFromEnv(); // S-62/63/64: CIVIC_KMS_URL / CIVIC_SMS_URL / CIVIC_NUMINTEL_URL select the neutral HTTP adapters
  assertProductionSafe(); // S-55: throws on dev stand-ins in production
  migrate();
  void startKeyWarmup(); // unwraps the KMS-held keys; until it finishes the router answers 503 keys_warming (fail closed)
  startIssueSweeper(); // SLA escalation + confirmation windows; no-op under NODE_ENV=test or CIVIC_SWEEP=0
  startJobs(); // retention, erasure, invites, audit anchor + verify, media purge; no-op under NODE_ENV=test or CIVIC_JOBS=0
  const r = Router();
  // SMS delivery receipts authenticate themselves (HMAC) and parse their own raw body, so they sit before the key gate and the channels router.
  r.use("/channels/sms-receipt", createSmsReceiptRouter());
  r.use(requireKeysReady);
  r.use(degradedGate()); // S-46: sheds non-essential routes with 503 + Retry-After while degraded (docs/DEGRADED_MODE.md)
  r.get("/degraded", (_req, res) => { res.set("Cache-Control", "no-cache"); res.json(degradedPayload()); });
  // Per-router body limits (S-57). identity/households/channels set their own; issues gets a small cap except POST /media, whose
  // route carries a larger base64-JSON limit (and raw/multipart handling).
  r.use("/issues", (req, res, next) => (req.method === "POST" && req.path === "/media" ? next() : express.json({ limit: CIVIC_JSON_LIMIT })(req, res, next)));
  r.get("/ops/jobs", requireRole("admin"), (_req, res) => { res.json(jobsStatus()); });
  r.get("/ops/providers", requireRole("admin"), (_req, res) => {
    const k = getKeys();
    res.json({ keys: isKeyProviderV2(k) ? k.health() : { provider: "v1", ready: true }, sms: getSmsGateway()?.health() ?? null, numberIntelligence: (getNumberIntelligence() as { contract?: number }).contract === 2 ? "v2" : "v1/dev" });
  });
  r.use("/identity", identityRouter);
  r.use("/households", householdRouter);
  r.use("/geo", geoRouter);
  r.use("/issues", issuesRouter);
  r.use("/channels", channelsRouter);
  r.use("/scope", scopeRouter); // S-40: role- and geo-scoped read-only dashboards (docs/ROLES.md)
  r.use("/admin", adminRouter);
  r.use("/audit", auditRouter);
  r.use("/officers", officersRouter); // verified officer onboarding: applications and the admin verification queue (docs/OFFICERS.md)
  r.use("/representatives", representativesRouter); // representative replies, scheme tags, grievance adapter (docs/REPRESENTATIVES.md)
  r.use("/assisted", assistedRouter); // assisted participation (S-49): OFF unless ASSISTED_ENABLED=1 + ASSISTED_SUNSET_DATE (docs/ASSISTED_PARTICIPATION.md)
  r.use("/notify", notifyRouter); // verified-sender government notifications (server/civic/notify, docs/NOTIFICATIONS.md)
  r.use("/consultations", consultationsRouter); // bill consultations (server/civic/consultations, docs/CONSULTATIONS.md)
  r.use("/surveys", surveysRouter); // Pulse Surveys: registry, credential, published figures (server/civic/surveys)
  if (e2eSeedEnabled()) r.use("/e2e", createE2eSeedRouter()); // Playwright only: NODE_ENV!=production AND CIVIC_E2E_SEED=1 (server/civic/e2e-seed.ts)
  return r;
}
