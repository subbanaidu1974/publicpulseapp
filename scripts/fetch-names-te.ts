/**
 * S-83: Telugu gazetteer. Wikidata SPARQL (districts, mandals, assembly and parliamentary constituencies) plus the Telugu
 * names already carried by LGD (villages, GPs, urban bodies). Output data/generated/geo/names-te.json with a coverage
 * report per level. Names are never invented: a unit without a Telugu label stays absent and is counted as a gap.
 * Needs the committed fetch-lgd / fetch-boundaries outputs. At most 6 requests, 6 s apart, generic User-Agent.
 * Usage: npx tsx scripts/fetch-names-te.ts
 */
import { join } from "node:path";
import type { StateCode } from "../src/lib/states";
import { coverage, matchUnits, parseWd, stripAc, stripDistrict, stripMandal, stripTeAc, stripTeDistrict, stripTeMandal, stripTePc, WD, WIKIDATA_ENDPOINT, type WdItem } from "../pipeline/geo/names";
import { GEO_OUT, readJsonFile, writeCompact } from "../pipeline/geo/util";

const UA = "TeluguPulseGeoPipeline/1.0 (open civic data research; low-volume)";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function sparql(q: string): Promise<WdItem[]> {
  if (requests >= 8) throw new Error("request budget exhausted");
  if (requests++) await sleep(6000);
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(90000) });
    if (res.ok) return parseWd(await res.json());
    if (attempt === 0) await sleep(10000);
    else throw new Error(`Wikidata HTTP ${res.status}`);
  }
  return [];
}
const labels = `OPTIONAL{?item rdfs:label ?en FILTER(lang(?en)="en")} OPTIONAL{?item rdfs:label ?te FILTER(lang(?te)="te")}`;
const parent = `OPTIONAL{?item wdt:P131 ?p. ?p rdfs:label ?parentLabel FILTER(lang(?parentLabel)="en")}`;
const byClass = (cls: string) => `SELECT ?item ?en ?te ?parentLabel WHERE { ?item wdt:P31 wd:${cls}. ${labels} ${parent} }`;

