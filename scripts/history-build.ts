/**
 * Builds or refreshes the local history store (data/history.db, or HISTORY_DB) from the generated/reference JSON.
 * Usage: npm run history:build [-- --reset]   (--reset deletes the DB first, discarding revision history and office-holder intervals)
 */
import { buildHistory } from "../server/history/store";

const r = buildHistory({ reset: process.argv.includes("--reset") });
console.log(`[history] ${r.dbPath}${r.reset ? " (reset)" : ""}`);
console.log(`[history] new revisions: ${r.revisions.length} (${r.revisions.map((x) => x.dataset).join(", ") || "none"}); unchanged: ${r.unchanged}`);
if (r.missing.length) console.log(`[history] source files missing: ${r.missing.join(", ")}`);
console.log("[history] rows:", JSON.stringify(r.counts));
