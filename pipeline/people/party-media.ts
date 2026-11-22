/**
 * S-104: fetch the party flag/symbol files named in data/reference/parties.json from Wikimedia Commons at build time, re-check each
 * file's licence through the Commons API, store a small raster copy in public/party/ and record sha256 + credit in
 * data/reference/people/party-media.json. The browser then never contacts a third party (no CSP change needed).
 *   npx tsx pipeline/people/party-media.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, writeJson } from "../io";
import { classifyLicence, plainText } from "./match";

const UA = "PeoplePulseBot/0.1 (civic data pipeline; party media licence check; see repository README)";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let burst = 0;
async function polite<T>(fn: () => Promise<T>): Promise<T> {
  if (burst >= 8) { await sleep(6000); burst = 0; }
  burst++;
  return fn();
}

interface Media { commonsFile: string; use: string; restrictions?: string }
async function main() {
  const reg = JSON.parse(readFileSync(resolve(ROOT, "data/reference/parties.json"), "utf8")) as { parties: { code: string; flag: Media | null; symbol: Media | null }[] };
  mkdirSync(resolve(ROOT, "public/party"), { recursive: true });
  const entries: Record<string, unknown> = {};
  const rejected: { key: string; file: string; reason: string }[] = [];
  for (const p of reg.parties) for (const kind of ["flag", "symbol"] as const) {
    const m = p[kind];
    if (!m) continue;
    const key = `${p.code}-${kind}`;
    const api = "https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata|url&format=json&titles=" + encodeURIComponent("File:" + m.commonsFile);
    const j = await (await polite(() => fetch(api, { headers: { "User-Agent": UA } }))).json() as { query: { pages: Record<string, { imageinfo?: { descriptionurl: string; extmetadata?: Record<string, { value: string }> }[] }> } };
    const ii = Object.values(j.query.pages)[0]?.imageinfo?.[0];
    const v = classifyLicence(ii?.extmetadata?.LicenseShortName?.value);
    if (!ii || !v.ok) { rejected.push({ key, file: m.commonsFile, reason: v.reason ?? "no metadata" }); continue; }
    const url = "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(m.commonsFile) + "?width=160";
    const r = await polite(() => fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" }));
    const ct = r.headers.get("content-type") ?? "";
    if (!r.ok || !/^image\/(png|jpeg|webp)/.test(ct)) { rejected.push({ key, file: m.commonsFile, reason: `download ${r.status} ${ct}` }); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    const rel = `party/${key}.${ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg"}`;
    writeFileSync(resolve(ROOT, "public", rel), buf);
    entries[key] = {
      code: p.code, kind, path: "/" + rel, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"),
      commonsFile: m.commonsFile, author: plainText(ii.extmetadata?.Artist?.value) || "Unknown", licence: v.code, licenceName: ii.extmetadata?.LicenseShortName?.value,
      licenceUrl: ii.extmetadata?.LicenseUrl?.value ?? null, source: ii.descriptionurl, use: m.use, restrictions: m.restrictions ?? null,
      verified: new Date().toISOString().slice(0, 10),
    };
  }
  writeJson(resolve(ROOT, "data/reference/people/party-media.json"), {
    schema: 1, asOf: new Date().toISOString().slice(0, 10),
    note: "Raster copies (160 px wide) of Wikimedia Commons party flags/symbols whose licence was re-verified by the Commons API when fetched. 'identification-only' files are captioned 'shown to identify the party'. Rejected files fall back to a text chip.",
    rejected, entries,
  });
  console.log(`[party-media] ${Object.keys(entries).length} files, ${rejected.length} rejected`, JSON.stringify(rejected));
}
main().catch(e => { console.error(e); process.exit(1); });
