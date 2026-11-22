/**
 * Real LGD geography for the civic tables, built from the committed pipeline outputs in data/generated/geo
 * (scripts/fetch-lgd.ts). Unit codes are namespaced per level because raw LGD codes collide across levels:
 * S-28 state, D-501 district, M-4305 mandal (subdistrict), V-568945 village, AC-3161 assembly constituency.
 * Never loads the DEMO fixture. Rural wards and urban bodies are not imported (villages and ACs only).
 */
import fs from "node:fs";
import path from "node:path";
import type { GeoDataset } from "./service";

export const lgdCode = {
  state: (c: string) => `S-${c}`, district: (c: string) => `D-${c}`, mandal: (c: string) => `M-${c}`,
  village: (c: string | number) => `V-${c}`, ac: (c: string) => `AC-${c}`,
};
/** Raw LGD code from a namespaced civic code ("AC-3161" -> "3161"). */
export const rawLgd = (code: string) => code.replace(/^(S|D|M|V|AC)-/, "");

const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
export const DELIMITATION_FROM = "2008-02-19";

export function geoDir(baseDir = process.cwd()) { return path.join(baseDir, "data", "generated", "geo"); }
export function hasRealGeo(baseDir = process.cwd()): boolean {
  const d = geoDir(baseDir);
  return ["lgd-AP.json", "lgd-TG.json", "ac-units.json"].every(f => fs.existsSync(path.join(d, f)));
}

export function buildRealGeoDataset(baseDir = process.cwd()): { data: GeoDataset; asOf: string } {
  const dir = geoDir(baseDir);
  const acUnits = read(path.join(dir, "ac-units.json"));
  const asOf: string = acUnits.asOf;
  const units: GeoDataset["units"] = [];
  const links: GeoDataset["villageConstituency"] = [];
  const stateNames = { AP: "Andhra Pradesh", TG: "Telangana" } as const;
  for (const st of ["AP", "TG"] as const) {
    const lgd = read(path.join(dir, `lgd-${st}.json`));
    units.push({ lgd: lgdCode.state(lgd.lgdState), level: "state", en: stateNames[st], parent: null, from: asOf, to: null });
    for (const d of lgd.districts) units.push({ lgd: lgdCode.district(d[0]), level: "district", en: d[1], parent: lgdCode.state(lgd.lgdState), from: asOf, to: null });
    for (const m of lgd.mandals) units.push({ lgd: lgdCode.mandal(m[0]), level: "mandal", en: m[1], parent: lgdCode.district(m[2]), from: asOf, to: null });
    const mandalOk = new Set(lgd.mandals.map((m: string[]) => m[0]));
    for (const v of lgd.villages) {
      if (!mandalOk.has(v[3])) continue; // orphan village rows are not importable (no parent)
      units.push({ lgd: lgdCode.village(v[0]), level: "village", en: v[1], ...(v[2] ? { te: v[2] } : {}), parent: lgdCode.mandal(v[3]), from: asOf, to: null });
    }
    const villageOk = new Set(lgd.villages.map((v: (string | number)[]) => String(v[0])));
    for (const u of Object.values<any>(acUnits.units[st])) {
      units.push({ lgd: lgdCode.ac(u.lgd), level: "constituency", en: u.name, parent: u.district ? lgdCode.district(u.district) : lgdCode.state(lgd.lgdState), from: DELIMITATION_FROM, to: null });
      for (const v of u.villages) if (villageOk.has(String(v))) links.push({ village: lgdCode.village(v), constituency: lgdCode.ac(u.lgd), from: asOf, to: null });
    }
  }
  const names = fs.existsSync(path.join(dir, "names-te.json")) ? read(path.join(dir, "names-te.json")).names : null;
  if (names) { // Telugu names for districts, mandals, ACs from the gazetteer (never guessed)
    const lgdAP = read(path.join(dir, "lgd-AP.json")), lgdTG = read(path.join(dir, "lgd-TG.json"));
    const acByState = new Map<string, "AP" | "TG">();
    for (const st of ["AP", "TG"] as const) for (const u of Object.values<any>(acUnits.units[st])) acByState.set(lgdCode.ac(u.lgd), st);
    const lookup = new Map<string, string>();
    for (const [st, l] of [["AP", lgdAP], ["TG", lgdTG]] as const) {
      for (const [k, te] of Object.entries<string>(names.districts[st] ?? {})) lookup.set(lgdCode.district(k), te);
      for (const [k, te] of Object.entries<string>(names.mandals[st] ?? {})) lookup.set(lgdCode.mandal(k), te);
      for (const [no, te] of Object.entries<string>(names.acs[st] ?? {})) { const u = acUnits.units[st][no]; if (u) lookup.set(lgdCode.ac(u.lgd), te); }
      void l;
    }
    for (const u of units) if (!u.te && lookup.has(u.lgd)) u.te = lookup.get(u.lgd)!;
  }
  return { data: { units, hamlets: [], villageConstituency: links }, asOf };
}
