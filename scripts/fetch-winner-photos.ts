/**
 * S-198: photos of winning candidates, free-licence only. Reads the hand-checked list data/reference/winner-photos.json
 * (state, year, constituency number, candidate, Wikimedia Commons file name), asks Commons for each file's licence and credit,
 * and downloads a 320 px copy ONLY when the licence is on the allow list below. Anything else is skipped and reported.
 * Output: data/generated/photos/<ST>-<year>-<acNo>.<ext> and data/generated/photos/index.json (credit, licence, source page).
 * The site serves these from its own server; no image is ever loaded from Commons by a visitor's browser.
 * Usage: npx tsx scripts/fetch-winner-photos.ts   (about 60 requests to commons.wikimedia.org, low volume)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const UA = "TeluguPulseGeoPipeline/1.0 (open civic data research; low-volume)";
const OUT = join("data", "generated", "photos");
const ALLOW = /^(CC0|Public domain|CC BY(-SA)? [0-9.]+|GODL-India)$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

interface Entry { state: string; year: number; acNo: number; candidate: string; file: string }
const list: Entry[] = JSON.parse(readFileSync(join("data", "reference", "winner-photos.json"), "utf8"));
mkdirSync(OUT, { recursive: true });
const index: Record<string, unknown>[] = [];
const skipped: string[] = [];
for (const e of list) {
  const api = "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=320&titles=" + encodeURIComponent("File:" + e.file);
  let info: any;
  for (let a = 0; a < 6 && !info; a++) {
    const r = await fetch(api, { headers: { "User-Agent": UA } });
    const txt = await r.text();
    try { info = Object.values(JSON.parse(txt).query.pages as Record<string, any>)[0]?.imageinfo?.[0]; break; } catch { await sleep(15000 * (a + 1)); } // rate limited: back off
  }
  const md = info?.extmetadata ?? {};
  const lic = String(md.LicenseShortName?.value ?? "");
  if (!info || md.NonFree?.value === "true" || !ALLOW.test(lic)) { skipped.push(`${e.state} ${e.acNo} ${e.file}: licence "${lic}"`); continue; }
  const ext = extname(new URL(info.thumburl ?? "https://x/y.jpg").pathname).toLowerCase() || ".jpg";
  const name = `${e.state}-${e.year}-${e.acNo}${ext}`;
  const img = await fetch(info.thumburl, { headers: { "User-Agent": UA } });
  if (!img.ok) { skipped.push(`${e.state} ${e.acNo} ${e.file}: download ${img.status}`); await sleep(1500); continue; }
  writeFileSync(join(OUT, name), Buffer.from(await img.arrayBuffer()));
  index.push({ state: e.state, year: e.year, acNo: e.acNo, candidate: e.candidate, file: name, author: plain(String(md.Artist?.value ?? "")) || null, licence: lic, licenceUrl: md.LicenseUrl?.value ?? null, source: info.descriptionurl });
  await sleep(1500);
}
writeFileSync(join(OUT, "index.json"), JSON.stringify({ schema: 1, note: "Photos from Wikimedia Commons under free licences, copied to this server. Matched to the winner by name by hand-checked list; a wrong photo should be reported.", photos: index }, null, 1));
console.log(`${index.length} photos saved, ${skipped.length} skipped`);
for (const s of skipped) console.log("  skipped:", s);
