/**
 * S-76: manual, staged data refresh. Runs the open-data pipeline steps against a copy of data/generated, validates the result
 * (manifest checksums, licence keys, demo-over-real guard, data quality gate) and only then swaps it in atomically, keeping the
 * previous set under data/refresh/previous. Writes data/refresh/last-report.json. Never fetches on a schedule by itself.
 * Usage: npm run refresh:data [-- --steps=lgd,boundaries,names-te] [--rollback]
 * Env: REFRESH_STEPS (default lgd,boundaries,names-te; add census / elections where their source env vars are set).
 */
import { join } from "node:path";
import { ROOT } from "../pipeline/io";
import { defaultSteps, gateValidator, rollbackRefresh, runRefresh } from "../pipeline/refresh/stage";

async function main() {
  const genDir = join(ROOT, "data", "generated");
  if (process.argv.includes("--rollback")) {
    const r = rollbackRefresh(ROOT, genDir);
    console.log(r.ok ? "[refresh] previous data set restored (the current set is kept as data/refresh/previous)" : `[refresh] rollback failed: ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  }
  const arg = process.argv.find(a => a.startsWith("--steps="));
  const steps = defaultSteps(ROOT, arg ? { ...process.env, REFRESH_STEPS: arg.slice(8) } : process.env);
  if (!steps.length) { console.error("[refresh] no steps selected"); process.exit(1); }
  console.log(`[refresh] steps: ${steps.map(s => s.name).join(", ")}`);
  const rep = await runRefresh({ root: ROOT, genDir, steps, validate: gateValidator(ROOT) });
  for (const s of rep.steps) console.log(`[refresh] ${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.ms} ms)${s.error ? " " + s.error : ""}`);
  if (rep.unchanged) console.log("[refresh] no dataset changed; live set kept");
  else if (rep.swapped) console.log(`[refresh] swapped in; changed ${rep.changed.length}, added ${rep.added.length}, removed ${rep.removed.length}. Run npm run pipeline:attribution.`);
  for (const e of rep.errors) console.error("[refresh] " + e);
  console.log("[refresh] report: data/refresh/last-report.json");
  process.exit(rep.ok ? 0 : 1);
}
main().catch(e => { console.error("[refresh] " + e.message); process.exit(1); });
