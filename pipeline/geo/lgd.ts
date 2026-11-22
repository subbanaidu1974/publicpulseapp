/**
 * LGD (Local Government Directory) mapper. Pure functions over raw table rows (as read from the
 * ramseraph/opendata Parquet mirror) so they are unit-testable with tiny fixtures.
 * Compact tuple formats are documented by the `cols` header in each output.
 */
import type { StateCode } from "../../src/lib/states";
import { nameClose } from "./util";

export const LGD_STATE: Record<StateCode, string> = { AP: "28", TG: "36" };
/** Undivided-Andhra-Pradesh AC numbering (ECI 2008 order) offset: AP acNo = undivided number - 119. */
export const AP_AC_OFFSET = 119;
/** Undivided PC numbering: TG 1-17, AP 18-42. */
export const AP_PC_OFFSET = 17;

type Row = Record<string, any>;
export interface LgdTables {
  districts: Row[]; subdistricts: Row[]; blocks: Row[]; villages: Row[]; villagesByBlocks: Row[];
  priLocalBodies: Row[]; urbanLocalBodies: Row[]; urbanWards: Row[];
  mappingPri: Row[]; mappingUrban: Row[]; assemblyConstituencies: Row[]; parliamentConstituencies: Row[];
}
export interface SourceStamp { sha256: string; observedOn: string; rows: number }

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const inState = (code: string) => (r: Row) => s(r.state_code) === code;
/** Telugu names: LGD stores a Latin placeholder (or upper-case English) for many rows; only keep Telugu script. */
export const teluguOrEmpty = (v: unknown): string => (/[ఀ-౿]/.test(s(v)) ? s(v) : "");
export const acNoFromEci = (state: StateCode, eci: number) => (state === "AP" ? eci - AP_AC_OFFSET : eci);
export const eciFromAcNo = (state: StateCode, acNo: number) => (state === "AP" ? acNo + AP_AC_OFFSET : acNo);

const catCode = (c: string) => (c === "Rural" ? "R" : c === "Urban" ? "U" : c === "Both" ? "B" : "?");
const byNum = (a: (string | number)[], b: (string | number)[]) => Number(a[0]) - Number(b[0]);

export interface LgdState {
  schema: 1; state: StateCode; lgdState: string; asOf: string;
  sources: Record<string, SourceStamp>;
  cols: Record<string, string[]>;
  counts: Record<string, number>;
  districts: (string | number)[][]; mandals: (string | number)[][]; blocks: (string | number)[][];
  villages: (string | number)[][]; gps: (string | number)[][]; urbanBodies: (string | number)[][];
  notes: string[];
}

