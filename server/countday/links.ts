import fs from "node:fs";
import path from "node:path";
import type { AcLink } from "../../pipeline/countday/types";

/** Outbound links per state, ONLY from data/reference/countday-sources.json (override COUNTDAY_SOURCES_FILE). https only; nothing is copied. */
export function loadLinks(state: string, file = process.env.COUNTDAY_SOURCES_FILE || path.join(process.cwd(), "data", "reference", "countday-sources.json")): AcLink[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { links?: Record<string, AcLink[]> };
    return (raw.links?.[state.toUpperCase()] ?? []).filter((l) => /^https:\/\//.test(l.url)).map((l) => ({ kind: l.kind, label: l.label, url: l.url, verified: l.verified === true }));
  } catch { return []; }
}
