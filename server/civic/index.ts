import { Router } from "express";
import { identityRouter } from "./identity/routes";
import { householdRouter } from "./households/routes";
import { geoRouter } from "./geo/routes";
import { issuesRouter } from "./issues/routes";
import { channelsRouter } from "./channels/routes";
import { migrate } from "./core";

/** Mounted at /api/v1/civic by server.ts. Each sub-router is owned by one agent (see docs/PHASE1_PLAN.md). */
export function createCivicRouter(): Router {
  migrate();
  const r = Router();
  r.use("/identity", identityRouter);
  r.use("/households", householdRouter);
  r.use("/geo", geoRouter);
  r.use("/issues", issuesRouter);
  r.use("/channels", channelsRouter);
  return r;
}
