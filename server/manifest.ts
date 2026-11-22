import fs from "fs";
import path from "path";

/** What an API envelope needs from data/generated/manifest.json. */
export interface DatasetSourceInfo {
  dataset: string;
  provenance: string;
  urls: string[];
  licences: string[];
  attribution: string;
  asOf: string | null;
}
export type ManifestIndex = Record<string, DatasetSourceInfo>;

export function loadManifestIndex(baseDir: string): ManifestIndex | null {
  try {
    const file = path.join(baseDir, "data", "generated", "manifest.json");
    if (!fs.existsSync(file)) return null;
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as { datasets?: Record<string, unknown>[] };
    const out: ManifestIndex = {};
    for (const d of m.datasets ?? []) {
      out[String(d.id)] = {
        dataset: String(d.id), provenance: String(d.provenance ?? "unknown"), urls: (d.sources as string[]) ?? [],
        licences: (d.licences as string[]) ?? [], attribution: String(d.attribution ?? ""), asOf: (d.asOf as string | null) ?? null,
      };
    }
    return out;
  } catch (err) {
    console.warn("[api] could not read manifest.json:", (err as Error).message);
    return null;
  }
}

/** Dataset id behind an /api/v1 path, or null when the route is not backed by a manifest dataset. */
export function datasetForPath(p: string): string | null {
  if (/^\/(elections|states)(\/|$)/.test(p)) return /\/forecast$/.test(p) ? null : "elections";
  if (/^\/census(\/|$)/.test(p)) return "census-districts";
  return null;
}
