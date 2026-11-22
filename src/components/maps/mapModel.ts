import partiesData from "../../../data/reference/parties.json";
import type { StateCode } from "../../lib/states";

/** Pure map model: hash routing, colours, metrics and table rows. No DOM or Leaflet here so it is unit-testable in node. */

export type MapLevel = "district" | "ac" | "pc";
export type MetricId = "winner" | "margin" | "turnout" | "reservation" | "population" | "issues";

export const METRICS_BY_LEVEL: Record<MapLevel, MetricId[]> = {
  district: ["winner", "population", "issues"],
  ac: ["winner", "margin", "turnout", "reservation"],
  pc: ["winner", "margin", "turnout", "reservation"],
};

/** Issue and other civic aggregates are never shown for cells below this many reports. */
export const MIN_CELL = 30;

/* ---------- hash routing: #/map/TG[/district/<lgd>][/ac/<n> | /pc/<n>] ---------- */

export interface MapRoute { state: StateCode; level: MapLevel; district?: string; ac?: number; pc?: number }

export function parseHash(hash: string): MapRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "map") return null;
  const st = (parts[1] ?? "").toUpperCase();
  if (st !== "AP" && st !== "TG") return null;
  const r: MapRoute = { state: st as StateCode, level: "district" };
  let i = 2;
  while (i < parts.length) {
    const k = parts[i], v = parts[i + 1];
    if (k === "district") { if (!v || !/^\w+$/.test(v)) return null; r.district = v; r.level = "ac"; i += 2; }
    else if (k === "ac" || k === "pc") {
      r.level = k;
      if (v !== undefined && /^\d+$/.test(v)) { r[k] = Number(v); i += 2; } else i += 1;
    } else return null;
  }
  return r;
}

export function buildHash(r: MapRoute): string {
  let h = `#/map/${r.state}`;
  if (r.district) h += `/district/${encodeURIComponent(r.district)}`;
  if (r.level === "ac" && (r.ac !== undefined || !r.district)) h += r.ac !== undefined ? `/ac/${r.ac}` : "/ac";
  else if (r.level === "pc") h += r.pc !== undefined ? `/pc/${r.pc}` : "/pc";
  return h;
}

/* ---------- party colours ---------- */

interface PartyRec { code: string; aliases?: string[]; name: { en: string; te: string | null }; color: string }
const parties = (partiesData as any).parties as PartyRec[];
const others = (partiesData as any).othersBucket as { code: string; name: { en: string; te: string | null }; color: string };
const byCode = new Map<string, PartyRec>();
for (const p of parties) { byCode.set(p.code.toUpperCase(), p); for (const a of p.aliases ?? []) byCode.set(a.toUpperCase(), p); }

export interface PartyInfo { code: string; name: string; nameTe: string | null; color: string; known: boolean }
export function partyInfo(code: string | undefined | null): PartyInfo {
  const c = String(code ?? "").trim();
  const p = byCode.get(c.toUpperCase());
  if (p) return { code: p.code, name: p.name.en, nameTe: p.name.te, color: p.color, known: true };
  return { code: c || others.code, name: c || others.name.en, nameTe: others.name.te, color: others.color, known: false };
}

/* ---------- sequential and categorical colours ---------- */

export const NO_DATA = "#c9c4b8";
const RAMP = ["#efe6cf", "#e0c98b", "#c9a24a", "#9a6f1c", "#5b3b0a"];
export interface Bin { from: number; to: number; color: string }

/** Five equal bins over [min,max]; bins are what the legend shows, so the colour of a value is always explainable. */
export function makeBins(min: number, max: number): Bin[] {
  if (!(max > min)) return [{ from: min, to: max, color: RAMP[2] }];
  const step = (max - min) / RAMP.length;
  return RAMP.map((color, i) => ({ from: min + step * i, to: i === RAMP.length - 1 ? max : min + step * (i + 1), color }));
}
export function binColor(bins: Bin[], v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return NO_DATA;
  for (let i = bins.length - 1; i >= 0; i--) if (v >= bins[i].from) return bins[i].color;
  return bins[0].color;
}

export const RESERVATION_COLORS: Record<string, string> = { GEN: "#d8d2c2", SC: "#7b3f9e", ST: "#2e7d4f" };

/* ---------- data joins ---------- */

export interface SeatLite { acNo: number; winnerParty?: string; marginPct?: number; turnout?: number; winner?: string }

/** Normalised name key for joining census (2011 names) to current districts. */
const ALIASES: Record<string, string> = { ysrkadapa: "kadapa", ananthapuramu: "anantapur", mahbubnagar: "mahabubnagar" };
export function nameKey(s: string): string {
  const k = s.toLowerCase().replace(/\bdistrict\b/g, "").replace(/[^a-z]/g, "");
  return ALIASES[k] ?? k;
}

export function populationByDistrict(rows: { district: string; population: number | null }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (r.population !== null && r.population > 0) m.set(nameKey(r.district), r.population);
  return m;
}

export type Tally = Map<string, { seats: number; tally: Record<string, number> }>;

