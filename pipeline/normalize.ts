import type { CandidateResult } from "../src/lib/elections";
import type { ElectionType, StateCode } from "../src/lib/states";

type Provenance = NonNullable<CandidateResult["provenance"]>;

/** Minimal RFC4180 CSV parser (quotes, escaped quotes, CRLF, BOM). Returns array of header-keyed records. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map(h => h.trim());
  return nonEmpty.slice(1).map(r => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
}

const PARTY_ALIASES: Record<string, string> = {
  TRS: "BRS", BRS: "BRS",
  JNP: "JSP", JSP: "JSP", JANASENA: "JSP",
  TDP: "TDP", TELUGUDESAM: "TDP",
  YSRCP: "YSRCP", YSRC: "YSRCP", YSRCONGRESS: "YSRCP", "YSR CONGRESS PARTY": "YSRCP",
  INC: "INC", CONGRESS: "INC", "INDIAN NATIONAL CONGRESS": "INC",
  BJP: "BJP",
  AIMIM: "AIMIM", MIM: "AIMIM",
  CPI: "CPI", "CPI(M)": "CPM", CPM: "CPM", CPIM: "CPM",
  IND: "IND", NOTA: "NOTA",
};

/** Canonical party code: uppercase/trimmed, known aliases mapped (TRS->BRS, JnP->JSP, ...). */
export function canonicalParty(p: string): string {
  const raw = (p ?? "").trim();
  if (!raw) return "IND";
  const up = raw.toUpperCase();
  return PARTY_ALIASES[up] ?? PARTY_ALIASES[up.replace(/[\s._-]/g, "")] ?? up;
}

const STATE_MAP: Record<string, StateCode> = {
  ANDHRA_PRADESH: "AP", "ANDHRA PRADESH": "AP", TELANGANA: "TG",
};

const toInt = (s: string | undefined): number => {
  const n = Number((s ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && (s ?? "").trim() !== "" ? Math.trunc(n) : NaN;
};

/** Normalise a TCPD Lok Dhaba CSV into CandidateResult rows (AP/TG only; invalid rows skipped). Deterministically sorted. */
export function normalizeTcpd(csv: string, type: ElectionType, provenance: Provenance): CandidateResult[] {
  const out: CandidateResult[] = [];
  for (const r of parseCsv(csv)) {
    const state = STATE_MAP[(r.State_Name ?? "").trim().toUpperCase()];
    if (!state) continue;
    // TCPD marks by-elections / repolls with Poll_No > 0: keep only the general election round.
    const poll = (r.Poll_No ?? "").trim();
    if (poll !== "" && Number(poll) !== 0) continue;
    const year = toInt(r.Year), acNo = toInt(r.Constituency_No), votes = toInt(r.Votes);
    const position = toInt(r.Position), validVotes = toInt(r.Valid_Votes);
    const candidate = (r.Candidate ?? "").trim();
    const acName = (r.Constituency_Name ?? "").trim();
    if ([year, acNo, votes, position, validVotes].some(Number.isNaN)) continue;
    if (!candidate || !acName || votes < 0 || position < 1 || validVotes < 0) continue;
    const row: CandidateResult = {
      state, year, type, acNo, acName,
      candidate, party: canonicalParty(r.Party), votes, position, validVotes, provenance,
    };
    if (r.District_Name) row.district = r.District_Name.trim();
    const electors = toInt(r.Electors);
    if (!Number.isNaN(electors) && electors > 0) row.electors = electors;
    out.push(row);
  }
  return sortResults(out);
}

export function sortResults(rows: CandidateResult[]): CandidateResult[] {
  return [...rows].sort((a, b) =>
    a.state.localeCompare(b.state) || a.year - b.year || a.type.localeCompare(b.type) ||
    a.acNo - b.acNo || a.position - b.position || a.candidate.localeCompare(b.candidate));
}
