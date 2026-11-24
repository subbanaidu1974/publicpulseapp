/** S-102: effective-dated link between LGD AC codes and ECI election constituency numbers. */
import fs from "node:fs";
import path from "node:path";
import type { StateCode } from "../../src/lib/states";
import type { AcMeta } from "./constituency";
import { acNoFromEci, type AcUnit } from "./lgd";
import { nameClose } from "./util";
import { CURRENT_SET_ID, selectSet, VersionError, type VersionRegistry } from "./versions";

/** 2008 delimitation order in force for all AP/TG ECI elections to date. Exact date inferred, not verified. */
export const DELIMITATION_2008_FROM = "2008-02-19";

export interface AcLinkRow {
  state: StateCode; acNo: number; eci: number; lgd: string; name: string; pcNo: number | null; reservation: string | null;
  validFrom: string; validTo: string | null; datesInferred: true;
  /** S-92: boundary set the row belongs to (absent = the 2008 delimitation) and the AC's district (filled from ac-units on load) */
  set?: string; districtLgd?: string | null;
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
  /* ---------- S-92: version-aware lookups. Every call names (or defaults) ONE boundary set; rows of other sets are never read. ---------- */
  private reg: VersionRegistry | null = null;
  /** Attach the registry so lookups can select a set by id or date. */
  withRegistry(reg: VersionRegistry | null): this { this.reg = reg; return this; }
  /** Fill districtLgd on legacy rows from ac-units.json (state -> acNo -> unit with .district). */
  withDistricts(units: Record<string, Record<string, { district?: string | null }>>): this {
    for (const r of this.rows) if (r.districtLgd === undefined) r.districtLgd = units?.[r.state]?.[String(r.acNo)]?.district ?? null;
    return this;
  }
  /** The set a selector resolves to; with no registry only the legacy 2008 set exists. */
  setIdFor(sel: VersionSel = {}, now?: string): string {
    if (!this.reg) {
      if (sel.version && sel.version !== CURRENT_SET_ID) throw new VersionError("unknown_version", `No boundary set '${sel.version}'`);
      return CURRENT_SET_ID;
    }
    return selectSet(this.reg, sel, now).id;
  }
  rowIn(state: StateCode, acNo: number, sel: VersionSel = {}, now?: string): AcLinkRow | null {
    const id = this.setIdFor(sel, now);
    return this.rows.find(r => r.state === state && r.acNo === acNo && (r.set ?? CURRENT_SET_ID) === id) ?? null;
  }
  pcOf(state: StateCode, acNo: number, sel: VersionSel = {}, now?: string): number | null { return this.rowIn(state, acNo, sel, now)?.pcNo ?? null; }
  districtOf(state: StateCode, acNo: number, sel: VersionSel = {}, now?: string): string | null { return this.rowIn(state, acNo, sel, now)?.districtLgd ?? null; }
  acsOfPc(state: StateCode, pcNo: number, sel: VersionSel = {}, now?: string): number[] {
    const id = this.setIdFor(sel, now);
    return this.rows.filter(r => r.state === state && r.pcNo === pcNo && (r.set ?? CURRENT_SET_ID) === id).map(r => r.acNo).sort((a, b) => a - b);
  }
  acsOfDistrict(state: StateCode, districtLgd: string, sel: VersionSel = {}, now?: string): number[] {
    const id = this.setIdFor(sel, now);
    return this.rows.filter(r => r.state === state && r.districtLgd === districtLgd && (r.set ?? CURRENT_SET_ID) === id).map(r => r.acNo).sort((a, b) => a - b);
  }
}
export interface VersionSel { asOf?: string; version?: string }
