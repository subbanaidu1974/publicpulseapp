/**
 * Data freshness endpoint and scheduled checks (S-76), mounted from server/api.ts under /api/v1:
 *   GET /data-freshness   per dataset: asOf, ageDays, thresholdDays, status fresh|stale|unknown (from data/generated/manifest.json)
 * Jobs (registered with the civic job scheduler, which is off under NODE_ENV=test and CIVIC_JOBS=0):
 *   dataFreshness   every 6 h: recomputes the alert flag (shown in /readyz info.dataFreshness) and logs a warning when stale.
 *   dataRefresh     only when REFRESH_ENABLED=1: runs the staged refresh (scripts/refresh-data.ts logic). OFF by default; the
 *                   supported way to refresh is the manual `npm run refresh:data`.
 */
import path from "node:path";
import { Router } from "express";
import { runRefresh, defaultSteps } from "../pipeline/refresh/stage";
import { registerJob } from "./civic/jobs";
import { alertFrom, computeFreshness, setFreshnessAlert } from "./freshness";
import { log } from "./obs";

export function createRefreshRouter(opts: { baseDir?: string; now?: () => Date } = {}): Router {
  const router = Router();
  const baseDir = opts.baseDir ?? process.cwd();
  router.get("/data-freshness", (_req, res) => {
    const report = computeFreshness(baseDir, (opts.now ?? (() => new Date()))());
    res.set("Cache-Control", "public, max-age=60");
    res.json({ ...report, alert: alertFrom(report) });
  });
  return router;
}

export function runFreshnessCheck(baseDir: string = process.cwd(), now: Date = new Date()) {
  const report = computeFreshness(baseDir, now);
  const alert = alertFrom(report);
  setFreshnessAlert(alert);
  if (alert.raised) log.warn("data freshness alert", { stale: alert.stale, unknown: alert.unknownCount, manifestPresent: report.manifestPresent });
  return alert;
}

registerJob({ name: "dataFreshness", intervalMs: 6 * 3_600_000, run: (now) => runFreshnessCheck(process.cwd(), now) });

if (process.env.REFRESH_ENABLED === "1") {
  const hours = Math.max(1, Number(process.env.REFRESH_INTERVAL_HOURS) || 24);
  registerJob({
    name: "dataRefresh", intervalMs: hours * 3_600_000,
    run: async () => {
      const root = process.cwd();
      const r = await runRefresh({ root, genDir: path.join(root, "data", "generated"), steps: defaultSteps(root) });
      log[r.ok ? "info" : "error"]("data refresh", { ok: r.ok, swapped: r.swapped, errors: r.errors.slice(0, 5) });
      return { ok: r.ok, swapped: r.swapped };
    },
  });
}
