/**
 * Audio manifest check (S-151). READ-ONLY: this script never edits the manifest and never marks anything reviewed.
 * Rules:
 *  - every manifest prompt id has a script in data/civic/audio-scripts/prompts.json (and vice versa);
 *  - every id in the IVR PROMPTS catalogue (server/civic/channels/routes.ts) is in the manifest;
 *  - the script's formal Telugu equals the manifest textTe, so the recorded text cannot drift silently;
 *  - a prompt (or per-dialect recording) whose status is not "placeholder" must name a file under public/ that exists and whose
 *    sha256 equals the `sha256` field in the manifest; "reviewed" additionally needs signoff {reviewer, date, formRef};
 *  - the top-level manifest status may be "reviewed" only if every prompt is reviewed.
 * A human edits the manifest after a linguist signs the form (docs/AUDIO_RECORDING_GUIDE.md).
 * Usage: tsx scripts/audio-manifest-check.ts [--hash <path-under-public>]   (--hash prints the sha256 to paste; it changes nothing)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export interface Recording { file?: string; status?: string; sha256?: string; signoff?: { reviewer?: string; date?: string; formRef?: string } }
export interface ManifestPrompt extends Recording { id: string; textTe: string; recordings?: Record<string, Recording> }
export interface Manifest { status: string; dialects: string[]; prompts: ManifestPrompt[] }
export interface ScriptFile { prompts: { id: string; textTe: { formal: string; plain: string; machineDraft: boolean }; textEn: string; maxDurationSec: number; dialects: Record<string, { needed: boolean }> }[] }

export const sha256File = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export function ivrPromptIds(root: string): string[] {
  const src = fs.readFileSync(path.join(root, "server/civic/channels/routes.ts"), "utf8");
  const start = src.indexOf("export const PROMPTS");
  const block = src.slice(start, src.indexOf("\n};", start));
  return [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
}

function checkRecording(label: string, r: Recording, root: string, problems: string[]): void {
  const status = r.status ?? "placeholder";
  if (status === "placeholder") {
    if (r.sha256) problems.push(`${label}: status is placeholder but a sha256 is set; set the status deliberately or remove the hash`);
    return;
  }
  if (!["recorded", "reviewed"].includes(status)) { problems.push(`${label}: unknown status "${status}"`); return; }
  if (!r.file) { problems.push(`${label}: status ${status} but no file`); return; }
  const abs = path.join(root, "public", r.file);
  if (!fs.existsSync(abs)) { problems.push(`${label}: status ${status} but public/${r.file} does not exist`); return; }
  if (!r.sha256) { problems.push(`${label}: status ${status} but no sha256`); return; }
  if (sha256File(abs) !== r.sha256.toLowerCase()) problems.push(`${label}: sha256 does not match public/${r.file}`);
  if (status === "reviewed" && !(r.signoff?.reviewer && r.signoff?.date && r.signoff?.formRef)) problems.push(`${label}: reviewed needs signoff {reviewer, date, formRef}`);
}

export function checkAudio(root: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "data/civic/audio-manifest.json"), "utf8")) as Manifest;
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "data/civic/audio-scripts/prompts.json"), "utf8")) as ScriptFile;
  const byId = new Map(scripts.prompts.map((p) => [p.id, p]));
  const manIds = new Set(manifest.prompts.map((p) => p.id));
  for (const p of manifest.prompts) {
    const s = byId.get(p.id);
    if (!s) { problems.push(`${p.id}: no script in prompts.json`); continue; }
    if (s.textTe.formal !== p.textTe) problems.push(`${p.id}: script formal text differs from manifest textTe`);
    if (!s.textTe.plain || !s.textEn || !(s.maxDurationSec > 0)) problems.push(`${p.id}: script is missing plain text, English gloss or max duration`);
    for (const d of manifest.dialects) if (!s.dialects?.[d]) problems.push(`${p.id}: script has no entry for dialect ${d}`);
    checkRecording(p.id, p, root, problems);
    for (const [d, r] of Object.entries(p.recordings ?? {})) {
      if (!manifest.dialects.includes(d)) problems.push(`${p.id}: recording for unknown dialect ${d}`);
      checkRecording(`${p.id}/${d}`, r, root, problems);
    }
  }
  for (const s of scripts.prompts) if (!manIds.has(s.id)) problems.push(`${s.id}: script has no manifest entry`);
  for (const id of ivrPromptIds(root)) if (!manIds.has(id)) problems.push(`${id}: IVR prompt missing from manifest`);
  if (manifest.status === "reviewed") {
    for (const p of manifest.prompts) {
      const recs = p.recordings ? Object.values(p.recordings) : [p];
      if (p.status !== "reviewed" && !recs.every((r) => r.status === "reviewed")) problems.push(`manifest status is reviewed but ${p.id} is not`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const hi = process.argv.indexOf("--hash");
  if (hi > 0) {
    const f = path.join(root, "public", process.argv[hi + 1] ?? "");
    if (!fs.existsSync(f)) { console.error("no such file under public/"); process.exit(1); }
    console.log(sha256File(f));
  } else {
    const problems = checkAudio(root);
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    console.log("audio manifest: ok (statuses are as recorded by humans; nothing was changed)");
  }
}
