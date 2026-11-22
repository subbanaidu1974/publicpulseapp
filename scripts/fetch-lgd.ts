/**
 * S-80/S-81/S-102: LGD ingest. Downloads the LGD Parquet mirror tables (cached, sha256 verified), maps AP/TG to compact
 * JSON under data/generated/geo/: lgd-AP.json, lgd-TG.json, ac-units.json, ac-link.json, review.json.
 * Idempotent: the output depends only on the source file hashes (no wall-clock stamps).
 * Usage: npx tsx scripts/fetch-lgd.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StateCode } from "../src/lib/states";
import { reconcileReservation, readAcShapefile } from "../pipeline/geo/boundaries";
import { parse2008 } from "../pipeline/geo/constituency";
import { buildAcLink } from "../pipeline/geo/link";
import { buildAcUnits, buildLgdState, LGD_STATE, majorityDistrict, type LgdTables, type SourceStamp } from "../pipeline/geo/lgd";
import { readParquet } from "../pipeline/geo/parquet";
import { cached, GEO_OUT, lgdMetadata, lgdTable, SRC, writeCompact } from "../pipeline/geo/util";

const NEEDED: Record<keyof LgdTables, string> = {
  districts: "districts", subdistricts: "subdistricts", blocks: "blocks", villages: "villages", villagesByBlocks: "villages_by_blocks",
  priLocalBodies: "pri_local_bodies", urbanLocalBodies: "urban_local_bodies", urbanWards: "urban_local_body_wards",
  mappingPri: "constituencies_mapping_pri", mappingUrban: "constituencies_mapping_urban",
  assemblyConstituencies: "assembly_constituencies", parliamentConstituencies: "parliament_constituencies",
};

export async function loadLgdTables(): Promise<{ tables: LgdTables; sources: Record<string, SourceStamp> }> {
  const meta = await lgdMetadata();
  const tables: any = {}, sources: Record<string, SourceStamp> = {};
  const keep = new Set(Object.values(LGD_STATE));
  for (const [key, name] of Object.entries(NEEDED)) {
    const t = await lgdTable(meta, name);
    const rows = await readParquet(t.path);
    tables[key] = rows.filter(r => keep.has(String(r.state_code)));
    sources[name] = { sha256: t.sha256, observedOn: t.observedOn, rows: t.rows };
    console.log(`[fetch-lgd] ${name}: ${rows.length} rows, ${tables[key].length} for AP/TG (observed ${t.observedOn})`);
  }
  return { tables: tables as LgdTables, sources };
}

async function main() {
  const { tables, sources } = await loadLgdTables();
  const csv = readFileSync(await cached("2008-constituencies.csv", SRC.c2008), "utf8");
  const meta2008 = parse2008(csv);
  const raw = await readAcShapefile(await cached("India_AC.shp", SRC.acShp("shp")), await cached("India_AC.dbf", SRC.acShp("dbf")));
  meta2008.acs = reconcileReservation(meta2008.acs, raw.rows).acs;
  if (meta2008.errors.length) console.warn("[fetch-lgd] 2008 table issues:", meta2008.errors.slice(0, 5));

  const unitsOut: Record<string, any> = {}, reviewOut: Record<string, any> = {}, linkOut: any[] = [];
  for (const state of ["AP", "TG"] as StateCode[]) {
    const lgd = buildLgdState(tables, state, sources);
    writeCompact(join(GEO_OUT, `lgd-${state}.json`), lgd, 2);
    console.log(`[fetch-lgd] ${state}:`, JSON.stringify(lgd.counts));
    const { units, review } = buildAcUnits(tables, state, meta2008.acs.filter(a => a.state === state));
    const slim: Record<string, any> = {};
    for (const [no, u] of Object.entries(units)) {
      const md = majorityDistrict(u);
      slim[no] = { lgd: u.lgd, eci: u.eci, name: u.name, pcLgd: u.pcLgd, district: md?.code ?? null, districtShare: md?.share ?? null, districts: u.districts,
        counts: u.counts, mandals: u.mandals, villages: u.villages, wards: u.wards, urbanBodies: u.urbanBodies };
    }
    unitsOut[state] = slim;
    reviewOut[state] = review;
    const link = buildAcLink(state, units, meta2008.acs.filter(a => a.state === state));
    linkOut.push(...link.rows);
    reviewOut[state].linkIssues = link.issues;
    console.log(`[fetch-lgd] ${state}: ${Object.keys(units).length} ACs; no rural rows ${review.acsWithNoRuralRows.length}; no rows at all ${review.acsWithNoRows.length}; split mandals ${review.mandalsSplitAcrossAcs.length}; link issues ${link.issues.length}`);
  }
  const asOf = Object.values(sources).map(s => s.observedOn).sort().pop();
  const header = { schema: 1, asOf, source: "LGD Parquet mirror https://ramseraph.github.io/opendata/lgd/ (sha256 per table in lgd-*.json)" };
  writeCompact(join(GEO_OUT, "ac-units.json"), { ...header, note: "Per AC (state-specific ECI acNo): LGD AC code, majority district, counts and compact id lists. districts = row counts per LGD district code.", units: unitsOut }, 4);
  writeCompact(join(GEO_OUT, "ac-link.json"), { ...header, rows: linkOut }, 2);
  writeCompact(join(GEO_OUT, "review.json"), { ...header, note: "Human review queue: ACs with no rural rows, mandals split across ACs (check against the 2008 ECI order), link/name discrepancies.", ...reviewOut }, 4);
}
main().catch(e => { console.error("[fetch-lgd] FAILED:", (e as Error).message); process.exitCode = 1; });
