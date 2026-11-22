import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GENERATED } from "../io";

/** Committed geo outputs live here. */
export const GEO_OUT = join(GENERATED, "geo");
/** Raw downloads are never committed. Override with GEO_CACHE_DIR. */
export const CACHE_DIR = process.env.GEO_CACHE_DIR ? resolve(process.env.GEO_CACHE_DIR) : join(tmpdir(), "publicpulse-geo-cache");

export const LGD_METADATA_URL = "https://ramseraph.github.io/opendata/lgd/data/metadata.json";
export const DATAMEET = "https://raw.githubusercontent.com/datameet";
export const SRC = {
  acShp: (ext: string) => `${DATAMEET}/maps/master/assembly-constituencies/India_AC.${ext}`,
  pc: `${DATAMEET}/maps/master/parliamentary-constituencies/india_pc_2019_simplified.geojson`,
  c2008: `${DATAMEET}/india-election-data/master/constituencies/2008-constituencies.csv`,
};

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Download to the cache if missing (or if the sha256 does not match). Returns the local path. */
export async function cached(name: string, url: string, expectSha?: string): Promise<string> {
  const p = join(CACHE_DIR, name);
  if (existsSync(p) && (!expectSha || sha256(readFileSync(p)) === expectSha)) return p;
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "telugu-pulse-geo-pipeline/1.0" }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (expectSha && sha256(buf) !== expectSha) throw new Error(`sha256 mismatch for ${url}`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, buf);
      return p;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export interface LgdMeta { datasets: Record<string, { daily: { file: { url: string; sha256: string; size: number }; observed_on: string; rows: number } }> }
export async function lgdMetadata(): Promise<LgdMeta> {
  // metadata changes daily; cache by day so reruns on one day are offline.
  const day = new Date().toISOString().slice(0, 10);
  const p = await cached(`metadata-${day}.json`, LGD_METADATA_URL);
  return JSON.parse(readFileSync(p, "utf8"));
}
/** Fetch (cached by content hash) one LGD parquet table. */
export async function lgdTable(meta: LgdMeta, name: string): Promise<{ path: string; sha256: string; observedOn: string; rows: number }> {
  const d = meta.datasets[name]?.daily;
  if (!d) throw new Error(`LGD mirror has no dataset ${name}`);
  const path = await cached(`${name}.${d.file.sha256.slice(0, 16)}.parquet`, d.file.url, d.file.sha256);
  return { path, sha256: d.file.sha256, observedOn: d.observed_on, rows: d.rows };
}

/** Deterministic compact JSON: one array element or object member per line down to the given depth. */
export function compactJson(v: unknown, depth = 2): string {
  const walk = (x: unknown, d: number): string => {
    if (d <= 0 || x === null || typeof x !== "object") return JSON.stringify(x);
    if (Array.isArray(x)) return "[\n" + x.map(i => walk(i, d - 1)).join(",\n") + "\n]";
    const e = Object.entries(x as Record<string, unknown>).filter(([, val]) => val !== undefined);
    return "{\n" + e.map(([k, val]) => JSON.stringify(k) + ":" + walk(val, d - 1)).join(",\n") + "\n}";
  };
  return walk(v, depth) + "\n";
}
export function writeCompact(file: string, v: unknown, depth = 2): void {
  mkdirSync(dirname(file), { recursive: true });
  const text = compactJson(v, depth);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  writeFileSync(file, text);
}
export const readJsonFile = <T = any>(f: string): T => JSON.parse(readFileSync(f, "utf8"));

/** Name normaliser for joins across sources: lowercase alnum, drop reservation tags. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/\((st|sc)\)/g, "").replace(/[^a-z0-9]+/g, "");
}
export function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Same constituency name modulo transliteration noise (edit distance up to 2, or 3 for long names). */
export function nameClose(a: string, b: string): boolean {
  const x = normName(a), y = normName(b);
  return x === y || levenshtein(x, y) <= (Math.max(x.length, y.length) >= 10 ? 3 : 2);
}
export const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s(\-])([a-z])/g, (_m, a, b) => a + b.toUpperCase());

/** Minimal CSV parser (quotes supported). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.map(r => Object.fromEntries(h.map((k, i) => [k.trim(), (r[i] ?? "").trim()])));
}