/** Per-state LGD admin hierarchy in compact tuple form. Rural wards are intentionally not included. */
export function buildLgdState(t: LgdTables, state: StateCode, sources: Record<string, SourceStamp>): LgdState {
  const code = LGD_STATE[state], mine = inState(code);
  const notes: string[] = [];
  const districts = t.districts.filter(mine).map(r => [s(r.district_code), s(r.district_name), s(r.district_census_2011_code), s(r.district_census_2001_code)]).sort(byNum);
  const mandals = t.subdistricts.filter(mine).map(r => [s(r.subdistrict_code), s(r.subdistrict_name), s(r.district_code), s(r.subdistrict_census_2011_code)]).sort(byNum);
  const blocks = t.blocks.filter(mine).map(r => [s(r.block_code), s(r.block_name), teluguOrEmpty(r.block_name_local), s(r.district_code)]).sort(byNum);

  // village -> (GP, block): villages_by_blocks may list a village more than once; first row wins (sorted for determinism).
  const vb = new Map<string, Row>(); let multi = 0;
  for (const r of t.villagesByBlocks.filter(mine).sort((a, b) => Number(a.village_code) - Number(b.village_code) || Number(a.block_code) - Number(b.block_code))) {
    const k = s(r.village_code); if (vb.has(k)) multi++; else vb.set(k, r);
  }
  if (multi) notes.push(`${multi} villages appear in more than one block/GP row in villages_by_blocks; the lowest block code is kept`);

  const inMapping = new Set([...t.mappingPri.filter(mine).map(r => s(r.village_code))]);
  let dropped = 0;
  const villages: (string | number)[][] = [];
  for (const r of t.villages.filter(mine)) {
    const v = s(r.village_code);
    const inhabited = s(r.village_status) === "Inhabitant";
    // Keep inhabited villages and any village the AC mapping refers to; drop uninhabited/forest leftovers.
    if (!inhabited && !inMapping.has(v)) { dropped++; continue; }
    const b = vb.get(v);
    villages.push([v, s(r.village_name), teluguOrEmpty(r.village_name_local), s(r.subdistrict_code), s(r.village_census_2011_code),
      catCode(s(r.village_category)), inhabited ? 1 : 0, b ? s(b.local_body_code) : "", b ? s(b.block_code) : ""]);
  }
  villages.sort(byNum);
  if (dropped) notes.push(`${dropped} uninhabited/forest villages with no AC mapping were dropped`);

  // GPs: pri_local_bodies type 3 (Grama Panchayat); mandal derived from member villages.
  const mandalOfGp = new Map<string, Map<string, number>>();
  for (const v of villages) { if (!v[7]) continue; const m = mandalOfGp.get(String(v[7])) ?? new Map(); m.set(String(v[3]), (m.get(String(v[3])) ?? 0) + 1); mandalOfGp.set(String(v[7]), m); }
  const topKey = (m?: Map<string, number>) => (m ? [...m].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0][0] : "");
  const gps = t.priLocalBodies.filter(mine).filter(r => s(r.local_body_type_name) === "Grama Panchayat")
    .map(r => [s(r.local_body_code), s(r.local_body_name), teluguOrEmpty(r.local_body_name_local), topKey(mandalOfGp.get(s(r.local_body_code)))]).sort(byNum);

  // Urban bodies: district derived from the urban ward mapping.
  const distOfUlb = new Map<string, Map<string, number>>();
  for (const r of t.mappingUrban.filter(mine)) {
    const m = distOfUlb.get(s(r.local_body_code)) ?? new Map(); m.set(s(r.district_code), (m.get(s(r.district_code)) ?? 0) + 1); distOfUlb.set(s(r.local_body_code), m);
  }
  const urbanBodies = t.urbanLocalBodies.filter(mine)
    .map(r => [s(r.local_body_code), s(r.local_body_name), teluguOrEmpty(r.local_body_name_local), s(r.local_body_type_code), s(r.local_body_census_2011_code), topKey(distOfUlb.get(s(r.local_body_code)))]).sort(byNum);

  const wards = t.urbanWards.filter(mine).length;
  return {
    schema: 1, state, lgdState: code,
    asOf: Object.values(sources).map(x => x.observedOn).sort().pop() ?? "",
    sources,
    cols: {
      districts: ["lgd", "name", "census2011", "census2001"],
      mandals: ["lgd", "name", "districtLgd", "census2011"],
      blocks: ["lgd", "name", "nameTe", "districtLgd"],
      villages: ["lgd", "name", "nameTe", "mandalLgd", "census2011", "category(R|U|B|?)", "inhabited", "gpLgd", "blockLgd"],
      gps: ["lgd", "name", "nameTe", "mandalLgd(derived from member villages)"],
      urbanBodies: ["lgd", "name", "nameTe", "typeCode", "census2011", "districtLgd(derived from wards)"],
    },
    counts: { districts: districts.length, mandals: mandals.length, blocks: blocks.length, villages: villages.length, gps: gps.length, urbanBodies: urbanBodies.length, urbanWards: wards },
    districts, mandals, blocks, villages, gps, urbanBodies,
    notes: [...notes, "Rural (ward-level) panchayat wards are omitted; urban wards are referenced from ac-units.json only."],
  };
}

export interface AcUnit {
  lgd: string; eci: number; name: string; pcLgd: string; pcEci: number | null;
  districts: Record<string, number>; mandals: number[]; villages: number[]; wards: number[]; urbanBodies: number[];
  counts: { villages: number; wards: number; mandals: number; urbanBodies: number };
}
export interface AcUnitsReview {
  repairs: string[];
  acsWithNoRuralRows: { acNo: number; name: string }[];
  acsWithNoUrbanRows: number;
  acsWithNoRows: { acNo: number; name: string }[];
  mandalsSplitAcrossAcs: { mandal: number; name: string; acs: Record<string, number> }[];
  villagesInMultipleAcs: number;
}

