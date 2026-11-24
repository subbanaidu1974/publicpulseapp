/** Scheme tag registry (S-145): data/civic/schemes.json. Ids are the only thing a reply stores; labels come from here so wording is edited in one place. */
import fs from "node:fs";
import path from "node:path";

export interface SchemeTag { id: string; label_en: string; label_te: string; level: string }
export const MAX_SCHEME_TAGS = 3;

let cache: SchemeTag[] | null = null;
export function schemeRegistry(): SchemeTag[] {
  if (cache) return cache;
  try { cache = (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data/civic/schemes.json"), "utf8")) as { schemes?: SchemeTag[] }).schemes ?? []; } catch { cache = []; }
  return cache;
}
export const schemeById = (id: string): SchemeTag | undefined => schemeRegistry().find((s) => s.id === id);

/** Validate and de-duplicate tag ids. Returns the ids, or an error code. */
export function parseSchemeTags(v: unknown): { ok: true; ids: string[] } | { ok: false; code: "bad_tags" | "unknown_scheme" | "too_many_tags" } {
  if (v === undefined || v === null) return { ok: true, ids: [] };
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { ok: false, code: "bad_tags" };
  const ids = [...new Set(v as string[])];
  if (ids.length > MAX_SCHEME_TAGS) return { ok: false, code: "too_many_tags" };
  if (ids.some((i) => !schemeById(i))) return { ok: false, code: "unknown_scheme" };
  return { ok: true, ids };
}
