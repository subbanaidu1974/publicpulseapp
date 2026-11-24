import { parseCsv } from "./normalize";

export interface CensusDistrict {
  state: "AP" | "TG";
  district: string;
  censusYear: 2011;
  population: number;
  /** null when the source (e.g. the DCHB village/town directories) carries no literacy columns */
  literate: number | null;
  scPop: number;
  stPop: number;
  males: number;
  females: number;
  literacyPct: number | null;
  scPct: number;
  stPct: number;
  /** females per 1000 males */
  sexRatio: number;
  source: string;
  /** Census 2011 district code (3 digits, e.g. "532" Adilabad); present for DCHB-derived rows */
  districtCode?: string;
  households?: number | null;
  /** Population aged 0-6 (PCA P_06); the denominator of the official literacy rate is population minus this. */
  pop0to6?: number | null;
  literateMales?: number | null;
  literateFemales?: number | null;
}

/** Sub-district (mandal/taluk) rollup keyed by Census 2011 codes. */
export interface CensusSubDistrict {
  state: "AP" | "TG";
  districtCode: string;
  district: string;
  /** 5-digit Census 2011 sub-district code; "00000" = towns spread over more than one sub-district */
  subDistrictCode: string;
  subDistrict: string;
  censusYear: 2011;
  population: number;
  males: number;
  females: number;
  scPop: number;
  stPop: number;
  households: number;
  villages: number;
  towns: number;
  scPct: number;
  stPct: number;
  sexRatio: number;
  /** Present when PCA literacy was merged (scripts/ingest-pca-literacy.ts). */
  literate?: number | null;
  pop0to6?: number | null;
  literacyPct?: number | null;
}

/** Village or town unit (compact record). kind V = village (rural), T = town (statutory or census town). */
export interface CensusUnit {
  kind: "V" | "T";
  state: "AP" | "TG";
  districtCode: string;
  district: string;
  subDistrictCode: string;
  subDistrict: string;
  code: string;
  name: string;
  households: number;
  population: number;
  males: number;
  females: number;
  scPop: number;
  stPop: number;
  /** PCA literates (persons) and population aged 0-6; absent when the PCA literacy merge has not run. */
  literate?: number;
  pop0to6?: number;
}

/** Official Census literacy rate: literates as a percent of the population aged 7 and over. null when it cannot be computed. */
export function literacyRate(literate: number, population: number, pop0to6: number): number | null {
  const base = population - pop0to6;
  if (!Number.isFinite(base) || base <= 0 || literate < 0 || literate > base) return null;
  return Math.round((literate / base) * 10000) / 100;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const num = (s: string | undefined) => {
  const t = (s ?? "").replace(/,/g, "").trim();
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : NaN;
};

/** Normalise Census 2011 district CSV (State, District, TOT_P, TOT_M, TOT_F, P_SC, P_ST, P_LIT). Other states/invalid rows skipped. */
export function normalizeCensus(csv: string, source: string): CensusDistrict[] {
  const out: CensusDistrict[] = [];
  for (const r of parseCsv(csv)) {
    const code = (r.State ?? "").trim().replace(/^0+/, "");
    const state = code === "28" ? "AP" : code === "36" ? "TG" : null;
    if (!state) continue;
    const district = (r.District ?? "").trim();
    const population = num(r.TOT_P), males = num(r.TOT_M), females = num(r.TOT_F);
    const scPop = num(r.P_SC), stPop = num(r.P_ST), literate = num(r.P_LIT);
    if (!district || [population, males, females, scPop, stPop, literate].some(Number.isNaN)) continue;
    if (population <= 0 || [males, females, scPop, stPop, literate].some(v => v < 0)) continue;
    out.push({
      state, district, censusYear: 2011, population, literate, scPop, stPop, males, females,
      literacyPct: round((literate / population) * 100),
      scPct: round((scPop / population) * 100),
      stPct: round((stPop / population) * 100),
      sexRatio: males > 0 ? Math.round((females / males) * 1000) : 0,
      source,
    });
  }
  return out.sort((a, b) => a.state.localeCompare(b.state) || a.district.localeCompare(b.district));
}

/**
 * Census 2011 district codes 532-541 are the ten districts that now form Telangana; 542-554 remain Andhra Pradesh.
 * (The 2011 census published both under state code 28.)
 */
export function stateOfDistrict2011(code: string): "AP" | "TG" | null {
  const n = Number(code);
  if (!Number.isInteger(n)) return null;
  if (n >= 532 && n <= 541) return "TG";
  if (n >= 542 && n <= 554) return "AP";
  return null;
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s(\-/])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()).replace(/\s+District$/i, "").trim();

