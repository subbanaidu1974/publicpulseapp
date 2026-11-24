/**
 * Missing-recordings report (S-151). READ-ONLY: lists, per prompt and dialect (standard, coastal, rayalaseema, telangana), which
 * recordings are not yet "reviewed" in data/civic/audio-manifest.json. Never edits anything. The IVR only plays a dialect asset that is
 * reviewed (server/civic/channels/dialect.ts); everything else falls back to the standard key, then to TTS when CIVIC_IVR_TTS_FALLBACK=1.
 * Usage: tsx scripts/audio-missing.ts [--strict]   (--strict exits 1 while anything is missing; default exit 0)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIALECTS, recordingMatrix, type AudioManifestLike, type MissingRow } from "../server/civic/channels/dialect";

/** Dynamic prompts whose text is built at call time are not recordable as one file. */
export const DYNAMIC_PROMPTS = ["survey_q"];

export function missingReport(root: string): { rows: MissingRow[]; total: number; reviewed: number; text: string } {
  const m = JSON.parse(fs.readFileSync(path.join(root, "data/civic/audio-manifest.json"), "utf8")) as AudioManifestLike;
  const all = recordingMatrix(m, DYNAMIC_PROMPTS);
  const rows = all.filter((r) => r.status !== "reviewed");
  const ids = [...new Set(all.map((r) => r.id))];
  const lines = [`Prompts: ${ids.length}; slots (prompt x ${DIALECTS.length} dialects): ${all.length}; reviewed: ${all.length - rows.length}; missing: ${rows.length}`];
  for (const id of ids) {
    const gaps = rows.filter((r) => r.id === id).map((r) => `${r.dialect}(${r.status})`);
    if (gaps.length) lines.push(`${id}: ${gaps.join(", ")}`);
  }
  return { rows, total: all.length, reviewed: all.length - rows.length, text: lines.join("\n") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const r = missingReport(root);
  console.log(r.text);
  if (process.argv.includes("--strict") && r.rows.length) process.exit(1);
}
