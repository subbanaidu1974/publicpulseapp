/**
 * Staged data refresh (S-76). Never edits data/generated in place:
 *   1. copy the live set into data/refresh/staging
 *   2. run the steps against the staging copy (child processes with PIPELINE_OUT_DIR=staging)
 *   3. rebuild the manifest in staging, then validate (manifest check + injected validator)
 *   4. refuse to swap when real data would be replaced by demo data, or a dataset would disappear
 *   5. atomic swap: live -> data/refresh/previous, staging -> live (renames on one filesystem); roll back if the second rename fails
 * A failed run leaves the live directory untouched. `rollbackRefresh` swaps the kept previous set back.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildManifest, verifyManifest, MANIFEST_NAME, type Manifest } from "../manifest";
import { writeJson } from "../io";

export interface RefreshStep { name: string; run: (ctx: { stagingDir: string; root: string }) => Promise<void> }
export interface RefreshOptions {
  root: string; genDir: string; steps: RefreshStep[];
  /** extra checks on the staged directory; return error strings. Default: manifest verification only. */
  validate?: (stagingDir: string) => Promise<string[]> | string[];
  now?: () => Date;
  /** test hook: fail the second rename of the swap */
  failSwapForTests?: boolean;
}
export interface RefreshReport {
  ok: boolean; swapped: boolean; startedAt: string; finishedAt: string; unchanged: boolean;
  steps: { name: string; ok: boolean; ms: number; error?: string }[];
  changed: string[]; added: string[]; removed: string[]; errors: string[]; rolledBack: boolean;
}

export const refreshDirs = (root: string) => ({ base: join(root, "data", "refresh"), staging: join(root, "data", "refresh", "staging"), previous: join(root, "data", "refresh", "previous"), report: join(root, "data", "refresh", "last-report.json") });

function readManifest(dir: string): Manifest | null {
  try { return JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8")) as Manifest; } catch { return null; }
}
function provenanceOf(dir: string, file: string): string | null {
  try { const j = JSON.parse(readFileSync(join(dir, file), "utf8")); return typeof j.provenance === "string" ? j.provenance : null; } catch { return null; }
}

/** Errors that must block a swap: demo over real data, vanished datasets. */
export function guardErrors(liveDir: string, stagingDir: string): string[] {
  const errs: string[] = [];
  for (const f of ["elections.json", "census.json", "census-units.json", "census-subdistricts.json"]) {
    const live = provenanceOf(liveDir, f), next = provenanceOf(stagingDir, f);
    if (live && live !== "demo" && next === "demo") errs.push(`guard: ${f} would be replaced by DEMO data (live provenance '${live}')`);
    if (existsSync(join(liveDir, f)) && !existsSync(join(stagingDir, f))) errs.push(`guard: ${f} is missing from the staged set`);
  }
  const lm = readManifest(liveDir), sm = readManifest(stagingDir);
  if (lm && sm) {
    const have = new Set(sm.datasets.map(d => d.path));
    for (const d of lm.datasets) if (!have.has(d.path)) errs.push(`guard: dataset ${d.id} (${d.path}) disappeared from the staged set`);
    for (const d of sm.datasets) { const old = lm.datasets.find(x => x.path === d.path); if (old && !old.demo && d.demo) errs.push(`guard: dataset ${d.id} flipped from real to demo`); }
  }
  return errs;
}

export function diffManifests(live: Manifest | null, next: Manifest | null): { changed: string[]; added: string[]; removed: string[] } {
  const a = new Map((live?.datasets ?? []).map(d => [d.path, d.sha256])), b = new Map((next?.datasets ?? []).map(d => [d.path, d.sha256]));
  return {
    changed: [...b].filter(([p, h]) => a.has(p) && a.get(p) !== h).map(([p]) => p),
    added: [...b.keys()].filter(p => !a.has(p)), removed: [...a.keys()].filter(p => !b.has(p)),
  };
}

export async function runRefresh(opts: RefreshOptions): Promise<RefreshReport> {
  const now = opts.now ?? (() => new Date());
  const dirs = refreshDirs(opts.root);
  const rep: RefreshReport = { ok: false, swapped: false, unchanged: false, startedAt: now().toISOString(), finishedAt: "", steps: [], changed: [], added: [], removed: [], errors: [], rolledBack: false };
  const finish = () => { rep.finishedAt = now().toISOString(); mkdirSync(dirs.base, { recursive: true }); writeJson(dirs.report, rep); return rep; };
  try {
    rmSync(dirs.staging, { recursive: true, force: true });
    mkdirSync(dirs.base, { recursive: true });
    cpSync(opts.genDir, dirs.staging, { recursive: true });
    for (const step of opts.steps) {
      const t0 = Date.now();
      try { await step.run({ stagingDir: dirs.staging, root: opts.root }); rep.steps.push({ name: step.name, ok: true, ms: Date.now() - t0 }); }
      catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        rep.steps.push({ name: step.name, ok: false, ms: Date.now() - t0, error: msg });
        rep.errors.push(`step ${step.name} failed: ${msg}`);
        break;
      }
    }
    if (rep.errors.length) return finish();
    // regenerate the manifest so the staged set describes itself, then check it against disk
    writeJson(join(dirs.staging, MANIFEST_NAME), buildManifest(dirs.staging, opts.root));
    rep.errors.push(...verifyManifest(dirs.staging, opts.root));
    rep.errors.push(...guardErrors(opts.genDir, dirs.staging));
    if (opts.validate) rep.errors.push(...(await opts.validate(dirs.staging)));
    if (rep.errors.length) return finish();

    Object.assign(rep, diffManifests(readManifest(opts.genDir), readManifest(dirs.staging)));
    if (!rep.changed.length && !rep.added.length && !rep.removed.length) { rep.unchanged = true; rep.ok = true; rmSync(dirs.staging, { recursive: true, force: true }); return finish(); }

    // atomic swap with rollback
    rmSync(dirs.previous, { recursive: true, force: true });
    renameSync(opts.genDir, dirs.previous);
    try {
      if (opts.failSwapForTests) throw new Error("simulated rename failure");
      renameSync(dirs.staging, opts.genDir);
    } catch (e) {
      renameSync(dirs.previous, opts.genDir);
      rep.rolledBack = true; rep.errors.push(`swap failed, previous set restored: ${(e as Error).message}`);
      return finish();
    }
    rep.swapped = true; rep.ok = true;
    return finish();
  } catch (e) {
    rep.errors.push(`refresh aborted: ${(e as Error).message.slice(0, 300)}`);
    return finish();
  }
}