const VILLAGE_COLS = {
  hh: "Total Households", p: "Total Population of Village", m: "Total Male Population of Village",
  f: "Total Female Population of Village", sc: "Total Scheduled Castes Population of Village",
  st: "Total Scheduled Tribes Population of Village", code: "Village Code", name: "Village Name",
};
const TOWN_COLS = {
  hh: "Total Households", p: "Total Population of Town", m: "Total Male Population of Town",
  f: "Total Female Population of Town", sc: "Total Scheduled Castes Population of Town",
  st: "Total Scheduled Tribes Population of Town", code: "Town Code", name: "Town Name",
};

/** Normalise one DCHB village-directory or town-directory record (keyed by the official column header text). */
export function dchbRecordToUnit(kind: "V" | "T", raw: Record<string, string | number | undefined>): CensusUnit | null {
  // Header text in the workbooks has irregular inner spacing ("Total   Households "): collapse it.
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) r[k.replace(/\s+/g, " ").trim()] = v === undefined ? "" : String(v);
  const c = kind === "V" ? VILLAGE_COLS : TOWN_COLS;
  const districtCode = (r["District Code"] ?? "").trim();
  const state = stateOfDistrict2011(districtCode);
  if (!state) return null;
  const population = num(r[c.p]);
  // Uninhabited villages carry population 0 and blank counts; treat those blanks as 0, nothing else.
  const cnt = (k: string) => (population === 0 && (r[k] ?? "").trim() === "" ? 0 : num(r[k]));
  const households = cnt(c.hh), males = cnt(c.m), females = cnt(c.f), scPop = cnt(c.sc), stPop = cnt(c.st);
  const code = (r[c.code] ?? "").trim(), name = (r[c.name] ?? "").trim();
  // NaN means a malformed row.
  if (!code || !name || [population, males, females, scPop, stPop, households].some(Number.isNaN)) return null;
  return {
    kind, state, districtCode,
    district: titleCase(r["District Name"] ?? ""),
    subDistrictCode: (r["Sub District Code"] ?? "").trim(),
    subDistrict: (r["Sub District Name"] ?? "").trim(),
    code, name, households, population, males, females, scPop, stPop,
  };
}

const sexRatioOf = (m: number, f: number) => (m > 0 ? Math.round((f / m) * 1000) : 0);

/** Roll units up to 2011 districts. Literacy is null unless every unit of the district carries PCA literacy (see scripts/ingest-pca-literacy.ts). */
export function rollupDistricts(units: CensusUnit[], source: string): CensusDistrict[] {
  const by = new Map<string, CensusDistrict>();
  const litBroken = new Set<string>();
  for (const u of units) {
    let d = by.get(u.districtCode);
    if (!d) {
      d = {
        state: u.state, district: u.district, districtCode: u.districtCode, censusYear: 2011,
        population: 0, literate: null, scPop: 0, stPop: 0, males: 0, females: 0, households: 0,
        literacyPct: null, scPct: 0, stPct: 0, sexRatio: 0, source,
      };
      by.set(u.districtCode, d);
    }
    d.population += u.population; d.males += u.males; d.females += u.females;
    d.scPop += u.scPop; d.stPop += u.stPop; d.households = (d.households ?? 0) + u.households;
    if (u.literate !== undefined && u.pop0to6 !== undefined) {
      d.literate = (d.literate ?? 0) + u.literate; d.pop0to6 = (d.pop0to6 ?? 0) + u.pop0to6;
    } else { d.literate = null; d.pop0to6 = null; litBroken.add(u.districtCode); }
  }
  for (const d of by.values()) {
    if (litBroken.has(d.districtCode ?? "")) { d.literate = null; d.pop0to6 = null; }
    d.literacyPct = d.literate != null && d.pop0to6 != null ? literacyRate(d.literate, d.population, d.pop0to6) : null;
    d.scPct = d.population ? round((d.scPop / d.population) * 100) : 0;
    d.stPct = d.population ? round((d.stPop / d.population) * 100) : 0;
    d.sexRatio = sexRatioOf(d.males, d.females);
  }
  return [...by.values()].sort((a, b) => a.state.localeCompare(b.state) || a.districtCode.localeCompare(b.districtCode));
}

