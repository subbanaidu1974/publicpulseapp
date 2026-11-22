import { parseCsv } from "./normalize";

export interface CensusDistrict {
  state: "AP" | "TG";
  district: string;
  censusYear: 2011;
  population: number;
  literate: number;
  scPop: number;
  stPop: number;
  males: number;
  females: number;
  literacyPct: number;
  scPct: number;
  stPct: number;
  /** females per 1000 males */
  sexRatio: number;
  source: string;
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
