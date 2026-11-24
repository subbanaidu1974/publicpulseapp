/**
 * S-92: boundary-version checks.
 *   npm run geo:version:check                       validate data/generated/geo/versions.json (ranges, current set, file checksums)
 *   npm run geo:version:check -- --write            (re)build versions.json for the delimitation in force from the files on disk
 *   npm run geo:version:check -- --candidate FILE   DRY RUN of a future delimitation bundle against the live registry (writes nothing)
 *   npm run geo:version:check -- --fixture          dry run of the TEST ONLY 2029 fixture
 * Exit code 1 on any error. A testOnly bundle can be validated but is never installable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCurrentRegistry, dryRunCandidate, loadRegistry, validateRegistry, type CandidateBundle } from "../pipeline/geo/versions";
import { GEO_OUT, writeCompact } from "../pipeline/geo/util";
import { ROOT } from "../pipeline/io";

const args = process.argv.slice(2);
const geoDir = GEO_OUT;
let failed = false;
const fail = (m: string) => { console.error("[geo:version] " + m); failed = true; };

if (args.includes("--write")) {
  const old = loadRegistry(geoDir);
  const reg = buildCurrentRegistry(geoDir, old?.asOf ?? new Date().toISOString().slice(0, 10));
  if (old) {
    // keep later sets (installed by hand), refresh only the 2008 entry
    reg.sets = [...reg.sets, ...old.sets.filter(s => s.id !== reg.sets[0].id)].sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  }
  writeCompact(join(geoDir, "versions.json"), reg, 4);
  console.log(`[geo:version] wrote versions.json (${reg.sets.length} set(s))`);
}

const reg = loadRegistry(geoDir);
if (!reg) fail("versions.json is missing (run with --write)");
else {
  const errs = validateRegistry(reg, geoDir);
  for (const e of errs) fail(e);
  if (!errs.length) console.log(`[geo:version] registry ok: ${reg.sets.map(s => `${s.id} ${s.valid_from}..${s.valid_to ?? "open"}`).join("; ")}`);
}

const ci = args.indexOf("--candidate");
const candFile = ci >= 0 ? args[ci + 1] : args.includes("--fixture") ? join(ROOT, "pipeline/fixtures/geo/delimitation-2029-TEST-ONLY.json") : null;
if (candFile) {
  if (!existsSync(candFile)) fail(`candidate file ${candFile} not found`);
  else if (reg) {
    const r = dryRunCandidate(reg, JSON.parse(readFileSync(candFile, "utf8")) as CandidateBundle);
    console.log(`[geo:version] dry run of ${candFile}`);
    for (const p of r.plan) console.log("  plan: " + p);
    for (const w of r.warnings) console.log("  warning: " + w);
    for (const e of r.errors) fail("candidate: " + e);
    console.log(r.errors.length ? "  NOT valid" : r.installable ? "  valid and installable (follow docs/BOUNDARY_VERSIONS.md; nothing was written)" : "  structurally valid, NOT installable (test fixture)");
  }
}
process.exit(failed ? 1 : 0);