export function rollupSubDistricts(units: CensusUnit[]): CensusSubDistrict[] {
  const by = new Map<string, CensusSubDistrict>();
  const litBroken = new Set<string>();
  for (const u of units) {
    const key = `${u.districtCode}|${u.subDistrictCode}`;
    let s = by.get(key);
    if (!s) {
      s = {
        state: u.state, districtCode: u.districtCode, district: u.district, subDistrictCode: u.subDistrictCode,
        subDistrict: u.subDistrict, censusYear: 2011, population: 0, males: 0, females: 0, scPop: 0, stPop: 0,
        households: 0, villages: 0, towns: 0, scPct: 0, stPct: 0, sexRatio: 0,
      };
      by.set(key, s);
    }
    s.population += u.population; s.males += u.males; s.females += u.females;
    s.scPop += u.scPop; s.stPop += u.stPop; s.households += u.households;
    if (u.kind === "V") s.villages++; else s.towns++;
    if (u.literate !== undefined && u.pop0to6 !== undefined) {
      s.literate = (s.literate ?? 0) + u.literate; s.pop0to6 = (s.pop0to6 ?? 0) + u.pop0to6;
    } else { litBroken.add(key); }
  }
  for (const [key, s] of by) {
    if (litBroken.has(key)) { delete s.literate; delete s.pop0to6; }
    else if (s.literate !== undefined && s.pop0to6 !== undefined) s.literacyPct = literacyRate(s.literate, s.population, s.pop0to6);
    s.scPct = s.population ? round((s.scPop / s.population) * 100) : 0;
    s.stPct = s.population ? round((s.stPop / s.population) * 100) : 0;
    s.sexRatio = sexRatioOf(s.males, s.females);
  }
  return [...by.values()].sort((a, b) => a.districtCode.localeCompare(b.districtCode) || a.subDistrictCode.localeCompare(b.subDistrictCode));
}

/** Column order of the compact village/town array rows in census-units.json. */
export const UNIT_COLUMNS = ["kind", "state", "districtCode", "subDistrictCode", "code", "name", "households", "population", "males", "females", "scPop", "stPop", "literate", "pop0to6"] as const;

/** literate and pop0to6 are null when the PCA literacy merge has not covered the unit. */
export function unitToRow(u: CensusUnit): (string | number | null)[] {
  return [u.kind, u.state, u.districtCode, u.subDistrictCode, u.code, u.name, u.households, u.population, u.males, u.females, u.scPop, u.stPop, u.literate ?? null, u.pop0to6 ?? null];
}

/**
 * Manual drop-in CSV, one row per village/town. Header names (any order):
 * kind (V|T), district_code, district, subdistrict_code, subdistrict, code, name, households, population, males, females, sc, st
 */
export function parseUnitCsv(csv: string): CensusUnit[] {
  const out: CensusUnit[] = [];
  for (const r of parseCsv(csv)) {
    const kind = (r.kind ?? "V").toUpperCase() === "T" ? "T" : "V";
    const districtCode = (r.district_code ?? "").trim();
    const state = stateOfDistrict2011(districtCode);
    const [households, population, males, females, scPop, stPop] = [r.households, r.population, r.males, r.females, r.sc, r.st].map(num);
    if (!state || !r.code || !r.name || [households, population, males, females, scPop, stPop].some(Number.isNaN)) continue;
    out.push({
      kind, state, districtCode, district: titleCase(r.district ?? ""), subDistrictCode: (r.subdistrict_code ?? "").trim(),
      subDistrict: (r.subdistrict ?? "").trim(), code: r.code.trim(), name: r.name.trim(), households, population, males, females, scPop, stPop,
    });
  }
  return out;
}