/** Put the kept previous set back (the current live set becomes the new "previous"). */
export function rollbackRefresh(root: string, genDir: string): { ok: boolean; error?: string } {
  const d = refreshDirs(root);
  if (!existsSync(d.previous)) return { ok: false, error: "no previous data set is kept" };
  const tmp = join(d.base, "rollback-tmp");
  rmSync(tmp, { recursive: true, force: true });
  renameSync(genDir, tmp);
  try { renameSync(d.previous, genDir); } catch (e) { renameSync(tmp, genDir); return { ok: false, error: (e as Error).message }; }
  rmSync(d.previous, { recursive: true, force: true });
  renameSync(tmp, d.previous);
  return { ok: true };
}

/* ---------- default steps: the existing pipeline scripts, writing to the staging directory ---------- */
function runScript(script: string, root: string, stagingDir: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "scripts", script)], {
      cwd: root, env: { ...process.env, ...env, PIPELINE_OUT_DIR: stagingDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    p.stdout.on("data", d => { tail = (tail + d).slice(-600); });
    p.stderr.on("data", d => { tail = (tail + d).slice(-600); });
    p.on("error", rej);
    p.on("close", code => (code === 0 ? res() : rej(new Error(`${script} exited ${code}: ${tail.replace(/\s+/g, " ").trim().slice(-200)}`))));
  });
}
const STEP_SCRIPTS: Record<string, string> = { lgd: "fetch-lgd.ts", boundaries: "fetch-boundaries.ts", "names-te": "fetch-names-te.ts", census: "fetch-census.ts", elections: "fetch-elections.ts" };

/** REFRESH_STEPS (comma list) selects steps; default is the open-data geography steps. Elections only run when TCPD_CSV_URL is set. */
export function defaultSteps(root: string, env: NodeJS.ProcessEnv = process.env): RefreshStep[] {
  const wanted = (env.REFRESH_STEPS ?? "lgd,boundaries,names-te").split(",").map(s => s.trim()).filter(Boolean);
  const names = wanted.filter(n => STEP_SCRIPTS[n] && (n !== "elections" || !!env.TCPD_CSV_URL));
  return names.map(n => ({ name: n, run: ({ stagingDir }) => runScript(STEP_SCRIPTS[n], root, stagingDir) }));
}

/** Validate a staged directory with the repository gate (scripts/validate-data.ts). */
export function gateValidator(root: string): (dir: string) => Promise<string[]> {
  return dir => new Promise(res => {
    const p = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "scripts", "validate-data.ts"), dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", d => { err += d; });
    p.on("error", e => res([`validator could not start: ${e.message}`]));
    p.on("close", code => res(code === 0 ? [] : err.split("\n").filter(l => l.trim().startsWith("-")).map(l => `validate: ${l.trim().slice(2)}`).slice(0, 20).concat(code === 0 ? [] : ["validate: data quality gate failed"])));
  });
}
