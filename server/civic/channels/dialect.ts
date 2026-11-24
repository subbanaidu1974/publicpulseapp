/**
 * IVR dialect selector (S-151, engineering side). Maps (prompt id, dialect) to an audio asset key so recorded Telugu audio per dialect can
 * be dropped in later without code changes.
 *
 * Resolution for one prompt:
 *   1. dialect other than "standard" AND data/civic/audio-manifest.json lists a REVIEWED recording for that prompt+dialect
 *      -> `audio/te/<dialect>/<id>.wav` (the manifest `file`), fallback "none".
 *   2. otherwise the standard key `audio/te/<id>.wav`, fallback "standard" (a dialect was asked for but is not recorded/reviewed yet).
 *   3. when the standard asset itself is not reviewed either, the prompt is marked `tts: true` (the XML renderer may use text-to-speech
 *      when CIVIC_IVR_TTS_FALLBACK=1; default off keeps the historic <Play> of the placeholder key).
 * Only "reviewed" recordings are ever selected for a dialect: unreviewed audio never reaches a caller.
 *
 * Where the dialect comes from: the telephony aggregator's `dialect` field on /missed-call or any /ivr turn (it can map the dialled
 * number or telecom circle), else CIVIC_IVR_DEFAULT_DIALECT, else "standard". There is no spoken in-call selector: that needs a new
 * recorded prompt (a linguist/recording step, not built).
 */
import fs from "node:fs";
import path from "node:path";

export const DIALECTS = ["standard", "coastal", "rayalaseema", "telangana"] as const;
export type Dialect = (typeof DIALECTS)[number];
export type AudioFallback = "none" | "standard";

export const isDialect = (v: unknown): v is Dialect => typeof v === "string" && (DIALECTS as readonly string[]).includes(v);
/** Lenient normaliser for config values ("Coastal", " telangana "). Unknown -> null. */
export const normalizeDialect = (v: unknown): Dialect | null => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return isDialect(s) ? s : null;
};
export const defaultDialect = (): Dialect => normalizeDialect(process.env.CIVIC_IVR_DEFAULT_DIALECT) ?? "standard";
export const ttsFallbackEnabled = (): boolean => process.env.CIVIC_IVR_TTS_FALLBACK === "1";

export interface ManifestRecording { file?: string; status?: string }
export interface ManifestEntry extends ManifestRecording { id: string; recordings?: Record<string, ManifestRecording> }
export interface AudioManifestLike { dialects?: string[]; prompts: ManifestEntry[] }

let cached: AudioManifestLike | null | undefined;
let override: AudioManifestLike | null | undefined;
/** Tests: supply a manifest (or null to force "nothing recorded"); undefined restores the file. */
export function setAudioManifestForTests(m: AudioManifestLike | null | undefined): void { override = m; cached = undefined; }
function manifest(): AudioManifestLike | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  try { cached = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/civic/audio-manifest.json"), "utf8")) as AudioManifestLike; } catch { cached = null; }
  return cached;
}

export const standardKey = (id: string): string => `audio/te/${id}.wav`;
const isReviewed = (r?: ManifestRecording): r is ManifestRecording & { file: string } => r?.status === "reviewed" && typeof r.file === "string" && /^[\w./-]{1,200}$/.test(r.file) && !r.file.split("/").includes("..");

export interface ResolvedAudio { audioKey: string; dialect: Dialect; fallback: AudioFallback; tts: boolean }

export function resolveAudio(id: string, dialect: Dialect = "standard", m: AudioManifestLike | null = manifest()): ResolvedAudio {
  const entry = m?.prompts.find((p) => p.id === id);
  const standardReviewed = isReviewed(entry);
  if (dialect !== "standard") {
    const rec = entry?.recordings?.[dialect];
    if (isReviewed(rec)) return { audioKey: rec.file, dialect, fallback: "none", tts: false };
    return { audioKey: standardKey(id), dialect: "standard", fallback: "standard", tts: !standardReviewed };
  }
  return { audioKey: standardKey(id), dialect: "standard", fallback: "none", tts: !standardReviewed };
}

export interface MissingRow { id: string; dialect: Dialect; status: "missing" | "placeholder" | "recorded" | "reviewed" }
/** Every (prompt, dialect) pair with its state; the validator script prints the non-reviewed ones. `skip` lists dynamic prompts to ignore. */
export function recordingMatrix(m: AudioManifestLike, skip: string[] = []): MissingRow[] {
  const out: MissingRow[] = [];
  for (const p of m.prompts) {
    if (skip.includes(p.id)) continue;
    for (const d of DIALECTS) {
      const r = d === "standard" ? p : p.recordings?.[d];
      const s = r?.status;
      out.push({ id: p.id, dialect: d, status: !r ? "missing" : s === "reviewed" ? "reviewed" : s === "recorded" ? "recorded" : "placeholder" });
    }
  }
  return out;
}