/** Data-quality checks for unit-level census data; returns violations. */
export function validateUnits(units: CensusUnit[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    const id = `${u.kind}|${u.districtCode}|${u.code}`;
    if (seen.has(id)) errs.push(`duplicate census unit: ${id}`);
    seen.add(id);
    if (u.males + u.females !== u.population) errs.push(`males+females != population: ${id} ${u.name}`);
    if (u.scPop > u.population || u.stPop > u.population) errs.push(`SC/ST exceeds population: ${id} ${u.name}`);
  }
  return errs;
}

/** Inverse of unitToRow for census-units.json (columns + array rows). */
export function parseUnitRows(columns: readonly string[], rows: (string | number | null)[][]): CensusUnit[] {
  const ix = Object.fromEntries(columns.map((c, i) => [c, i]));
  const opt = (r: (string | number | null)[], k: string) => (ix[k] !== undefined && r[ix[k]] != null ? { [k]: Number(r[ix[k]]) } : {});
  return rows.map(r => ({
    kind: r[ix.kind] as "V" | "T", state: r[ix.state] as "AP" | "TG", districtCode: String(r[ix.districtCode]), district: "",
    subDistrictCode: String(r[ix.subDistrictCode]), subDistrict: "", code: String(r[ix.code]), name: String(r[ix.name]),
    households: Number(r[ix.households]), population: Number(r[ix.population]), males: Number(r[ix.males]),
    females: Number(r[ix.females]), scPop: Number(r[ix.scPop]), stPop: Number(r[ix.stPop]),
    ...opt(r, "literate"), ...opt(r, "pop0to6"),
  }));
}

/** One Primary Census Abstract (PCA TV, MDDS layout) record reduced to the fields the literacy merge needs. */
export interface PcaRecord {
  level: "DISTRICT" | "SUB-DISTRICT" | "VILLAGE" | "TOWN";
  tru: "Total" | "Rural" | "Urban";
  districtCode: string;
  subDistrictCode: string;
  code: string;
  name: string;
  population: number;
  males: number;
  females: number;
  pop0to6: number;
  literate: number;
  literateMales: number;
  literateFemales: number;
}

/** Parse a PCA row keyed by the MDDS headers (State, District, Subdistt, Town/Village, Level, Name, TRU, TOT_P, P_06, P_LIT, ...). Ward rows and bad rows return null. */
export function pcaRecord(r: Record<string, string | undefined>): PcaRecord | null {
  const level = (r.Level ?? "").trim().toUpperCase();
  if (level !== "DISTRICT" && level !== "SUB-DISTRICT" && level !== "VILLAGE" && level !== "TOWN") return null;
  const tru = (r.TRU ?? "").trim();
  if (tru !== "Total" && tru !== "Rural" && tru !== "Urban") return null;
  const districtCode = (r.District ?? "").trim();
  if (!stateOfDistrict2011(districtCode)) return null;
  const [population, males, females, pop0to6, literate, literateMales, literateFemales] =
    [r.TOT_P, r.TOT_M, r.TOT_F, r.P_06, r.P_LIT, r.M_LIT, r.F_LIT].map(num);
  if ([population, males, females, pop0to6, literate, literateMales, literateFemales].some(Number.isNaN)) return null;
  return {
    level, tru, districtCode, subDistrictCode: (r.Subdistt ?? "").trim(), code: (r["Town/Village"] ?? "").trim(),
    name: (r.Name ?? "").trim(), population, males, females, pop0to6, literate, literateMales, literateFemales,
  };
}

/** Consistency checks on PCA records: persons = male + female and literates cannot exceed the 7+ population. */
export function validatePca(rows: PcaRecord[]): string[] {
  const errs: string[] = [];
  for (const r of rows) {
    const id = `${r.level}|${r.districtCode}|${r.subDistrictCode}|${r.code} ${r.name}`;
    if (r.males + r.females !== r.population) errs.push(`PCA males+females != population: ${id}`);
    if (r.literateMales + r.literateFemales !== r.literate) errs.push(`PCA male+female literates != literates: ${id}`);
    if (r.literate > r.population - r.pop0to6) errs.push(`PCA literates exceed population aged 7+: ${id}`);
  }
  return errs;
}
