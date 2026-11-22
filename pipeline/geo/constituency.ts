/** Reservation (GEN/SC/ST) and PC link per AC from the DataMeet copy of the 2008 ECI delimitation table. */
import type { StateCode } from "../../src/lib/states";
import { AP_AC_OFFSET, AP_PC_OFFSET } from "./lgd";
import { parseCsv } from "./util";

export type Reservation = "GEN" | "SC" | "ST";
export interface AcMeta { state: StateCode; acNo: number; undividedAcNo: number; name: string; reservation: Reservation; pcNo: number; pcName: string; pcReservation: Reservation }
export interface PcMeta { state: StateCode; pcNo: number; undividedPcNo: number; name: string; reservation: Reservation }

const res = (v: string): Reservation => (v === "SC" ? "SC" : v === "ST" ? "ST" : "GEN");

/**
 * The CSV lists all of undivided Andhra Pradesh under state code S01/AP (294 ACs, 42 PCs).
 * Telangana ACs are 1-119 and PCs 1-17; AP ACs 120-294 and PCs 18-42, renumbered by subtracting 119 and 17.
 */
export function parse2008(csv: string): { acs: AcMeta[]; pcs: PcMeta[]; errors: string[] } {
  const errors: string[] = [];
  const rows = parseCsv(csv).filter(r => r.ST_ABBR === "AP" && r.ST_NAME === "ANDHRA PRADESH");
  const acs: AcMeta[] = [], pcMap = new Map<number, PcMeta>();
  for (const r of rows) {
    const ac = Number(r.AC_CODE), pc = Number(r.PC_CODE);
    if (!Number.isInteger(ac) || !Number.isInteger(pc)) { errors.push(`bad row ${JSON.stringify(r)}`); continue; }
    const state: StateCode = ac <= AP_AC_OFFSET ? "TG" : "AP";
    if ((state === "TG") !== (pc <= AP_PC_OFFSET)) errors.push(`AC ${ac} (${state}) links to PC ${pc} on the other side of the split`);
    const pcNo = state === "TG" ? pc : pc - AP_PC_OFFSET;
    acs.push({ state, acNo: state === "TG" ? ac : ac - AP_AC_OFFSET, undividedAcNo: ac, name: r.AC_NAME, reservation: res(r.AC_TYPE), pcNo, pcName: r.PC_NAME, pcReservation: res(r.PC_TYPE) });
    pcMap.set(pc, { state, pcNo, undividedPcNo: pc, name: r.PC_NAME, reservation: res(r.PC_TYPE) });
  }
  acs.sort((a, b) => a.state.localeCompare(b.state) || a.acNo - b.acNo);
  return { acs, pcs: [...pcMap.values()].sort((a, b) => a.state.localeCompare(b.state) || a.pcNo - b.pcNo), errors };
}