async function main() {
  const lgd: Record<StateCode, any> = { AP: readJsonFile(join(GEO_OUT, "lgd-AP.json")), TG: readJsonFile(join(GEO_OUT, "lgd-TG.json")) };
  const link = readJsonFile(join(GEO_OUT, "ac-link.json")).rows as { state: StateCode; acNo: number; name: string }[];
  const units = readJsonFile(join(GEO_OUT, "ac-units.json")).units;
  const pcFc: Record<StateCode, any> = { AP: readJsonFile(join(GEO_OUT, "pc-AP.geojson")), TG: readJsonFile(join(GEO_OUT, "pc-TG.geojson")) };

  const districts = await sparql(`SELECT ?item ?en ?te ?parentLabel WHERE { VALUES ?s { wd:${WD.stateAP} wd:${WD.stateTG} } ?item wdt:P31 wd:${WD.districtOfIndia}; wdt:P131 ?s. ${labels} ?s rdfs:label ?parentLabel FILTER(lang(?parentLabel)="en") }`);
  const mandals: Record<StateCode, WdItem[]> = { AP: await sparql(byClass(WD.mandalAP)), TG: await sparql(byClass(WD.mandalTG)) };
  const acs: Record<StateCode, WdItem[]> = { AP: await sparql(byClass(WD.acAP)), TG: await sparql(byClass(WD.acTG)) };
  const qids = ["AP", "TG"].flatMap(s => pcFc[s as StateCode].features.map((f: any) => f.properties.wikidata_qid)).filter(Boolean);
  const pcs = await sparql(`SELECT ?item ?en ?te WHERE { VALUES ?item { ${qids.map(q => `wd:${q}`).join(" ")} } ${labels} }`);

  const out: Record<string, any> = { districts: { AP: {}, TG: {} }, mandals: { AP: {}, TG: {} }, acs: { AP: {}, TG: {} }, pcs: { AP: {}, TG: {} } };
  const qid: Record<string, any> = { districts: { AP: {}, TG: {} }, mandals: { AP: {}, TG: {} }, acs: { AP: {}, TG: {} }, pcs: { AP: {}, TG: {} } };
  const cov: Record<string, any> = {}, gaps: Record<string, any> = {};
  const put = (lvl: string, st: StateCode, m: Map<string, { te: string; qid: string }>) => { for (const [k, v] of m) { out[lvl][st][k] = v.te; qid[lvl][st][k] = v.qid; } };

  for (const st of ["AP", "TG"] as StateCode[]) {
    const stateName = st === "AP" ? "Andhra Pradesh" : "Telangana";
    const dItems = districts.filter(d => d.parent === stateName);
    const dUnits = lgd[st].districts.map((d: string[]) => ({ id: d[0], name: d[1] }));
    const dm = matchUnits(dUnits, dItems, stripDistrict, stripTeDistrict);
    put("districts", st, dm.matched);
    cov[`districts.${st}`] = coverage(dUnits.length, dm.matched.size);
    gaps[`districts.${st}`] = [...dm.unmatched, ...dm.ambiguous.map(a => `${a} (ambiguous)`)];

    const dname = new Map<string, string>(lgd[st].districts.map((d: string[]) => [d[0], d[1]]));
    const mUnits = lgd[st].mandals.map((m: string[]) => ({ id: m[0], name: m[1], hint: dname.get(m[2]) }));
    const mm = matchUnits(mUnits, mandals[st], stripMandal, stripTeMandal);
    put("mandals", st, mm.matched);
    cov[`mandals.${st}`] = coverage(mUnits.length, mm.matched.size);
    gaps[`mandals.${st}`] = { unmatched: mm.unmatched.length, ambiguous: mm.ambiguous.length, sample: mm.unmatched.slice(0, 15) };

    const aUnits = link.filter(r => r.state === st).map(r => ({ id: String(r.acNo), name: r.name, hint: dname.get(units[st][String(r.acNo)]?.district) }));
    const am = matchUnits(aUnits, acs[st], stripAc, stripTeAc);
    put("acs", st, am.matched);
    cov[`acs.${st}`] = coverage(aUnits.length, am.matched.size);
    gaps[`acs.${st}`] = [...am.unmatched, ...am.ambiguous.map(a => `${a} (ambiguous)`)];

    const pUnits = pcFc[st].features.map((f: any) => ({ id: String(f.properties.pcNo), name: f.properties.pcName, qid: f.properties.wikidata_qid }));
    let pn = 0;
    for (const u of pUnits) {
      const it = pcs.find(i => i.qid === u.qid);
      if (it?.te) { out.pcs[st][u.id] = stripTePc(it.te); qid.pcs[st][u.id] = u.qid; pn++; }
    }
    cov[`pcs.${st}`] = coverage(pUnits.length, pn);
    gaps[`pcs.${st}`] = pUnits.filter((u: any) => !out.pcs[st][u.id]).map((u: any) => `${u.id} ${u.name}`);

    // LGD-carried names (no Wikidata involved)
    cov[`villages.${st}`] = coverage(lgd[st].villages.length, lgd[st].villages.filter((v: any[]) => v[2]).length);
    cov[`gps.${st}`] = coverage(lgd[st].gps.length, lgd[st].gps.filter((v: any[]) => v[2]).length);
    cov[`urbanBodies.${st}`] = coverage(lgd[st].urbanBodies.length, lgd[st].urbanBodies.filter((v: any[]) => v[2]).length);
    cov[`blocks.${st}`] = coverage(lgd[st].blocks.length, lgd[st].blocks.filter((v: any[]) => v[2]).length);
  }
  const doc = {
    schema: 1,
    sources: { wikidata: `${WIKIDATA_ENDPOINT} (CC0), ${requests} requests`, lgd: "village/GP/urban-body/block Telugu names are read from lgd-AP.json / lgd-TG.json (nameTe column)" },
    note: "Keys: district and mandal = LGD code, acs = state-specific acNo, pcs = pcNo. Missing key = no Telugu name found (never guessed). qid = Wikidata item of the match.",
    coverage: cov, gaps, names: out, qid,
  };
  writeCompact(join(GEO_OUT, "names-te.json"), doc, 3);
  for (const [k, v] of Object.entries(cov)) console.log(`[names-te] ${k}: ${(v as any).withTelugu}/${(v as any).total} (${(v as any).pct}%)`);
}
main().catch(e => { console.error("[names-te] FAILED:", (e as Error).message); process.exitCode = 1; });