/** AC -> admin units from the LGD village/ward to constituency mapping tables. */
export function buildAcUnits(t: LgdTables, state: StateCode, ref?: { acNo: number; name: string }[]): { units: Record<string, AcUnit>; review: AcUnitsReview } {
  const code = LGD_STATE[state], mine = inState(code);
  const units: Record<string, AcUnit> = {};
  const acRows = t.assemblyConstituencies.filter(mine);
  const mk = (lgd: string, eci: number, name: string, pcLgd: string, pcEci: number | null): AcUnit => ({
    lgd, eci, name, pcLgd, pcEci, districts: {}, mandals: [], villages: [], wards: [], urbanBodies: [], counts: { villages: 0, wards: 0, mandals: 0, urbanBodies: 0 },
  });
  const byLgd = new Map<string, AcUnit>();
  const maxNo = state === "AP" ? 175 : 119;
  const repairs: string[] = [];
  const ensure = (r: Row): AcUnit => {
    const l = s(r.assembly_constituency_code);
    let u = byLgd.get(l);
    if (!u) {
      const lg = acRows.find(a => s(a.assembly_constituency_code) === l);
      const name = s(lg?.assembly_constituency_name || r.assembly_constituency_name);
      let eci = Number(r.assembly_constituency_eci_code);
      const no = acNoFromEci(state, eci);
      if (!(no >= 1 && no <= maxNo) && ref) {
        // LGD carries at least one invalid ECI code (Mummidivaram: 62 instead of 162); repair by name against the 2008 order.
        const m = ref.find(x => nameClose(x.name, name));
        if (m) { repairs.push(`LGD AC ${l} '${name}': eci code ${eci} is out of range for ${state}; repaired to acNo ${m.acNo} by name match with the 2008 table`); eci = eciFromAcNo(state, m.acNo); }
      }
      u = mk(l, eci, name, s(r.parliament_constituency_code), r.parliament_constituency_eci_code == null ? null : Number(r.parliament_constituency_eci_code));
      byLgd.set(l, u);
    }
    return u;
  };
  const vSets = new Map<string, Set<number>>(), mSets = new Map<string, Set<number>>(), wSets = new Map<string, Set<number>>(), uSets = new Map<string, Set<number>>();
  const add = (m: Map<string, Set<number>>, k: string, v: number) => { (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v); };
  const mandalAcs = new Map<number, Map<string, number>>(), mandalName = new Map<number, string>();
  const villageAcs = new Map<number, Set<string>>();
  for (const r of t.mappingPri.filter(mine)) {
    const u = ensure(r), v = Number(r.village_code), m = Number(r.subdistrict_code);
    add(vSets, u.lgd, v); add(mSets, u.lgd, m);
    u.districts[s(r.district_code)] = (u.districts[s(r.district_code)] ?? 0) + 1;
    mandalName.set(m, s(r.subdistrict_name));
    const ma = mandalAcs.get(m) ?? new Map(); ma.set(u.lgd, (ma.get(u.lgd) ?? 0) + 1); mandalAcs.set(m, ma);
    (villageAcs.get(v) ?? villageAcs.set(v, new Set()).get(v)!).add(u.lgd);
  }
  for (const r of t.mappingUrban.filter(mine)) {
    const u = ensure(r);
    add(wSets, u.lgd, Number(r.ward_code)); add(uSets, u.lgd, Number(r.local_body_code));
    u.districts[s(r.district_code)] = (u.districts[s(r.district_code)] ?? 0) + 1;
  }
  const sorted = (x?: Set<number>) => [...(x ?? [])].sort((a, b) => a - b);
  for (const u of byLgd.values()) {
    u.villages = sorted(vSets.get(u.lgd)); u.mandals = sorted(mSets.get(u.lgd)); u.wards = sorted(wSets.get(u.lgd)); u.urbanBodies = sorted(uSets.get(u.lgd));
    u.counts = { villages: u.villages.length, wards: u.wards.length, mandals: u.mandals.length, urbanBodies: u.urbanBodies.length };
    u.districts = Object.fromEntries(Object.entries(u.districts).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])));
  }
  // ACs in the LGD AC table with no mapping rows at all still get an (empty) entry so nothing is silently lost.
  for (const a of acRows) {
    const l = s(a.assembly_constituency_code);
    if (!byLgd.has(l)) byLgd.set(l, mk(l, NaN, s(a.assembly_constituency_name), s(a.parliament_constituency_code), null));
  }
  for (const u of byLgd.values()) { if (Number.isFinite(u.eci)) units[String(acNoFromEci(state, u.eci))] = u; }
  const review: AcUnitsReview = {
    repairs, acsWithNoRuralRows: [], acsWithNoUrbanRows: 0, acsWithNoRows: [], mandalsSplitAcrossAcs: [],
    villagesInMultipleAcs: [...villageAcs.values()].filter(x => x.size > 1).length,
  };
  for (const [no, u] of Object.entries(units).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (!u.counts.villages) review.acsWithNoRuralRows.push({ acNo: Number(no), name: u.name });
    if (!u.counts.wards) review.acsWithNoUrbanRows++;
    if (!u.counts.villages && !u.counts.wards) review.acsWithNoRows.push({ acNo: Number(no), name: u.name });
  }
  const acNoOfLgd = new Map([...byLgd.values()].map(u => [u.lgd, acNoFromEci(state, u.eci)]));
  for (const [m, acs] of [...mandalAcs].sort((a, b) => a[0] - b[0])) {
    if (acs.size > 1) review.mandalsSplitAcrossAcs.push({ mandal: m, name: mandalName.get(m) ?? "", acs: Object.fromEntries([...acs].map(([l, n]) => [String(acNoOfLgd.get(l)), n]).sort((a, b) => Number(a[0]) - Number(b[0]))) });
  }
  return { units, review };
}

/** Majority district of an AC (by village + ward rows); ties break on the lowest code. */
export function majorityDistrict(u: Pick<AcUnit, "districts">): { code: string; share: number } | null {
  const e = Object.entries(u.districts);
  if (!e.length) return null;
  const total = e.reduce((a, [, n]) => a + n, 0);
  const [code, n] = e.sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
  return { code, share: Math.round((n / total) * 1000) / 1000 };
}
