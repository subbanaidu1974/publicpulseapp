import express, { Router } from "express";
import { identityRouter } from "./identity/routes";
import { householdRouter } from "./households/routes";
import { geoRouter } from "./geo/routes";
import { issuesRouter } from "./issues/routes";
import { channelsRouter } from "./channels/routes";
import { migrate, requireRole } from "./core";
import { startIssueSweeper } from "./issues/service";
import { assertProductionSafe } from "./guards";
import { jobsStatus, startJobs } from "./jobs";

/** Default JSON body cap for civic routes (the app mounts this router before its own global parser). */
export const CIVIC_JSON_LIMIT = "64kb";

/** Mounted at /api/v1/civic by server.ts. Each sub-router is owned by one agent (see docs/PHASE1_PLAN.md). */
export function createCivicRouter(): Router {
  assertProductionSafe(); // S-55: throws on dev stand-ins in production
  migrate();
  startIssueSweeper(); // SLA escalation + confirmation windows; no-op under NODE_ENV=test or CIVIC_SWEEP=0
  startJobs(); // retention, erasure, invites, audit anchor + verify, media purge; no-op under NODE_ENV=test or CIVIC_JOBS=0
  const r = Router();
  // Per-router body limits (S-57). identity/households/channels set their own; issues gets a small cap except POST /media, whose
  // route carries a larger base64-JSON limit (and raw/multipart handling).
  r.use("/issues", (req, res, next) => (req.method === "POST" && req.path === "/media" ? next() : express.json({ limit: CIVIC_JSON_LIMIT })(req, res, next)));
  r.get("/ops/jobs", requireRole("admin"), (_req, res) => { res.json(jobsStatus()); });
  r.use("/identity", identityRouter);
  r.use("/households", householdRouter);
  r.use("/geo", geoRouter);
  r.use("/issues", issuesRouter);
  r.use("/channels", channelsRouter);
  return r;
}
