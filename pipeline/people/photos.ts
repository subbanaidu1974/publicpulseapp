/**
 * S-110: resolve winner photos from Wikimedia Commons into data/reference/people/photos.json (+ small thumbnails in public/people/).
 *   npx tsx pipeline/people/photos.ts [--download]
 * Politeness: <= 8 requests in a row, then a 6 s pause; descriptive User-Agent. Matching is strict (see match.ts).
 * Only CC0 / PD / CC BY / CC BY-SA are accepted and the author + licence are recorded for display.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CandidateResult } from "../../src/lib/elections";
import { ROOT, writeJson } from "../io";
import { classifyLicence, namesMatch, plainText, seatKey } from "./match";

const UA = "PeoplePulseBot/0.1 (civic data pipeline; photo attribution lookup; see repository README)";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let burst = 0;
async function polite<T>(fn: () => Promise<T>): Promise<T> {
  if (burst >= 8) { await sleep(6000); burst = 0; }
  burst++;
  return fn();
}

// Wikidata position items: Member of the 16th AP Legislative Assembly, Member of the Telangana Legislative Assembly (no per-term item exists), Member of the 18th Lok Sabha.
const TERMS: { state: "AP" | "TG"; type: "assembly" | "ls"; year: number; pos: string }[] = [
  { state: "AP", type: "assembly", year: 2024, pos: "Q126414673" },
  { state: "TG", type: "assembly", year: 2023, pos: "Q24331572" },
  { state: "AP", type: "ls", year: 2024, pos: "Q125498038" },
  { state: "TG", type: "ls", year: 2024, pos: "Q125498038" },
];

interface Hit { qid: string; label: string; file: string; dist: string; pos: string }

async function sparql(): Promise<Hit[]> {
  const q = `SELECT ?p ?pLabel ?img ?distLabel ?pos WHERE {
    ?p wdt:P18 ?img; p:P39 ?st. ?st ps:P39 ?pos; pq:P768 ?dist.
    VALUES ?pos { wd:Q126414673 wd:Q24331572 wd:Q125498038 }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
  const r = await polite(() => fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { "User-Agent": UA, Accept: "application/sparql-results+json" } }));
  if (!r.ok) throw new Error("SPARQL " + r.status);
  const j = await r.json() as { results: { bindings: Record<string, { value: string }>[] } };
  return j.results.bindings.map(b => ({
    qid: b.p.value.split("/").pop()!, label: b.pLabel.value,
    file: decodeURIComponent(b.img.value.split("/Special:FilePath/").pop()!), dist: b.distLabel.value, pos: b.pos.value.split("/").pop()!,
  }));
}

interface Meta { licence: string | null; licenceUrl: string | null; author: string; descUrl: string; attributionRequired: boolean }
async function commonsMeta(files: string[]): Promise<Map<string, Meta>> {
  const out = new Map<string, Meta>();
  for (let i = 0; i < files.length; i += 40) {
    const titles = files.slice(i, i + 40).map(f => "File:" + f).join("|");
    const u = "https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata|url&format=json&titles=" + encodeURIComponent(titles);
    const r = await polite(() => fetch(u, { headers: { "User-Agent": UA } }));
    if (!r.ok) throw new Error("Commons " + r.status);
    const j = await r.json() as { query: { pages: Record<string, { title: string; imageinfo?: { descriptionurl: string; extmetadata?: Record<string, { value: string }> }[] }> } };
    for (const p of Object.values(j.query.pages)) {
      const ii = p.imageinfo?.[0]; const m = ii?.extmetadata;
      if (!ii || !m) continue;
      out.set(p.title.replace(/^File:/, ""), {
        licence: m.LicenseShortName?.value ?? null, licenceUrl: m.LicenseUrl?.value ?? null,
        author: plainText(m.Artist?.value) || "Unknown", descUrl: ii.descriptionurl,
        attributionRequired: (m.AttributionRequired?.value ?? "").toLowerCase() === "true",
      });
    }
  }
  return out;
}

async function main() {
  const download = process.argv.includes("--download");
  const snap = JSON.parse(readFileSync(resolve(ROOT, "data/generated/elections.json"), "utf8")) as { results: CandidateResult[] };
  const winners = snap.results.filter(r => r.position === 1);
  const hits = await sparql();
  console.log(`[photos] ${hits.length} Wikidata member statements with P18 and P768`);
  const norm = (f: string) => f.replace(/_/g, " ");

  const matched = new Map<string, { w: CandidateResult; h: Hit }>();
  const ambiguous = new Set<string>();
  for (const t of TERMS) {
    for (const w of winners.filter(x => x.state === t.state && x.type === t.type && x.year === t.year)) {
      const cands = hits.filter(h => h.pos === t.pos && seatKey(h.dist) === seatKey(w.acName) && namesMatch(h.label, w.candidate));
      const key = `${w.state}-${w.type}-${w.acNo}`;
      const uniq = [...new Set(cands.map(c => c.qid))];
      if (uniq.length === 1) matched.set(key, { w, h: cands[0] });
      else if (uniq.length > 1) ambiguous.add(key);
    }
  }
  const meta = await commonsMeta([...new Set([...matched.values()].map(m => norm(m.h.file)))]);
  const entries: Record<string, unknown> = {};
  const rejected: { key: string; file: string; reason: string }[] = [];
  mkdirSync(resolve(ROOT, "public/people"), { recursive: true });
  for (const [key, { w, h }] of matched) {
    const m = meta.get(norm(h.file));
    const v = classifyLicence(m?.licence);
    if (!m || !v.ok) { rejected.push({ key, file: h.file, reason: v.reason ?? "no metadata" }); continue; }
    const entry: Record<string, unknown> = {
      name: w.candidate, party: w.party, acName: w.acName, wikidata: h.qid, matchBasis: "P39+P768 constituency and name match",
      file: norm(h.file), author: m.author, licence: v.code, licenceName: m.licence, licenceUrl: m.licenceUrl, source: m.descUrl, attributionRequired: m.attributionRequired,
    };
    if (download) {
      const url = "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(norm(h.file)) + "?width=240";
      const r = await polite(() => fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" }));
      if (!r.ok) { rejected.push({ key, file: h.file, reason: "download " + r.status }); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get("content-type") ?? "";
      if (!/^image\/(jpeg|png|webp)/.test(ct)) { rejected.push({ key, file: h.file, reason: "unexpected content-type " + ct }); continue; }
      const rel = `people/${key}.${ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg"}`;
      writeFileSync(resolve(ROOT, "public", rel), buf);
      entry.path = "/" + rel; entry.bytes = buf.length; entry.sha256 = createHash("sha256").update(buf).digest("hex");
    }
    entries[key] = entry;
  }
  const seatsOf = (st: string, ty: string) => winners.filter(x => x.type === ty && x.state === st && x.year === (ty === "assembly" ? (st === "AP" ? 2024 : 2023) : 2024)).length;
  const coverage = Object.fromEntries(["AP-assembly", "TG-assembly", "AP-ls", "TG-ls"].map(k => {
    const [st, ty] = k.split("-");
    return [k, { seats: seatsOf(st, ty), photos: Object.keys(entries).filter(e => e.startsWith(k)).length }];
  }));
  const out = {
    schema: 1, asOf: new Date().toISOString().slice(0, 10),
    note: "Winner photos resolved from Wikimedia Commons. A photo is attached only when the Wikidata member statement (P39) names this constituency via P768 AND the name matches the TCPD candidate; anything else gets an initials avatar. Licences accepted: CC0, public domain, CC BY, CC BY-SA. Takedowns (S-113) hide a photo immediately via the people_takedowns table.",
    coverage, rejected, ambiguous: [...ambiguous], entries,
  };
  writeJson(resolve(ROOT, "data/reference/people/photos.json"), out);
  console.log("[photos] coverage", JSON.stringify(coverage), "rejected", rejected.length, "ambiguous", ambiguous.size);
}
main().catch(e => { console.error(e); process.exit(1); });
