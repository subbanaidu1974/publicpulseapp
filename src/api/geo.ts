import type { StateCode } from "../lib/states";
import { ApiError } from "./client";

/** Typed, cached client for the public boundary + unit contract: /api/v1/geo/:state/{ac,pc,district}.geojson and /units. */
export type GeoLevel = "ac" | "pc" | "district";
export interface GeoFeature { type: "Feature"; properties: Record<string, any>; geometry: any }
export interface GeoCollection { type: "FeatureCollection"; features: GeoFeature[] }

/** One unit row (mandal or village). Telugu name appears only where the server has one; censusCode is the Census 2011 code. */
export interface UnitRow { lgd: string; name: string; nameTe?: string | null; censusCode?: string | null }
export interface AcDetail {
  acNo: number;
  counts: { villages?: number; wards?: number; mandals?: number; urbanBodies?: number };
  mandals: UnitRow[];
  /** Census 2011 aggregate of the rural villages linked to this constituency, when the server has it */
  census: { population: number; villagesWithCensus: number; villagesTotal: number } | null;
}

const cache = new Map<string, Promise<any>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) { p = load().catch((e) => { cache.delete(key); throw e; }); cache.set(key, p); }
  return p as Promise<T>;
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try { res = await fetch(url); } catch { throw new ApiError("Network error: could not reach the data service.", 0, "network"); }
  if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status);
  return (await res.json()) as T;
}

export function fetchGeo(state: StateCode, level: GeoLevel): Promise<GeoCollection> {
  return cached(`geo:${state}:${level}`, async () => {
    const fc = await getJson<GeoCollection>(`/api/v1/geo/${state}/${level}.geojson`);
    if (!fc || !Array.isArray(fc.features)) throw new ApiError("Bad boundary file", 502);
    return fc;
  });
}

/** One town with a Telugu name (Wikidata, CC0), for the map background labels. */
export interface PlaceName { en: string; te: string; lon: number; lat: number; population: number }
/** GET /geo/:state/places.json: towns of at least 30,000 people that have a Telugu label. */
export function fetchPlaces(state: StateCode): Promise<PlaceName[]> {
  return cached(`places:${state}`, async () => {
    const r = await getJson<any>(`/api/v1/geo/${state}/places.json`);
    return (Array.isArray(r?.places) ? r.places : []).map((p: any[]) => ({ en: String(p[0]), te: String(p[1]), lon: Number(p[2]), lat: Number(p[3]), population: Number(p[4]) }));
  });
}

/** A village with a Telugu name and an approximate location, for the map labels shown when zoomed in. */
export interface VillageLabel { te: string; lon: number; lat: number }
/** GET /geo/:state/village-labels.json: only villages that have both a Telugu name and a location point (mostly Telangana). */
export function fetchVillageLabels(state: StateCode): Promise<VillageLabel[]> {
  return cached(`vlabels:${state}`, async () => {
    const r = await getJson<any>(`/api/v1/geo/${state}/village-labels.json`);
    return (Array.isArray(r?.villages) ? r.villages : []).map((p: any[]) => ({ te: String(p[0]), lon: Number(p[1]), lat: Number(p[2]) }));
  });
}

/** GET /constituencies/:state/:acNo: unit counts and the mandals linked to one constituency. */
export function fetchAcDetail(state: StateCode, acNo: number): Promise<AcDetail> {
  return cached(`ac:${state}:${acNo}`, async () => {
    const r = await getJson<any>(`/api/v1/constituencies/${state}/${acNo}`);
    const u = r?.units ?? {};
    return {
      acNo,
      counts: { villages: u.villages, wards: u.wards, mandals: u.mandals, urbanBodies: u.urbanBodies },
      mandals: (Array.isArray(r?.mandals) ? r.mandals : []).map((m: any) => ({ lgd: String(m.code), name: String(m.nameEn ?? m.code), nameTe: m.nameTe ?? null })),
      census: r?.census && typeof r.census.population === "number" ? { population: r.census.population, villagesWithCensus: r.census.villagesWithCensus, villagesTotal: r.census.villagesTotal } : null,
    };
  });
}

/** GET /geo/:state/units?level=village&parent=<mandal LGD>: villages of one mandal (loaded on demand). */
export function fetchVillages(state: StateCode, mandalLgd: string): Promise<UnitRow[]> {
  return cached(`vil:${state}:${mandalLgd}`, async () => {
    const r = await getJson<any>(`/api/v1/geo/${state}/units?level=village&parent=${encodeURIComponent(mandalLgd)}&limit=200`);
    return (Array.isArray(r?.items) ? r.items : []).map((v: any) => ({ lgd: String(v.code), name: String(v.nameEn ?? v.code), nameTe: v.nameTe ?? null, censusCode: v.censusCode ?? null }));
  });
}

export interface CensusDistrict { district: string; population: number | null }
export async function fetchCensusDistricts(state: StateCode): Promise<CensusDistrict[] | null> {
  try {
    const r = await getJson<any>(`/api/v1/census/${state}/districts`);
    const rows: any[] = Array.isArray(r) ? r : r?.districts ?? r?.rows ?? [];
    return rows.length ? rows.map((x) => ({ district: String(x.district ?? x.name ?? ""), population: typeof x.population === "number" ? x.population : null })) : null;
  } catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 0)) return null; throw e; }
}

/** District-level issue totals from the public department metrics (server already hides cells under 30). null = endpoint or data missing. */
export async function fetchIssueTotals(): Promise<Record<string, number> | null> {
  try {
    const r = await getJson<any>("/api/v1/civic/issues/metrics?level=department");
    const out: Record<string, number> = {};
    for (const c of Array.isArray(r?.cells) ? r.cells : []) {
      if (c?.unit_level !== "district") continue;
      out[String(c.unit_lgd)] = (out[String(c.unit_lgd)] ?? 0) + Number(c.total || 0);
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** Telugu names (data/generated/geo/names-te.json) are loaded lazily; a missing key means no Telugu name is known. */
export interface TeNames { districts: Record<string, string>; acs: Record<string, string>; pcs: Record<string, string>; mandals: Record<string, string> }
export function fetchTeNames(state: StateCode): Promise<TeNames> {
  return cached(`te:${state}`, async () => {
    const mod: any = await import("../../data/generated/geo/names-te.json");
    const n = (mod.default ?? mod).names ?? {};
    return { districts: n.districts?.[state] ?? {}, acs: n.acs?.[state] ?? {}, pcs: n.pcs?.[state] ?? {}, mandals: n.mandals?.[state] ?? {} };
  });
}

/** S-198: free-licence winner photos (served from this site) with credit and licence. Only some winners have one. */
export interface WinnerPhoto { state: StateCode; year: number; acNo: number; candidate: string; file: string; author: string | null; licence: string; licenceUrl: string | null; source: string }
export function fetchWinnerPhotos(): Promise<WinnerPhoto[]> {
  return cached("winner-photos", async () => {
    const r = await getJson<any>("/api/v1/photos/index.json");
    return Array.isArray(r?.photos) ? (r.photos as WinnerPhoto[]) : [];
  });
}

/** S-199: free-licence photos of party heads (served from this site) with credit; only some parties have one. */
export interface LeaderPhoto { party: string; name: string; role: string; file: string; author: string | null; licence: string; licenceUrl: string | null; source: string }
export function fetchLeaderPhotos(): Promise<LeaderPhoto[]> {
  return cached("leader-photos", async () => {
    const r = await getJson<any>("/api/v1/photos/leaders.json");
    return Array.isArray(r?.photos) ? (r.photos as LeaderPhoto[]) : [];
  });
}