/** Seats won per party in each district, attributing a constituency to its majority district (districtLgd). */
export function districtTally(acFeatures: { properties: Record<string, any> }[], seats: Map<number, SeatLite>): Tally {
  const out: Tally = new Map();
  for (const f of acFeatures) {
    const d = String(f.properties.districtLgd ?? "");
    const s = seats.get(Number(f.properties.acNo));
    if (!d || !s?.winnerParty) continue;
    const e = out.get(d) ?? { seats: 0, tally: {} };
    e.seats += 1;
    e.tally[s.winnerParty] = (e.tally[s.winnerParty] ?? 0) + 1;
    out.set(d, e);
  }
  return out;
}

/** Leading party of a tally; ties return "tied" so the map never declares a winner it cannot back. */
export function leader(tally: Record<string, number>): { party: string; seats: number } | "tied" | null {
  const e = Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!e.length) return null;
  if (e.length > 1 && e[0][1] === e[1][1]) return "tied";
  return { party: e[0][0], seats: e[0][1] };
}

/* ---------- row model used by both the map and the accessible table ---------- */

export interface Row {
  key: string;
  level: MapLevel;
  name: string;
  sub?: string;
  /** numeric value used for sorting and colour bins; null = no data */
  value: number | null;
  /** text shown in the table and tooltip */
  text: string;
  /** category (party code, reservation) when the metric is categorical */
  category?: string;
  color: string;
}

export interface MetricCtx {
  metric: MetricId;
  seats: Map<number, SeatLite>;
  tally: Tally;
  population: Map<string, number> | null;
  issues: Record<string, number> | null;
  tied: string;
  noData: string;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-IN");

export function buildRows(level: MapLevel, features: { properties: Record<string, any> }[], ctx: MetricCtx): { rows: Row[]; bins: Bin[] | null; coverage: number } {
  const raw: Omit<Row, "color">[] = [];
  const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const f of features) {
    const p = f.properties;
    if (level === "district") {
      const lgd = String(p.districtLgd ?? p.district);
      const base = { key: lgd, level, name: String(p.district) };
      const t = ctx.tally.get(lgd);
      if (ctx.metric === "winner") {
        const l = t ? leader(t.tally) : null;
        raw.push({ ...base, value: l && l !== "tied" ? l.seats : null, category: l && l !== "tied" ? l.party : undefined, text: !t ? ctx.noData : l === "tied" ? ctx.tied : l ? `${l.party} ${l.seats}/${t.seats}` : ctx.noData });
      } else if (ctx.metric === "population") {
        const v = ctx.population?.get(nameKey(String(p.district))) ?? null;
        raw.push({ ...base, value: v, text: v === null ? ctx.noData : fmtInt(v) });
      } else {
        const v = num(ctx.issues?.[lgd]);
        const ok = v !== null && v >= MIN_CELL ? v : null;
        raw.push({ ...base, value: ok, text: ok === null ? ctx.noData : fmtInt(ok) });
      }
    } else {
      const no = Number(level === "pc" ? p.pcNo : p.acNo);
      const s = ctx.seats.get(no);
      const base = { key: String(no), level, name: String(level === "pc" ? p.pcName : p.acName), sub: level === "ac" ? String(p.district ?? "") : undefined };
      if (ctx.metric === "winner") raw.push({ ...base, value: s?.winnerParty ? 1 : null, category: s?.winnerParty, text: s?.winnerParty ? `${s.winnerParty}${s.winner ? `, ${s.winner}` : ""}` : ctx.noData });
      else if (ctx.metric === "margin") { const v = num(s?.marginPct); raw.push({ ...base, value: v, text: v === null ? ctx.noData : `${v.toFixed(1)}%` }); }
      else if (ctx.metric === "turnout") { const v = num(s?.turnout); raw.push({ ...base, value: v, text: v === null ? ctx.noData : `${v.toFixed(1)}%` }); }
      else raw.push({ ...base, value: null, category: String(p.reservation ?? "GEN"), text: String(p.reservation ?? "GEN") });
    }
  }
  const categorical = ctx.metric === "winner" || ctx.metric === "reservation";
  let bins: Bin[] | null = null;
  if (!categorical) {
    const vs = raw.map((r) => r.value).filter((v): v is number => v !== null);
    bins = vs.length ? makeBins(Math.min(...vs), Math.max(...vs)) : null;
  }
  const rows: Row[] = raw.map((r) => ({
    ...r,
    color: categorical
      ? ctx.metric === "reservation" ? RESERVATION_COLORS[r.category ?? "GEN"] ?? NO_DATA : r.category ? partyInfo(r.category).color : NO_DATA
      : bins ? binColor(bins, r.value) : NO_DATA,
  }));
  const have = rows.filter((r) => (categorical ? r.category !== undefined : r.value !== null)).length;
  return { rows, bins, coverage: rows.length ? have / rows.length : 0 };
}

export function sortRows(rows: Row[], by: "name" | "value", dir: 1 | -1): Row[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (by === "name") return dir * a.name.localeCompare(b.name);
    const av = a.value, bv = b.value;
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1; // missing values always last
    if (bv === null) return -1;
    return dir * (av - bv) || a.name.localeCompare(b.name);
  });
  return out;
}

export function acsInDistrict<T extends { properties: Record<string, any> }>(fs: T[], districtLgd: string): T[] {
  return fs.filter((f) => String(f.properties.districtLgd) === districtLgd);
}
