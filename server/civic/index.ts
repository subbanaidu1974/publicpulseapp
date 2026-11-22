import { Router } from "express";
import { identityRouter } from "./identity/routes";
import { householdRouter } from "./households/routes";
import { geoRouter } from "./geo/routes";
import { issuesRouter } from "./issues/routes";
import { channelsRouter } from "./channels/routes";
import { migrate } from "./core";
import { startIssueSweeper } from "./issues/service";

/** Mounted at /api/v1/civic by server.ts. Each sub-router is owned by one agent (see docs/PHASE1_PLAN.md). */
export function createCivicRouter(): Router {
  migrate();
  startIssueSweeper(); // SLA escalation + confirmation windows; no-op under NODE_ENV=test or CIVIC_SWEEP=0
  const r = Router();
  r.use("/identity", identityRouter);
  r.use("/households", householdRouter);
  r.use("/geo", geoRouter);
  r.use("/issues", issuesRouter);
  r.use("/channels", channelsRouter);
  return r;
}
