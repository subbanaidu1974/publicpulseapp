/** S-83: Telugu gazetteer matching (Wikidata labels + LGD local names). Pure functions; network lives in the script. */
import type { StateCode } from "../../src/lib/states";
import { nameClose, normName } from "./util";

export const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
export const WD = {
  districtOfIndia: "Q1149652", stateAP: "Q1159", stateTG: "Q677037",
  mandalAP: "Q122987710", mandalTG: "Q122987738",
  acAP: "Q54375413", acTG: "Q54375514",
};

export interface WdItem { qid: string; en: string; te: string; parent: string }
export const hasTelugu = (s: string) => /[ఀ-౿]/.test(s);

/** Parse a SPARQL JSON result with variables item, en, te and optional parentLabel. Keeps Telugu-script labels only. */
export function parseWd(json: any): WdItem[] {
  const out = new Map<string, WdItem>();
  for (const b of json?.results?.bindings ?? []) {
    const qid = String(b.item?.value ?? "").split("/").pop() ?? "";
    if (!qid) continue;
    const te = String(b.te?.value ?? ""), en = String(b.en?.value ?? "");
    const prev = out.get(qid);
    out.set(qid, { qid, en: en || prev?.en || "", te: hasTelugu(te) ? te : prev?.te ?? "", parent: String(b.parentLabel?.value ?? prev?.parent ?? "") });
  }
  return [...out.values()].sort((a, b) => a.qid.localeCompare(b.qid, "en", { numeric: true }));
}

const strip = (s: string, re: RegExp) => s.replace(re, "").trim();
export const stripDistrict = (s: string) => strip(s, /\s+district$/i);
export const stripMandal = (s: string) => strip(s, /\s+mandal$/i);
export const stripAc = (s: string) => strip(s, /\s+assembly constituency$/i);
/** Telugu district labels end in "జిల్లా" (district); keep that word out of the name stored for a unit. */
export const stripTeDistrict = (s: string) => s.replace(/\s*జిల్లా$/u, "").trim();
/** Telugu AC/PC labels carry a constituency suffix in several spellings; strip it. */
export const stripTeAc = (s: string) => s.replace(/\s*(?:అసెంబ్లీ|శాసనసభా?|శాసన సభ)?\s*నియోజకవర్గం$/u, "").trim();
export const stripTePc = (s: string) => s.replace(/\s*(?:లోక్\s*సభ|లోకసభ|పార్లమెంటు|పార్లమెంట్)?\s*నియోజకవర్గం$/u, "").trim();
export const stripTeMandal = (s: string) => s.replace(/\s*మండలం$/u, "").trim();

export interface Matched { te: string; qid: string }
export interface MatchResult { matched: Map<string, Matched>; ambiguous: string[]; unmatched: string[] }

/**
 * Match our units (keyed by id, with an English name and optional hint = parent name) to Wikidata items.
 * An item is used at most once. Ties are broken by the parent hint; otherwise the unit is reported as ambiguous.
 */
export function matchUnits(
  units: { id: string; name: string; hint?: string }[], items: WdItem[], strip_: (s: string) => string, stripTe: (s: string) => string,
): MatchResult {
  const matched = new Map<string, Matched>(), ambiguous: string[] = [], unmatched: string[] = [];
  const used = new Set<string>();
  const withTe = items.filter(i => i.te);
  for (const u of units) {
    let cands = withTe.filter(i => !used.has(i.qid) && normName(strip_(i.en)) === normName(u.name));
    if (!cands.length) cands = withTe.filter(i => !used.has(i.qid) && nameClose(strip_(i.en), u.name));
    if (cands.length > 1 && u.hint) {
      const h = cands.filter(c => c.parent && (nameClose(stripDistrict(c.parent), u.hint!) || normName(c.parent).includes(normName(u.hint!))));
      if (h.length) cands = h;
    }
    if (cands.length === 1) { matched.set(u.id, { te: stripTe(cands[0].te), qid: cands[0].qid }); used.add(cands[0].qid); }
    else if (cands.length > 1) ambiguous.push(`${u.id} ${u.name}`);
    else unmatched.push(`${u.id} ${u.name}`);
  }
  return { matched, ambiguous, unmatched };
}

export interface Coverage { total: number; withTelugu: number; pct: number }
export const coverage = (total: number, withTelugu: number): Coverage => ({ total, withTelugu, pct: total ? Math.round((withTelugu / total) * 1000) / 10 : 0 });

export const stateQid = (s: StateCode) => (s === "AP" ? WD.stateAP : WD.stateTG);
