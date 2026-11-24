/**
 * Electors by assembly constituency from the ECI General Election 2024 statistical report, table 15
 * "Assembly segment wise information of electors" (text extracted with `pdftotext -raw`).
 * Counts only: no elector-level data is read or kept (S-86; docs/DESIGN_2028.md legal guard).
 */
export interface ElectorsRow {
  state: "AP" | "TG";
  acNo: number;
  acName: string;
  /** Parliamentary constituency the AC is grouped under in the ECI table */
  pcName: string;
  generalMale: number;
  generalFemale: number;
  generalThirdGender: number;
  generalTotal: number;
  nriMale: number;
  nriFemale: number;
  nriThirdGender: number;
  nriTotal: number;
  serviceMale: number;
  serviceFemale: number;
  serviceTotal: number;
  /** general + NRI + service electors, as printed by ECI */
  totalElectors: number;
  /** Valid votes + NOTA polled on EVM, as printed by ECI (postal ballots excluded) */
  votesPolledEvm: number;
}

export interface RawElectorsRow extends Omit<ElectorsRow, "acNo"> { acNo?: number }

const STATE_HEADERS: Record<string, "AP" | "TG"> = { "Andhra Pradesh": "AP", Telangana: "TG" };
const NUMS = 13;

/** Parse the raw text of the ECI table. Rows of other states, PC subtotal rows and state totals are skipped. */
export function parseElectorsText(text: string): RawElectorsRow[] {
  const out: RawElectorsRow[] = [];
  let state: "AP" | "TG" | null = null, pc = "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const sm = /^State:\s*(.+)$/.exec(t);
    if (sm) { state = STATE_HEADERS[sm[1].trim()] ?? null; pc = ""; continue; }
    if (!state) continue;
    const pm = /^PC:-\s*(.+?)(\s+\d[\d\s]*)?$/.exec(t);
    if (pm) { if (!pm[2]) pc = pm[1].trim(); continue; }
    const m = /^(.*?[A-Za-z.)])\s+((?:\d+\s+){12}\d+)$/.exec(t);
    if (!m) continue;
    const n = m[2].split(/\s+/).map(Number);
    if (n.length !== NUMS) continue;
    const name = m[1].trim();
    if (Object.keys(STATE_HEADERS).some(s => s.toLowerCase() === name.toLowerCase())) continue; // state total row
    const [gm, gf, gt, gtot, nm, nf, nt, ntot, sm2, sf, stot, total, polled] = n;
    out.push({
      state, acName: name, pcName: pc, generalMale: gm, generalFemale: gf, generalThirdGender: gt, generalTotal: gtot,
      nriMale: nm, nriFemale: nf, nriThirdGender: nt, nriTotal: ntot, serviceMale: sm2, serviceFemale: sf, serviceTotal: stot,
      totalElectors: total, votesPolledEvm: polled,
    });
  }
  return out;
}

/** Internal-consistency checks on the printed numbers. */
export function validateElectors(rows: RawElectorsRow[]): string[] {
  const errs: string[] = [];
  for (const r of rows) {
    const id = `${r.state} ${r.acName}`;
    if (r.generalMale + r.generalFemale + r.generalThirdGender !== r.generalTotal) errs.push(`general M+F+TG != total: ${id}`);
    if (r.nriMale + r.nriFemale + r.nriThirdGender !== r.nriTotal) errs.push(`NRI M+F+TG != total: ${id}`);
    if (r.serviceMale + r.serviceFemale !== r.serviceTotal) errs.push(`service M+F != total: ${id}`);
    if (r.generalTotal + r.nriTotal + r.serviceTotal !== r.totalElectors) errs.push(`general+NRI+service != total electors: ${id}`);
    if (r.votesPolledEvm < 0 || r.votesPolledEvm > r.totalElectors) errs.push(`votes polled out of range: ${id}`);
  }
  return errs;
}

/** Spelling variants between the ECI statistical report and the results files (verified by hand, 2026-11-24). */
const AC_ALIASES: Record<string, string> = { ZAHEERABAD: "ZAHIRABAD", KUKATPALLY: "KUKATPALLE" };
/** Name key: upper case, letters and digits only, reservation tag kept (Gannavaram vs Gannavaram(SC) are different seats). */
export const normAcName = (s: string) => {
  const k = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return AC_ALIASES[k] ?? k;
};
