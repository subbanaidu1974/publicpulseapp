/**
 * Merge Census 2011 Primary Census Abstract (PCA) literacy into the committed census snapshots (district, sub-district
 * and village/town), keyed by Census 2011 codes. Run after scripts/ingest-dchb-census.ts (which rewrites those files
 * without literacy).
 *
 * Source (no login, verified 2026-11-24): Census Digital Library, https://censusindia.gov.in/nada/index.php/catalog/6723 to 6745
 *   "PCA TV: Primary census abstract at town, village and ward level, Andhra Pradesh - District <name> - 2011"
 *   one workbook per 2011 district: DDW_PCA2801_2011_MDDS with UI.xlsx ... DDW_PCA2823_2011_MDDS with UI.xlsx
 *   (download id = catalog id + 3077; e.g. https://censusindia.gov.in/nada/index.php/catalog/6723/download/9800/...).
 * Usage:
 *   tsx scripts/ingest-pca-literacy.ts --download     # fetch the 23 workbooks into data/raw/census/pca/ (gitignored)
 *   tsx scripts/ingest-pca-literacy.ts                # merge from the files already there
 * Never invents numbers: units whose PCA population does not equal the DCHB population are left without literacy and listed.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, ROOT, writeJson } from "../pipeline/io";
import { literacyRate, parseUnitRows, rollupDistricts, rollupSubDistricts, validatePca } from "../pipeline/census";
import { applyPcaLiteracy, readPcaDir } from "../pipeline/pca";

const RAW = resolve(ROOT, "data/raw/census/pca");
const PCA_SOURCE = "Census of India 2011, Primary Census Abstract (PCA TV, village/town level), Andhra Pradesh districts 2801 to 2823 (ORGI, censusindia.gov.in Census Digital Library, catalog/6723 to 6745)";

async function download(): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  for (let i = 1; i <= 23; i++) {
    const n = 2800 + i, cat = 6722 + i, id = 9799 + i;
    const name = `DDW_PCA${n}_2011_MDDS with UI.xlsx`;
    const dest = resolve(RAW, `DDW_PCA${n}_2011_MDDS_with_UI.xlsx`);
    if (existsSync(dest) && statSync(dest).size > 50000) continue;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`https://censusindia.gov.in/nada/index.php/catalog/${cat}/download/${id}/${encodeURIComponent(name)}`, { headers: { "User-Agent": "PeoplePulse-pipeline/0.1 (open-data ingest)" } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const out = createWriteStream(dest);
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) if (!out.write(chunk)) await new Promise<void>(r => out.once("drain", () => r()));
        await new Promise<void>(r => out.end(() => r()));
        console.log(`[pca] downloaded ${name}`);
        break;
      } catch (e) {
        if (attempt >= 3) throw new Error(`download ${name}: ${(e as Error).message}`);
      }
    }
  }
}

async function main() {
  if (process.argv.includes("--download")) await download();
  const { files, rows } = await readPcaDir(RAW);
  if (files.length !== 23) throw new Error(`expected 23 PCA workbooks in ${RAW}, found ${files.length}; run with --download`);
  const pcaErrs = validatePca(rows);
  if (pcaErrs.length) console.warn(`[pca] WARNING: ${pcaErrs.length} PCA consistency violations (first 5):\n  ${pcaErrs.slice(0, 5).join("\n  ")}`);

  const unitsFile = JSON.parse(readFileSync(resolve(GENERATED, "census-units.json"), "utf8")) as { columns: string[]; units: (string | number | null)[][]; [k: string]: unknown };
  const units = parseUnitRows(unitsFile.columns, unitsFile.units);
  const merge = applyPcaLiteracy(units, rows);
  console.log(`[pca] units=${units.length} matched=${merge.matched} missing=${merge.missing.length} mismatched=${merge.mismatched.length}`);
  for (const m of [...merge.missing, ...merge.mismatched].slice(0, 10)) console.log(`  unmatched: ${m}`);
  const covered = merge.matched === units.length;

  // Re-emit the unit rows with literacy columns (positional order kept: new columns are appended).
  const UNIT_COLS = ["kind", "state", "districtCode", "subDistrictCode", "code", "name", "households", "population", "males", "females", "scPop", "stPop", "literate", "pop0to6"];
  const base = unitsFile.units.map((r, i) => [...r.slice(0, 12), units[i].literate ?? null, units[i].pop0to6 ?? null]);
  // provenance keeps its original value (guards in refresh/quality key on it); the source string records the PCA join.
  const prov = (old: string) => old;
  writeJson(resolve(GENERATED, "census-units.json"), {
    ...unitsFile, provenance: prov(String(unitsFile.provenance)), source: `${unitsFile.source}; literacy: ${PCA_SOURCE}`, columns: UNIT_COLS, units: base,
  });

  // Roll the merged units up and patch the existing district / sub-district objects (names and other fields are kept).
  const names = (u: unknown) => u as Record<string, unknown>;
  const dFile = JSON.parse(readFileSync(resolve(GENERATED, "census.json"), "utf8")) as Record<string, unknown> & { districts: Record<string, unknown>[] };
  const sFile = JSON.parse(readFileSync(resolve(GENERATED, "census-subdistricts.json"), "utf8")) as Record<string, unknown> & { subDistricts: Record<string, unknown>[] };
  const roll = rollupDistricts(units, "");
  const sroll = rollupSubDistricts(units);

  // District literacy comes from the PCA district Total row (authoritative); the unit rollup is cross-checked against it.
  const pcaDistrict = new Map(rows.filter(r => r.level === "DISTRICT" && r.tru === "Total").map(r => [r.districtCode, r]));
  const drift: string[] = [];
  for (const d of dFile.districts) {
    const code = String(d.districtCode);
    const p = pcaDistrict.get(code);
    if (!p) throw new Error(`no PCA district row for ${code}`);
    if (p.population !== d.population) throw new Error(`district ${code} population differs: dchb=${String(d.population)} pca=${p.population}`);
    Object.assign(d, {
      literate: p.literate, pop0to6: p.pop0to6, literateMales: p.literateMales, literateFemales: p.literateFemales,
      literacyPct: literacyRate(p.literate, p.population, p.pop0to6),
    });
    const r = roll.find(x => x.districtCode === code);
    if (covered && r && r.literate !== p.literate) drift.push(`district ${code}: unit rollup ${r.literate} vs PCA ${p.literate}`);
  }
  // Sub-district (mandal) literacy: the PCA SUB-DISTRICT Total row when its population equals the DCHB sub-district population;
  // otherwise the unit rollup when every unit matched; otherwise left out (never estimated).
  const pcaSub = new Map(rows.filter(r => r.level === "SUB-DISTRICT" && r.tru === "Total").map(r => [`${r.districtCode}|${r.subDistrictCode}`, r]));
  let fromPca = 0, fromUnits = 0;
  for (const s of sFile.subDistricts) {
    const p = pcaSub.get(`${String(s.districtCode)}|${String(s.subDistrictCode)}`);
    const r = sroll.find(x => x.districtCode === s.districtCode && x.subDistrictCode === s.subDistrictCode);
    for (const k of ["literate", "pop0to6", "literacyPct"]) delete names(s)[k];
    if (p && p.population === s.population) {
      Object.assign(s, { literate: p.literate, pop0to6: p.pop0to6, literacyPct: literacyRate(p.literate, p.population, p.pop0to6) }); fromPca++;
    } else if (r && r.literate !== undefined) { Object.assign(s, { literate: r.literate, pop0to6: r.pop0to6, literacyPct: r.literacyPct }); fromUnits++; }
  }
  console.log(`[pca] sub-district literacy: ${fromPca} from PCA sub-district rows, ${fromUnits} from unit rollups`);
  if (drift.length) console.warn(`[pca] WARNING: ${drift.length} district rollups differ from the PCA district totals:\n  ${drift.slice(0, 5).join("\n  ")}`);
  writeJson(resolve(GENERATED, "census.json"), {
    ...dFile, provenance: prov(String(dFile.provenance)), source: `${dFile.source}; literacy: ${PCA_SOURCE}`, districts: dFile.districts.map(d => ({ ...d, source: `${String(d.source)}; literacy: ${PCA_SOURCE}` })),
  });
  writeJson(resolve(GENERATED, "census-subdistricts.json"), { ...sFile, provenance: prov(String(sFile.provenance)), source: `${sFile.source}; literacy: ${PCA_SOURCE}` });
  console.log(`[pca] districts=${dFile.districts.length} subDistricts=${sFile.subDistricts.length} (with literacy: ${sFile.subDistricts.filter(s => s.literate !== undefined).length})`);
}

main().catch(e => { console.error("[pca] failed:", (e as Error).message); process.exit(1); });
