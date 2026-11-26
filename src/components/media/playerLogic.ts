/** Pure helpers for the free media player (S-227). No network, no storage: nothing here remembers what a person played. */
export interface MediaSource { url: string; label: string; height?: number; type?: string }

/** Lowest-quality source first when the person asked for low data, otherwise the highest. Sources without a height count as 0. */
export function pickSource(sources: MediaSource[], lowData: boolean): MediaSource | null {
  if (!sources.length) return null;
  const sorted = [...sources].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  return lowData ? sorted[0] : sorted[sorted.length - 1];
}

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];
export const isSpeed = (n: number): n is Speed => (SPEEDS as readonly number[]).includes(n);

/** Audio versus video from the file type or, failing that, its name. Anything else is refused. */
export function kindOf(name: string, mime: string): "audio" | "video" | null {
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"].includes(ext)) return "audio";
  if (["mp4", "m4v", "webm", "ogv", "mov"].includes(ext)) return "video";
  return null;
}

/** "m:ss" or "h:mm:ss" for the visible time read-out. */
export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
}
