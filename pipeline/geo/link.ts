/** S-102: effective-dated link between LGD AC codes and ECI election constituency numbers. */
import fs from "node:fs";
import path from "node:path";
import type { StateCode } from "../../src/lib/states";
import type { AcMeta } from "./constituency";
import { acNoFromEci, type AcUnit } from "./lgd";
import { nameClose } from "./util";

/** 2008 delimitation order in force for all AP/TG ECI elections to date. Exact date inferred, not verified. */
export const DELIMITATION_2008_FROM = "2008-02-19";

export interface AcLinkRow {
  state: StateCode; acNo: number; eci: number; lgd: string; name: string; pcNo: number | null; reservation: string | null;
  validFrom: string; validTo: string | null; datesInferred: true;
}

export function buildAcLink(state: StateCode, units: Record<string, AcUnit>, meta: AcMeta[]): { rows: AcLinkRow[]; issues: string[] } {
  const issues: string[] = [];
  const byNo = new Map(meta.map(m => [m.acNo, m]));
  const rows: AcLinkRow[] = [];
  const seenLgd = new Map<string, number>();
  for (const [no, u] of Object.entries(units).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const acNo = Number(no), m = byNo.get(acNo);
    if (acNo !== acNoFromEci(state, u.eci)) issues.push(`AC ${acNo}: eci/acNo mismatch`);
    if (seenLgd.has(u.lgd)) issues.push(`LGD AC ${u.lgd} maps to both ${seenLgd.get(u.lgd)} and ${acNo}`);
    seenLgd.set(u.lgd, acNo);
    if (!m) issues.push(`AC ${acNo} (${u.name}): not in the 2008 table`);
    else if (!nameClose(m.name, u.name)) issues.push(`AC ${acNo}: LGD name '${u.name}' differs from 2008 table '${m.name}'`);
    rows.push({ state, acNo, eci: u.eci, lgd: u.lgd, name: m?.name ?? u.name, pcNo: m?.pcNo ?? null, reservation: m?.reservation ?? null, validFrom: DELIMITATION_2008_FROM, validTo: null, datesInferred: true });
  }
  for (const m of meta) if (!units[String(m.acNo)]) issues.push(`2008 AC ${m.acNo} (${m.name}) has no LGD AC`);
  return { rows, issues };
}

export interface AcLinkFile { schema: 1; rows: AcLinkRow[] }
const valid = (r: AcLinkRow, asOf: string) => r.validFrom <= asOf && (r.validTo === null || r.validTo > asOf);

/** Loader used by the civic geo layer so a village/constituency LGD code resolves to the election constituency. */
export class AcLink {
  constructor(private rows: AcLinkRow[]) {}
  static load(file = path.resolve(process.cwd(), "data/generated/geo/ac-link.json")): AcLink {
    try { return new AcLink((JSON.parse(fs.readFileSync(file, "utf8")) as AcLinkFile).rows ?? []); } catch { return new AcLink([]); }
  }
  get size() { return this.rows.length; }
  byLgd(lgd: string, asOf = new Date().toISOString().slice(0, 10)): AcLinkRow | null {
    return this.rows.find(r => r.lgd === String(lgd) && valid(r, asOf)) ?? null;
  }
  byAcNo(state: StateCode, acNo: number, asOf = new Date().toISOString().slice(0, 10)): AcLinkRow | null {
    return this.rows.find(r => r.state === state && r.acNo === acNo && valid(r, asOf)) ?? null;
  }
}
