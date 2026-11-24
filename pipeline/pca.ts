import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pcaRecord, type CensusUnit, type PcaRecord } from "./census";
import { sheetNames, xlsxRows } from "./xlsx";

/** Read one PCA TV workbook (DDW_PCA28NN_2011_MDDS with UI.xlsx): district, sub-district, village and town rows. Ward rows are ignored. */
export async function readPcaFile(path: string): Promise<PcaRecord[]> {
  const out: PcaRecord[] = [];
  const [sheet] = await sheetNames(path);
  let header: Record<string, string> | null = null;
  for await (const row of xlsxRows(path, sheet)) {
    if (!header) { header = row; continue; }
    const rec: Record<string, string> = {};
    for (const [col, v] of Object.entries(row)) if (header[col]) rec[header[col]] = v;
    const r = pcaRecord(rec);
    if (r) out.push(r);
  }
  return out;
}

export async function readPcaDir(dir: string): Promise<{ files: string[]; rows: PcaRecord[] }> {
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /^DDW_PCA28\d\d_2011.*\.xlsx$/i.test(f)).sort() : [];
  const rows: PcaRecord[] = [];
  for (const f of files) rows.push(...(await readPcaFile(resolve(dir, f))));
  return { files, rows };
}

export interface LiteracyMerge { matched: number; missing: string[]; mismatched: string[] }

/**
 * Attach PCA literates and population aged 0-6 to village/town units, joining on the Census 2011 district and village/town code.
 * A unit is only filled when its PCA population equals the DCHB population (a mismatch is reported and left without literacy).
 * Villages join to PCA VILLAGE rows, towns to PCA TOWN rows (statutory and census towns).
 */
export function applyPcaLiteracy(units: CensusUnit[], pca: PcaRecord[]): LiteracyMerge {
  const idx = new Map<string, PcaRecord>();
  for (const r of pca) {
    if (r.level === "VILLAGE" && r.tru === "Rural") idx.set(`V|${r.districtCode}|${r.code}`, r);
    else if (r.level === "TOWN" && r.tru === "Urban") idx.set(`T|${r.districtCode}|${r.code}`, r);
  }
  const res: LiteracyMerge = { matched: 0, missing: [], mismatched: [] };
  for (const u of units) {
    const id = `${u.kind}|${u.districtCode}|${u.code}`;
    const r = idx.get(id);
    if (!r) { res.missing.push(`${id} ${u.name}`); continue; }
    if (r.population !== u.population) { res.mismatched.push(`${id} ${u.name} dchb=${u.population} pca=${r.population}`); continue; }
    u.literate = r.literate; u.pop0to6 = r.pop0to6;
    res.matched++;
  }
  return res;
}
