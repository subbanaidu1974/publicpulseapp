/**
 * S-196: Telugu village names for Andhra Pradesh. The LGD directory holds Telugu names for only 372 of 17,957 AP villages, so this asks
 * Wikidata (CC0) for items inside AP that carry a Census 2011 code (P5578) AND a Telugu label, one SPARQL request. Names are keyed by the
 * Census 2011 code, which build-village-labels joins to the LGD village. Never guessed: a village with no Telugu label on Wikidata stays out.
 * Output data/generated/geo/village-names-te-AP.json: { names: [[censusCode, te, qid], ...] }. Generic User-Agent, one request.
 * Usage: npx tsx scripts/fetch-village-names-te.ts
 */
import { join } from "node:path";
import { stateQid, WIKIDATA_ENDPOINT } from "../pipeline/geo/names";
import { GEO_OUT, writeCompact } from "../pipeline/geo/util";

const UA = "TeluguPulseGeoPipeline/1.0 (open civic data research; low-volume)";
const q = `SELECT ?item ?cen ?te WHERE { ?item wdt:P5578 ?cen; wdt:P131+ wd:${stateQid("AP")}. ?item rdfs:label ?te FILTER(lang(?te)="te") }`;

async function main() {
  let rows: any[] | null = null;
  for (let attempt = 0; attempt < 3 && !rows; attempt++) {
    const res = await fetch(`${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(q)}`, { headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(170000) });
    if (res.ok) rows = (await res.json()).results.bindings;
    else if (attempt < 2) await new Promise((r) => setTimeout(r, 20000 * (attempt + 1)));
    else throw new Error(`Wikidata HTTP ${res.status}`);
  }
  const byCode = new Map<string, [string, string, string]>();
  let conflicts = 0;
  for (const r of rows ?? []) {
    const code = String(r.cen.value).trim(), te = String(r.te.value).trim(), qid = String(r.item.value).split("/").pop()!;
    if (!/^\d{5,7}$/.test(code) || !/[\u0C00-\u0C7F]/.test(te)) continue;
    const cur = byCode.get(code);
    if (cur && cur[1] !== te) { conflicts++; byCode.delete(code); byCode.set(code, ["", "", ""]); continue; } // two different names for one code: unusable, drop it
    if (!cur) byCode.set(code, [code, te, qid]);
  }
  const names = [...byCode.values()].filter((v) => v[1]).sort((a, b) => Number(a[0]) - Number(b[0]));
  writeCompact(join(GEO_OUT, "village-names-te-AP.json"), {
    schema: 1, state: "AP", asOf: new Date().toISOString().slice(0, 10), source: `${WIKIDATA_ENDPOINT} (CC0), 1 request`, licence: "CC0-1.0",
    note: `Wikidata items inside Andhra Pradesh with a Census 2011 code and a Telugu label (${rows?.length ?? 0} rows). ${conflicts} census codes had two different Telugu names and were dropped. Never guessed.`,
    columns: ["censusCode", "te", "qid"], names,
  }, 3);
  console.log(`AP: ${names.length} Telugu village names keyed by census code (${rows?.length ?? 0} rows, ${conflicts} conflicting codes dropped)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
