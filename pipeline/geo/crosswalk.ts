/**
 * S-85: district crosswalk so 2014/2019 results can be aggregated to a chosen district vintage.
 * Vintages supported (both verified from data, nothing hand-typed):
 *   "pre2014"  AP 13 / TG 10 districts, from the DataMeet AC shapefile (the districts the 2008 ACs were drawn in)
 *   "current"  AP 28 / TG 33 districts, from LGD (an AC belongs to the district holding most of its villages and wards)
 * NOT available from the fetched sources (reported, not guessed): the intermediate AP 26 (Apr 2022) and TG 31 (2016-19) vintages.
 */
import type { StateCode } from "../../src/lib/states";

export type Vintage = "pre2014" | "current";
export interface CrosswalkPair { old: string; current: string; currentLgd: string; acs: number }
export interface Crosswalk {
  schema: 1;
  vintages: Record<Vintage, { AP: number; TG: number; basis: string; verified: boolean }>;
  unavailable: string[];
  /** acNo (state-specific) -> [pre-2014 district name, current district LGD code, current district name, share of AC units in that district] */
  ac: Record<StateCode, Record<string, [string, string, string, number]>>;
  pairs: Record<StateCode, CrosswalkPair[]>;
  inferred: string[];
}

export interface AcDistrictInput { state: StateCode; acNo: number; oldName: string; currentLgd: string; currentName: string; share: number }

export function buildCrosswalk(rows: AcDistrictInput[]): Crosswalk {
  const ac: Crosswalk["ac"] = { AP: {}, TG: {} };
  const pairMap: Record<StateCode, Map<string, CrosswalkPair>> = { AP: new Map(), TG: new Map() };
  for (const r of [...rows].sort((a, b) => a.state.localeCompare(b.state) || a.acNo - b.acNo)) {
    ac[r.state][String(r.acNo)] = [r.oldName, r.currentLgd, r.currentName, r.share];
    const k = `${r.oldName}|${r.currentLgd}`;
    const p = pairMap[r.state].get(k) ?? { old: r.oldName, current: r.currentName, currentLgd: r.currentLgd, acs: 0 };
    p.acs++; pairMap[r.state].set(k, p);
  }
  const pairs = { AP: [...pairMap.AP.values()], TG: [...pairMap.TG.values()] } as Crosswalk["pairs"];
  for (const s of ["AP", "TG"] as StateCode[]) pairs[s].sort((a, b) => a.old.localeCompare(b.old) || a.current.localeCompare(b.current));
  const distinct = (s: StateCode, f: (p: CrosswalkPair) => string) => new Set(pairs[s].map(f)).size;
  return {
    schema: 1,
    vintages: {
      pre2014: { AP: distinct("AP", p => p.old), TG: distinct("TG", p => p.old), basis: "DataMeet India_AC DIST_NAME (districts at the 2008 delimitation)", verified: true },
      current: { AP: distinct("AP", p => p.currentLgd), TG: distinct("TG", p => p.currentLgd), basis: "LGD district holding the majority of the AC's villages and wards", verified: true },
    },
    unavailable: [
      "AP 26-district vintage (April 2022): no fetched source carries it at AC or mandal resolution",
      "TG 31-district vintage (Oct 2016 to Feb 2019): same",
    ],
    ac, pairs,
    inferred: [
      "Every AC is assigned to ONE district per vintage (majority of units). ACs that straddle districts (see share < 1) are approximated; mandal-level crosswalk needs the 2008 ECI order.",
    ],
  };
}

/** District name of an AC in the requested vintage (undefined when the AC is unknown). */
export function districtOf(xw: Crosswalk, state: StateCode, acNo: number, vintage: Vintage): string | undefined {
  const r = xw.ac[state]?.[String(acNo)];
  return r ? (vintage === "pre2014" ? r[0] : r[2]) : undefined;
}

/** Aggregate per-seat winners into {district: {party: seats}} for the chosen district vintage. */
export function aggregateTally(xw: Crosswalk, state: StateCode, seats: { acNo: number; winnerParty: string }[], vintage: Vintage): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of seats) {
    const d = districtOf(xw, state, s.acNo, vintage);
    if (!d) continue;
    (out[d] ??= {})[s.winnerParty] = (out[d][s.winnerParty] ?? 0) + 1;
  }
  return out;
}

/** Which pre-2014 districts a current district came from (with AC counts). */
export function parentsOf(xw: Crosswalk, state: StateCode, currentLgd: string): { old: string; acs: number }[] {
  return xw.pairs[state].filter(p => p.currentLgd === currentLgd).map(p => ({ old: p.old, acs: p.acs })).sort((a, b) => b.acs - a.acs);
}
