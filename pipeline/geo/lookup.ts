/** S-87: read-only seat metadata (district, Telugu name) from the committed geo outputs, for the /elections payload. */
import fs from "node:fs";
import path from "node:path";
import type { ElectionType, StateCode } from "../../src/lib/states";

export interface SeatGeo { district?: string; acNameTe?: string }
export type GeoLookup = (state: StateCode, type: ElectionType, acNo: number) => SeatGeo;

const read = (f: string): any | null => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

/**
 * Assembly seats: district of the AC (LGD majority district) + Telugu AC name.
 * LS seats: the district holding most of the PC's ACs, Telugu PC name. Returns undefined when no geo data is committed.
 */
export function loadGeoLookup(baseDir: string = process.cwd()): GeoLookup | undefined {
  const dir = path.join(baseDir, "data", "generated", "geo");
  const units = read(path.join(dir, "ac-units.json"))?.units, link = read(path.join(dir, "ac-link.json"))?.rows;
  if (!units || !link) return undefined;
  const te = read(path.join(dir, "names-te.json"))?.names;
  const dname: Record<string, string> = {};
  const acDistrict: Record<StateCode, Map<number, string>> = { AP: new Map(), TG: new Map() };
  for (const s of ["AP", "TG"] as StateCode[]) {
    for (const d of read(path.join(dir, `lgd-${s}.json`))?.districts ?? []) dname[d[0]] = d[1];
    for (const [no, u] of Object.entries<any>(units[s] ?? {})) if (u.district && dname[u.district]) acDistrict[s].set(Number(no), dname[u.district]);
  }
  const pcDistrict: Record<StateCode, Map<number, string>> = { AP: new Map(), TG: new Map() };
  for (const s of ["AP", "TG"] as StateCode[]) {
    const tally = new Map<number, Map<string, number>>();
    for (const r of link as { state: StateCode; acNo: number; pcNo: number | null }[]) {
      if (r.state !== s || r.pcNo == null) continue;
      const d = acDistrict[s].get(r.acNo); if (!d) continue;
      const m = tally.get(r.pcNo) ?? new Map<string, number>(); m.set(d, (m.get(d) ?? 0) + 1); tally.set(r.pcNo, m);
    }
    for (const [pc, m] of tally) pcDistrict[s].set(pc, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  }
  return (state, type, acNo) => {
    const district = (type === "ls" ? pcDistrict : acDistrict)[state]?.get(acNo);
    const acNameTe = te?.[type === "ls" ? "pcs" : "acs"]?.[state]?.[String(acNo)];
    return { ...(district ? { district } : {}), ...(acNameTe ? { acNameTe } : {}) };
  };
}
