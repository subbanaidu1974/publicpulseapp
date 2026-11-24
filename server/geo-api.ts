/**
 * Geography and profile API (S-100, S-98/99 backing, S-95), mounted from server/api.ts under /api/v1:
 *   GET /geo/:state/(ac|pc|district).geojson   boundary files with ETag + Cache-Control
 *   GET /geo/:state/mandal.geojson             mandal polygons (OSM, ODbL; only units matched to LGD with confidence >= 0.8)
 *   (boundary files accept ?version=<set id> or ?asOf=YYYY-MM-DD, default current; S-92)
 *   GET /geo/:state/polling-stations?ac=       polling-station reference list (operator-imported; never voter-level; S-91)
 *   GET /geo/:state/units?level=&parent=       LGD tree, paginated, English + Telugu names (never invented)
 *   GET /geo/:state/village-points?mandal=     village locations (approximate points, Wikidata CC0 + OSM ODbL; S-90). Not boundaries.
 *   GET /geo/:state/search?q=                  English or Telugu, districts / mandals / villages / ACs
 *   GET /geo/:state/places/:level/:code        mandal / village / district profile data (census when rows exist)
 *   GET /electors/:state                       electors by AC from the 2024 general-election rolls (not SSR 2025)
 *   GET /constituencies/:state/:acNo           one AC: history across elections, units, PC, links
 *   GET /elections/:state/split-voting?year=   assembly winner vs the Lok Sabha winner of the AC's PC
 * All data is read from data/generated; nothing is fetched at request time.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Datasets } from "./api";
import { seatResults } from "../src/lib/elections";
import type { CandidateResult } from "../src/lib/elections";
import { STATES, isStateCode } from "../src/lib/states";
import type { StateCode } from "../src/lib/states";
import { splitVotingReport } from "../src/lib/splitvoting";
import { loadSegments } from "../pipeline/lsmap/segments";
import { loadRegistry, selectSet, VersionError } from "../pipeline/geo/versions";
import { toReference } from "../pipeline/geo/pollingstations";
import type { PollingStation } from "../pipeline/geo/pollingstations";
import type { SegmentsFile } from "../pipeline/lsmap/segments";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const GEOJSON = { ac: "ac", pc: "pc", district: "district", mandal: "mandal" } as const;
const LEVELS = ["district", "mandal", "village"] as const;
type Level = (typeof LEVELS)[number];

const err = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: message, code });
const first = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const MAX_Q = 80;

interface StateGeo {
  state: StateCode;
  districts: { code: string; en: string; te?: string; census: string }[];
  districtByCode: Map<string, StateGeo["districts"][number]>;
  mandals: { code: string; en: string; te?: string; district: string; census: string }[];
  mandalByCode: Map<string, StateGeo["mandals"][number]>;
  mandalsByDistrict: Map<string, StateGeo["mandals"]>;
  villages: { code: string; en: string; te?: string; mandal: string; census: string; category: string }[];
  villageByCode: Map<string, StateGeo["villages"][number]>;
  villagesByMandal: Map<string, StateGeo["villages"]>;
  acs: { acNo: number; en: string; te?: string; lgd: string; district: string | null; districtShare: number; pcNo: number | null; reservation: string | null; counts: Json; mandals: number[]; villages: number[] }[];
  acByNo: Map<number, StateGeo["acs"][number]>;
  /** LGD village code -> acNo, LGD mandal code -> acNos */
  villageAc: Map<string, number>;
  mandalAcs: Map<string, number[]>;
  pcs: Map<number, { pcNo: number; en: string | null; te?: string; reservation: string | null }>;
  asOf: string | null;
}

export function createGeoApiRouter(data: Datasets, opts: { baseDir?: string } = {}): Router {
  const router = Router();
  const baseDir = opts.baseDir ?? process.cwd();
  const geoDir = path.join(baseDir, "data", "generated", "geo");
  const readJson = (f: string): Json | null => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

  const src = (...ids: string[]) => ids.flatMap(id => (data.manifest?.[id] ? [data.manifest[id]] : []));
  const sourceOf = (...ids: string[]) => { const s = src(...ids); return s.length ? s : undefined; };

  /* ---------- lazy per-state geography index ---------- */
  const cache = new Map<StateCode, StateGeo | null>();
  let namesTe: Json | null | undefined;
  let acUnits: Json | null | undefined;
  let acLink: Json | null | undefined;
  const geoFor = (state: StateCode): StateGeo | null => {
    if (cache.has(state)) return cache.get(state)!;
    const lgd = readJson(path.join(geoDir, `lgd-${state}.json`));
    namesTe ??= readJson(path.join(geoDir, "names-te.json")) ?? null;
    acUnits ??= readJson(path.join(geoDir, "ac-units.json")) ?? null;
    acLink ??= readJson(path.join(geoDir, "ac-link.json")) ?? null;
    if (!lgd) { cache.set(state, null); return null; }
    const te = (kind: string, key: string | number): string | undefined => {
      const v = namesTe?.names?.[kind]?.[state]?.[String(key)];
      return typeof v === "string" && v ? v : undefined;
    };
    const districts = (lgd.districts as string[][]).map(d => ({ code: d[0], en: d[1], census: d[2], ...(te("districts", d[0]) ? { te: te("districts", d[0]) } : {}) }));
    const mandals = (lgd.mandals as string[][]).map(m => ({ code: m[0], en: m[1], district: m[2], census: m[3], ...(te("mandals", m[0]) ? { te: te("mandals", m[0]) } : {}) }));
    const villages = (lgd.villages as (string | number)[][]).map(v => ({
      code: String(v[0]), en: String(v[1]), mandal: String(v[3]), census: String(v[4]), category: String(v[5]), ...(v[2] ? { te: String(v[2]) } : {}),
    }));
    const g: StateGeo = {
      state, districts, districtByCode: new Map(districts.map(d => [d.code, d])),
      mandals, mandalByCode: new Map(mandals.map(m => [m.code, m])), mandalsByDistrict: new Map(),
      villages, villageByCode: new Map(villages.map(v => [v.code, v])), villagesByMandal: new Map(),
      acs: [], acByNo: new Map(), villageAc: new Map(), mandalAcs: new Map(), pcs: new Map(), asOf: lgd.asOf ?? null,
    };
    for (const m of mandals) (g.mandalsByDistrict.get(m.district) ?? g.mandalsByDistrict.set(m.district, []).get(m.district)!).push(m);
    for (const v of villages) (g.villagesByMandal.get(v.mandal) ?? g.villagesByMandal.set(v.mandal, []).get(v.mandal)!).push(v);
    const linkByNo = new Map<number, Json>((acLink?.rows ?? []).filter((r: Json) => r.state === state).map((r: Json) => [r.acNo, r]));
    for (const [no, u] of Object.entries<Json>(acUnits?.units?.[state] ?? {})) {
      const acNo = Number(no), l = linkByNo.get(acNo);
      const ac = {
        acNo, en: String(u.name), lgd: String(u.lgd), district: u.district ? String(u.district) : null, districtShare: Number(u.districtShare ?? 0),
        pcNo: (l?.pcNo ?? null) as number | null, reservation: (l?.reservation ?? null) as string | null, counts: u.counts ?? {},
        mandals: (u.mandals ?? []) as number[], villages: (u.villages ?? []) as number[],
        ...(te("acs", acNo) ? { te: te("acs", acNo) } : {}),
      };
      g.acs.push(ac); g.acByNo.set(acNo, ac);
      for (const v of ac.villages) g.villageAc.set(String(v), acNo);
      for (const m of ac.mandals) (g.mandalAcs.get(String(m)) ?? g.mandalAcs.set(String(m), []).get(String(m)!)!).push(acNo);
    }
    g.acs.sort((a, b) => a.acNo - b.acNo);
    const pcGeo = readJson(path.join(geoDir, `pc-${state}.geojson`));
    for (const f of pcGeo?.features ?? []) {
      const p = f.properties ?? {};
      if (typeof p.pcNo === "number") g.pcs.set(p.pcNo, { pcNo: p.pcNo, en: p.pcName ?? null, reservation: p.reservation ?? null, ...(te("pcs", p.pcNo) ? { te: te("pcs", p.pcNo) } : {}) });
    }
    cache.set(state, g);
    return g;
  };

  /* ---------- census join (lazy; village + sub-district rows keyed by Census 2011 code) ---------- */
  let censusUnits: Map<string, number[]> | null | undefined;
  let censusSubs: Map<string, Json> | null | undefined;
  const loadCensusUnits = () => {
    if (censusUnits !== undefined) return censusUnits;
    const raw = readJson(path.join(baseDir, "data", "generated", "census-units.json"));
    if (!raw?.units) return (censusUnits = null);
    censusUnits = new Map();
    // columns: kind,state,districtCode,subDistrictCode,code,name,households,population,males,females,scPop,stPop
    for (const u of raw.units as Json[][]) if (u[0] === "V") censusUnits.set(`${u[1]}|${u[4]}`, u as number[]);
    return censusUnits;
  };
  const loadCensusSubs = () => {
    if (censusSubs !== undefined) return censusSubs;
    const raw = readJson(path.join(baseDir, "data", "generated", "census-subdistricts.json"));
    if (!raw?.subDistricts) return (censusSubs = null);
    censusSubs = new Map();
    for (const s of raw.subDistricts as Json[]) censusSubs.set(`${s.state}|${s.districtCode}|${String(s.subDistrictCode).padStart(5, "0")}`, s);
    return censusSubs;
  };
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  const censusNote = "Census of India 2011 (village and town directories; literacy from the Primary Census Abstract). Literacy rate is literates over the population aged 7 and over. Where the Primary Census Abstract population does not match the directory population, literacy is reported as not available and is never estimated. Licence terms for the Census files are pending a human decision.";
  const LIT_SOURCE = "Census of India 2011, Primary Census Abstract (Census Digital Library, (c) ORGI; licence pending)";
  /** Literacy block: counts and the official rate, or null with a reason. Never estimated. */
  const literacyOf = (literate: unknown, pop0to6: unknown, population: number, officialPct?: unknown) => {
    if (typeof literate !== "number" || typeof pop0to6 !== "number" || !(population > pop0to6)) return null;
    const rate = typeof officialPct === "number" ? officialPct : pct(literate, population - pop0to6);
    return { literate, pop0to6, literacyPct: rate, source: LIT_SOURCE, censusYear: 2011, basis: "literates / (population - population aged 0-6)" };
  };
  const LIT_NA = "not available: the Primary Census Abstract population does not match the directory population for this unit, so literacy is not reported";

  /* ---------- boundary files ---------- */
  const fileCache = new Map<string, { body: Buffer; etag: string }>();
  router.get("/geo/:state/:file(ac|pc|district|mandal).geojson", (req, res) => sendGeojson(req, res));
  function sendGeojson(req: Request, res: Response) {
    const state = String(req.params.state).toUpperCase();
    if (!isStateCode(state)) return err(res, 404, "unknown_state", "Unknown state. Valid: AP, TG");
    const kind = GEOJSON[req.params.file as keyof typeof GEOJSON];
    let file = path.join(geoDir, `${kind}-${state}.geojson`);
    // S-92: ?version= / ?asOf= select a boundary set; default is the set in force today.
    const reg = loadRegistry(geoDir);
    const qv = first(req.query.version), qa = first(req.query.asOf);
    let setId: string | null = reg ? (selectSetSafe(reg)?.id ?? null) : null;
    if (reg && (qv !== undefined || qa !== undefined)) {
      try {
        const set = selectSet(reg, { version: qv, asOf: qa });
        const rel = set.files?.[kind]?.[state];
        if (!rel) return err(res, 404, "no_data", `Boundary set ${set.id} has no ${kind} boundaries for ${state}`);
        file = path.join(geoDir, rel); setId = set.id;
      } catch (e) {
        if (e instanceof VersionError) return err(res, e.code === "unknown_version" || e.code === "no_set_for_date" ? 404 : 400, e.code, e.message);
        throw e;
      }
    } else if (!reg && (qv !== undefined || qa !== undefined)) return err(res, 404, "no_versions", "No boundary version registry is available");
    let hit = fileCache.get(file);
    if (!hit) {
      try {
        const body = fs.readFileSync(file);
        hit = { body, etag: `"${crypto.createHash("sha1").update(body).digest("hex").slice(0, 20)}"` };
        fileCache.set(file, hit);
      } catch { return err(res, 404, "no_data", `No ${kind} boundaries for ${state}`); }
    }
    if (setId) res.set("X-Boundary-Version", setId);
    res.set({ ETag: hit.etag, "Cache-Control": "public, max-age=3600, must-revalidate", "Content-Type": "application/geo+json; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    if (req.headers["if-none-match"] === hit.etag) return res.status(304).end();
    return res.send(hit.body);
  }

  const selectSetSafe = (reg: NonNullable<ReturnType<typeof loadRegistry>>) => { try { return selectSet(reg); } catch { return null; } };

  const stateOr404 = (req: Request, res: Response): StateGeo | null => {
    const state = String(req.params.state).toUpperCase();
    if (!isStateCode(state)) { err(res, 404, "unknown_state", "Unknown state. Valid: AP, TG"); return null; }
    const g = geoFor(state);
    if (!g) { err(res, 404, "no_data", `No geography data for ${state}`); return null; }
    return g;
  };

  const pubCache = (res: Response, seconds = 300) => res.set("Cache-Control", `public, max-age=${seconds}`);
  const nameOf = (x: { en: string; te?: string }) => ({ nameEn: x.en, ...(x.te ? { nameTe: x.te } : {}) });
  const hrefOf = (st: StateCode, level: string, code: string | number) => level === "ac" ? `#/constituency/${st}/${code}` : `#/place/${st}/${level}/${code}`;

  /* ---------- polling-station reference list (S-91): operator-imported, reference fields only ---------- */
  router.get("/geo/:state/polling-stations", (req, res) => {
    const state = String(req.params.state).toUpperCase();
    if (!isStateCode(state)) return err(res, 404, "unknown_state", "Unknown state. Valid: AP, TG");
    const acq = first(req.query.ac);
    if (acq !== undefined && !/^\d{1,3}$/.test(acq)) return err(res, 400, "invalid_ac", "ac must be an assembly constituency number");
    const limit = Math.min(Math.max(parseInt(first(req.query.limit) ?? "", 10) || 100, 1), 500);
    const page = Math.max(parseInt(first(req.query.page) ?? "", 10) || 1, 1);
    const file = readJson(path.join(geoDir, `polling-stations-${state}.json`));
    pubCache(res, 300);
    if (!file || !Array.isArray(file.records)) {
      return res.json({ state, available: false, total: 0, page, limit, items: [], note: "No polling-station reference list has been imported for this state.", source: null });
    }
    // project to reference fields even if the file carries more: nothing voter-level can leave through this route
    let list: PollingStation[] = (file.records as PollingStation[]).map(toReference);
    if (acq !== undefined) list = list.filter(s => s.acNo === Number(acq));
    res.json({
      state, available: true, ac: acq !== undefined ? Number(acq) : null, total: list.length, page, limit, pages: Math.max(1, Math.ceil(list.length / limit)),
      items: list.slice((page - 1) * limit, page * limit), asOf: file.asOf ?? null, provenance: file.provenance ?? null,
      note: "Reference list only: station number, name, location and part. No voter data.", source: sourceOf("geo-polling-stations-" + state),
    });
  });

  /* ---------- units tree ---------- */
  router.get("/geo/:state/units", (req, res) => {
    const g = stateOr404(req, res); if (!g) return;
    const level = first(req.query.level) ?? "district";
    if (!(LEVELS as readonly string[]).includes(level)) return err(res, 400, "invalid_level", "level must be district, mandal or village");
    const parent = first(req.query.parent);
    const limit = Math.min(Math.max(parseInt(first(req.query.limit) ?? "", 10) || 50, 1), 200);
    const page = Math.max(parseInt(first(req.query.page) ?? "", 10) || 1, 1);
    const byName = (a: { en: string }, b: { en: string }) => a.en.localeCompare(b.en);
    let list: { code: string; en: string; te?: string; census?: string; parent?: string; category?: string }[];
    let parentInfo: Json = null;
    if (level === "district") {
      if (parent) return err(res, 400, "invalid_parent", "districts have no parent");
      list = g.districts.map(d => ({ ...d }));
    } else if (level === "mandal") {
      if (parent) {
        const d = g.districtByCode.get(parent);
        if (!d) return err(res, 404, "unknown_parent", `No district ${parent.slice(0, 20)} in ${g.state}`);
        parentInfo = { level: "district", code: d.code, ...nameOf(d) };
        list = (g.mandalsByDistrict.get(parent) ?? []).map(m => ({ code: m.code, en: m.en, te: m.te, census: m.census, parent: m.district }));
      } else list = g.mandals.map(m => ({ code: m.code, en: m.en, te: m.te, census: m.census, parent: m.district }));
    } else {
      if (parent) {
        const m = g.mandalByCode.get(parent);
        if (!m) return err(res, 404, "unknown_parent", `No mandal ${parent.slice(0, 20)} in ${g.state}`);
        parentInfo = { level: "mandal", code: m.code, ...nameOf(m) };
        list = (g.villagesByMandal.get(parent) ?? []).map(v => ({ code: v.code, en: v.en, te: v.te, census: v.census, parent: v.mandal, category: v.category }));
      } else list = g.villages.map(v => ({ code: v.code, en: v.en, te: v.te, census: v.census, parent: v.mandal, category: v.category }));
    }
    list = [...list].sort(byName);
    const total = list.length;
    const items = list.slice((page - 1) * limit, page * limit).map(u => ({
      level, code: u.code, ...nameOf(u as { en: string; te?: string }), censusCode: u.census, parent: u.parent ?? null,
      ...(level === "district" ? { mandals: g.mandalsByDistrict.get(u.code)?.length ?? 0 } : {}),
      ...(level === "mandal" ? { villages: g.villagesByMandal.get(u.code)?.length ?? 0 } : {}),
      ...(level === "village" ? { category: u.category } : {}),
      href: hrefOf(g.state, level, u.code),
    }));
    pubCache(res);
    res.json({ state: g.state, level, parent: parentInfo, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), items, asOf: g.asOf, source: sourceOf("geo-lgd-" + g.state, "geo-names-te") });
  });

  /* ---------- search ---------- */
  router.get("/geo/:state/search", (req, res) => {
    const g = stateOr404(req, res); if (!g) return;
    const qraw = first(req.query.q);
    if (!qraw || qraw.length < 2) return err(res, 400, "query_too_short", "q must be at least 2 characters");
    const q = qraw.slice(0, MAX_Q);
    const ql = q.toLowerCase();
    const limit = Math.min(Math.max(parseInt(first(req.query.limit) ?? "", 10) || 20, 1), 20);
    const KIND_ORDER = { ac: 0, district: 1, mandal: 2, village: 3 } as const;
    type Hit = { score: number; kind: keyof typeof KIND_ORDER; en: string; te?: string; code: string; path: string[]; extra?: Json };
    const hits: Hit[] = [];
    const stateName = STATES[g.state].name;
    const consider = (kind: Hit["kind"], x: { en: string; te?: string }, code: string, pathNames: () => string[], extra?: Json) => {
      const en = x.en.toLowerCase();
      let score = 99;
      if (en === ql || x.te === q) score = 0;
      else if (en.startsWith(ql) || x.te?.startsWith(q)) score = 1;
      else if (en.split(/[\s(),-]+/).some(w => w.startsWith(ql)) || x.te?.split(/[\s(),-]+/).some(w => w.startsWith(q))) score = 2;
      else if (en.includes(ql) || x.te?.includes(q)) score = 3;
      if (score < 99) hits.push({ score, kind, en: x.en, te: x.te, code, path: pathNames(), extra });
    };
    for (const a of g.acs) consider("ac", a, String(a.acNo), () => [stateName, g.districtByCode.get(a.district ?? "")?.en ?? ""].filter(Boolean), { acNo: a.acNo, reservation: a.reservation });
    for (const d of g.districts) consider("district", d, d.code, () => [stateName]);
    for (const m of g.mandals) consider("mandal", m, m.code, () => [stateName, g.districtByCode.get(m.district)?.en ?? ""].filter(Boolean));
    for (const v of g.villages) consider("village", v, v.code, () => {
      const m = g.mandalByCode.get(v.mandal);
      return [stateName, g.districtByCode.get(m?.district ?? "")?.en ?? "", m?.en ?? ""].filter(Boolean);
    });
    hits.sort((a, b) => a.score - b.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.en.localeCompare(b.en));
    pubCache(res, 60);
    res.json({
      state: g.state, q, total: hits.length, limit,
      results: hits.slice(0, limit).map(h => ({ kind: h.kind, code: h.code, ...nameOf(h), path: h.path, href: hrefOf(g.state, h.kind, h.code), ...(h.extra ?? {}) })),
      asOf: g.asOf, source: sourceOf("geo-names-te", "geo-ac-units"),
    });
  });


  /* ---------- village points (S-90): approximate locations keyed by LGD village code ---------- */
  type VPoint = { lon: number; lat: number; confidence: number; source: "wikidata" | "osm"; ref: string };
  const vpCache = new Map<StateCode, Map<string, VPoint> | null>();
  const villagePoints = (state: StateCode): Map<string, VPoint> | null => {
    if (vpCache.has(state)) return vpCache.get(state)!;
    const out = new Map<string, VPoint>();
    for (const layer of ["wikidata", "osm"] as const) {
      const f = readJson(path.join(geoDir, `village-points-${layer}-${state}.json`));
      for (const r of (f?.points ?? []) as (string | number)[][]) if (!out.has(String(r[0]))) out.set(String(r[0]), { lon: Number(r[2]), lat: Number(r[3]), confidence: Number(r[4]), source: layer, ref: String(r[5]) });
    }
    const res = out.size ? out : null;
    vpCache.set(state, res);
    return res;
  };
  const VP_NOTE = "Approximate village locations (a Wikidata coordinate or an OpenStreetMap place node), not boundaries and not surveyed centroids. Villages without a point are simply absent.";
  const VP_ATTR = "Village locations: Wikidata (CC0); (c) OpenStreetMap contributors, ODbL 1.0 for points with source osm.";

  router.get("/geo/:state/village-points", (req, res) => {
    const g = stateOr404(req, res); if (!g) return;
    const mandal = first(req.query.mandal);
    if (mandal !== undefined && !/^\d{1,8}$/.test(mandal)) return err(res, 400, "invalid_mandal", "mandal must be an LGD mandal code");
    const pts = villagePoints(g.state);
    pubCache(res, 300);
    if (!pts) return res.json({ state: g.state, available: false, total: 0, items: [], note: "No village point data has been built for this state.", source: null });
    const list = mandal !== undefined ? g.villagesByMandal.get(mandal) ?? [] : g.villages;
    const items = list.flatMap(v => { const p = pts.get(v.code); return p ? [{ code: v.code, censusCode: v.census, ...nameOf(v), mandal: v.mandal, lon: p.lon, lat: p.lat, confidence: p.confidence, source: p.source }] : []; });
    res.json({
      state: g.state, available: true, mandal: mandal ?? null, total: items.length, villagesInScope: list.length, items, note: VP_NOTE, attribution: VP_ATTR,
      source: sourceOf(`geo-village-points-wikidata-${g.state}`, `geo-village-points-osm-${g.state}`),
    });
  });

  /* ---------- place profile data (S-99) ---------- */
  router.get("/geo/:state/places/:level/:code", (req, res) => {
    const g = stateOr404(req, res); if (!g) return;
    const level = req.params.level as Level;
    if (!(LEVELS as readonly string[]).includes(level)) return err(res, 400, "invalid_level", "level must be district, mandal or village");
    const code = String(req.params.code).slice(0, 20);
    const stateName = STATES[g.state].name;
    const acRef = (acNo: number) => { const a = g.acByNo.get(acNo)!; return { acNo, ...nameOf(a), reservation: a.reservation, href: hrefOf(g.state, "ac", acNo) }; };
    const census = (row: Json | null, kind: string, extra: Json = {}) => row ? {
      available: true, censusYear: 2011, kind,
      literacyPct: null, literacyNote: LIT_NA, ...extra,
    } : { available: false, reason: "No Census 2011 row is linked to this unit's census code.", censusYear: 2011 };
    const litFields = (l: Json | null): Json => l ? { ...l, literacyNote: undefined } : {};
    let body: Json;
    if (level === "village") {
      const v = g.villageByCode.get(code) ?? (code !== "0" ? g.villages.find(x => x.census === code) : undefined);
      if (!v) return err(res, 404, "unknown_place", `No village ${code} in ${g.state}`);
      const m = g.mandalByCode.get(v.mandal)!, d = g.districtByCode.get(m.district)!;
      const row = v.census !== "0" ? loadCensusUnits()?.get(`${g.state}|${v.census}`) ?? null : null;
      const acNo = g.villageAc.get(v.code);
      body = {
        level, code: v.code, censusCode: v.census, ...nameOf(v), category: v.category,
        path: [{ level: "state", name: stateName }, { level: "district", code: d.code, ...nameOf(d) }, { level: "mandal", code: m.code, ...nameOf(m) }],
        constituency: acNo ? acRef(acNo) : null,
        location: (() => { const p = villagePoints(g.state)?.get(v.code); return p ? { lon: p.lon, lat: p.lat, confidence: p.confidence, source: p.source, note: VP_NOTE } : null; })(),
        census: census(row, "village", row ? {
          population: row[7], households: row[6], males: row[8], females: row[9], scPop: row[10], stPop: row[11],
          scPct: pct(row[10], row[7]), stPct: pct(row[11], row[7]), sexRatio: row[8] ? Math.round((row[9] / row[8]) * 1000) : null,
          ...litFields(literacyOf(row[12], row[13], row[7])),
        } : {}),
        censusNote,
      };
    } else if (level === "mandal") {
      const m = g.mandalByCode.get(code);
      if (!m) return err(res, 404, "unknown_place", `No mandal ${code} in ${g.state}`);
      const d = g.districtByCode.get(m.district)!;
      const row = loadCensusSubs()?.get(`${g.state}|${d.census}|${m.census.padStart(5, "0")}`) ?? null;
      const acs = g.mandalAcs.get(m.code) ?? [];
      body = {
        level, code: m.code, censusCode: m.census, ...nameOf(m),
        path: [{ level: "state", name: stateName }, { level: "district", code: d.code, ...nameOf(d) }],
        villages: g.villagesByMandal.get(m.code)?.length ?? 0,
        constituencies: acs.map(acRef),
        census: census(row, "sub-district", row ? {
          population: row.population, households: row.households, males: row.males, females: row.females, scPop: row.scPop, stPop: row.stPop,
          scPct: row.scPct, stPct: row.stPct, sexRatio: row.sexRatio,
          ...litFields(literacyOf(row.literate, row.pop0to6, row.population, row.literacyPct)),
        } : {}),
        censusNote,
      };
    } else {
      const d = g.districtByCode.get(code);
      if (!d) return err(res, 404, "unknown_place", `No district ${code} in ${g.state}`);
      const row = (data.census ?? []).find(c => c.state === g.state && String((c as Json).districtCode ?? "") === d.census) ?? null;
      const acs = g.acs.filter(a => a.district === d.code);
      body = {
        level, code: d.code, censusCode: d.census, ...nameOf(d), path: [{ level: "state", name: stateName }],
        mandals: g.mandalsByDistrict.get(d.code)?.length ?? 0,
        constituencies: acs.map(a => acRef(a.acNo)),
        census: census(row as Json, "district", row ? {
          population: row.population, males: row.males, females: row.females, scPop: row.scPop, stPop: row.stPop,
          scPct: row.scPct, stPct: row.stPct, sexRatio: row.sexRatio, households: row.households,
        } : {}),
        censusNote,
      };
      if (body.census.available) { body.census.literacyPct = (row as Json).literacyPct ?? null; if (body.census.literacyPct != null) { delete body.census.literacyNote; body.census.literate = (row as Json).literate; body.census.pop0to6 = (row as Json).pop0to6; body.census.source = LIT_SOURCE; } }
    }
    pubCache(res);
    res.json({ state: g.state, ...body, asOf: g.asOf, source: sourceOf("geo-lgd-" + g.state, "census-villages-towns", "census-subdistricts", "geo-ac-units") });
  });

  /* ---------- electors by AC (GE-2024 rolls, ECI statistical report table 15) ---------- */
  let electorRows: Json[] | null | undefined;
  const loadElectors = () => { if (electorRows === undefined) electorRows = (readJson(path.join(baseDir, "data", "generated", "electors-ac.json"))?.rows as Json[]) ?? null; return electorRows; };
  const ELECTORS_NOTE = "Electors on the rolls used for the 2024 general election (ECI GE-2024 statistical report, table 15). This is not the SSR 2025 roll. Counts only. Votes polled on EVM exclude postal ballots. Licence terms for this ECI report are pending a human decision.";
  const electorsView = (r: Json) => {
    const male = r.generalMale + r.nriMale + r.serviceMale, female = r.generalFemale + r.nriFemale + r.serviceFemale, third = r.generalThirdGender + r.nriThirdGender;
    return { acNo: r.acNo, acName: r.acName, pcName: r.pcName, general: r.generalTotal, nri: r.nriTotal, service: r.serviceTotal, male, female, thirdGender: third, total: r.totalElectors, votesPolledEvm: r.votesPolledEvm, rollYear: 2024, rollBasis: "2024 general election rolls (not SSR 2025)" };
  };
  router.get("/electors/:state", (req, res) => {
    const state = String(req.params.state).toUpperCase();
    if (!isStateCode(state)) return err(res, 404, "unknown_state", "Unknown state. Valid: AP, TG");
    const rows = loadElectors();
    pubCache(res, 3600);
    if (!rows) return res.json({ state, available: false, total: 0, items: [], note: ELECTORS_NOTE, source: null });
    const items = rows.filter(r => r.state === state).map(electorsView).sort((a, b) => a.acNo - b.acNo);
    res.json({ state, available: true, rollYear: 2024, total: items.length, totalElectors: items.reduce((s, r) => s + r.total, 0), items, note: ELECTORS_NOTE, source: sourceOf("electors-ac") });
  });

  /* ---------- constituency profile ---------- */
  let rowIndex: { rows: CandidateResult[]; len: number; map: Map<string, CandidateResult[]> } | null = null;
  const rowsFor = (state: StateCode, type: string, acNo: number): CandidateResult[] => {
    if (!rowIndex || rowIndex.rows !== data.elections || rowIndex.len !== data.elections.length) {
      const map = new Map<string, CandidateResult[]>();
      for (const r of data.elections) { const k = `${r.state}|${r.type}|${r.acNo}`; (map.get(k) ?? map.set(k, []).get(k)!).push(r); }
      rowIndex = { rows: data.elections, len: data.elections.length, map };
    }
    return rowIndex.map.get(`${state}|${type}|${acNo}`) ?? [];
  };

  function historyOf(rows: CandidateResult[], topN: number) {
    const byYear = new Map<number, CandidateResult[]>();
    for (const r of rows) (byYear.get(r.year) ?? byYear.set(r.year, []).get(r.year)!).push(r);
    return [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, list]) => {
      const seat = seatResults(list)[0];
      const sorted = [...list].sort((a, b) => (b.votes || 0) - (a.votes || 0) || (a.position || 99) - (b.position || 99));
      const polled = list.reduce((s, c) => s + (c.votes || 0), 0);
      const electors = seat.electors;
      return {
        year, name: seat.acName, winner: seat.winner, winnerParty: seat.winnerParty, runnerUpParty: seat.runnerUpParty,
        margin: seat.margin, marginPct: Math.round(seat.marginPct * 100) / 100, validVotes: seat.validVotes,
        ...(electors ? { electors, turnoutPct: Math.round((polled / electors) * 1000) / 10 } : {}),
        ...(seat.uncontested ? { uncontested: true } : {}), ...(seat.tie ? { tie: true } : {}),
        candidateCount: list.length,
        candidates: sorted.slice(0, topN).map(c => ({ name: c.candidate, party: c.party, votes: c.votes, position: c.position })),
        provenance: list[0].provenance ?? null,
      };
    });
  }

  router.get("/constituencies/:state/:acNo", (req, res) => {
    const state = String(req.params.state).toUpperCase();
    if (!isStateCode(state)) return err(res, 404, "unknown_state", "Unknown state. Valid: AP, TG");
    if (!/^\d{1,3}$/.test(req.params.acNo)) return err(res, 400, "invalid_acno", "acNo must be a number");
    const acNo = Number(req.params.acNo);
    const g = geoFor(state);
    const ac = g?.acByNo.get(acNo);
    const history = historyOf(rowsFor(state, "assembly", acNo), 5);
    if (!ac && !history.length) return err(res, 404, "unknown_constituency", `No constituency ${acNo} in ${state}`);
    const district = ac?.district ? g!.districtByCode.get(ac.district) : undefined;
    const distRow = readPre2014(state, acNo);
    const pcNo = ac?.pcNo ?? null;
    const pcInfo = pcNo != null ? g?.pcs.get(pcNo) : undefined;
    const pcHistory = pcNo != null ? historyOf(rowsFor(state, "ls", pcNo), 3) : [];
    const segs = pcNo != null ? (loadSegments(baseDir)?.pcs[state]?.[String(pcNo)] ?? []) : [];
    const censusAgg = (() => {
      const cu = ac ? loadCensusUnits() : null;
      if (!ac || !cu) return null;
      let pop = 0, sc = 0, st = 0, hit = 0;
      for (const vc of ac.villages) {
        const v = g!.villageByCode.get(String(vc));
        const row = v ? cu.get(`${state}|${v.census}`) : undefined;
        if (row) { hit++; pop += row[7]; sc += row[10]; st += row[11]; }
      }
      return hit ? { basis: "sum of Census 2011 village rows linked to this constituency (rural villages only; towns and urban wards are not included)", villagesWithCensus: hit, villagesTotal: ac.villages.length, population: pop, scPop: sc, stPop: st, scPct: pct(sc, pop), stPct: pct(st, pop) } : null;
    })();
    const latest = history[history.length - 1];
    pubCache(res);
    res.json({
      state, acNo, nameEn: ac?.en ?? latest?.name ?? null, ...(ac?.te ? { nameTe: ac.te } : {}),
      lgdCode: ac?.lgd ?? null, reservation: ac?.reservation ?? null,
      district: district ? { code: district.code, ...nameOf(district), share: ac!.districtShare, href: hrefOf(state, "district", district.code) } : null,
      districtPre2014: distRow,
      pc: pcNo != null ? { pcNo, nameEn: pcInfo?.en ?? pcHistory[pcHistory.length - 1]?.name ?? null, ...(pcInfo?.te ? { nameTe: pcInfo.te } : {}), reservation: pcInfo?.reservation ?? null, segments: segs, history: pcHistory } : null,
      units: ac ? { mandals: ac.counts.mandals ?? ac.mandals.length, villages: ac.counts.villages ?? ac.villages.length, wards: ac.counts.wards ?? 0, urbanBodies: ac.counts.urbanBodies ?? 0 } : null,
      mandals: ac ? ac.mandals.map(String).map(c => g!.mandalByCode.get(c)).filter(Boolean).map(m => ({ code: m!.code, ...nameOf(m!), href: hrefOf(state, "mandal", m!.code) })) : [],
      electors: latest?.electors ?? null, electorsYear: latest?.electors ? latest.year : null,
      census: censusAgg,
      electorsRoll: (() => { const r = loadElectors()?.find(x => x.state === state && x.acNo === acNo); return r ? { ...electorsView(r), note: ELECTORS_NOTE } : null; })(),
      history,
      links: { boundary: `/api/v1/geo/${state}/ac.geojson`, pcBoundary: `/api/v1/geo/${state}/pc.geojson`, page: hrefOf(state, "ac", acNo) },
      delimitation: "2008 (in force for all AP/TG elections 2014-2024)",
      asOf: g?.asOf ?? null, demo: data.demo,
      source: sourceOf("elections", "geo-ac-units", "geo-ac-link", "geo-names-te"),
    });
  });

  function readPre2014(state: StateCode, acNo: number): string | null {
    const xw = (readJson(path.join(geoDir, "district-crosswalk.json")) as Json)?.ac?.[state]?.[String(acNo)];
    return Array.isArray(xw) && typeof xw[0] === "string" ? xw[0] : null;
  }

  /* ---------- split voting (S-95) ---------- */
  let segCache: SegmentsFile | null | undefined;
  router.get("/elections/:state/split-voting", (req, res) => {
    const state = String(req.params.state).toUpperCase();
    if (!isStateCode(state)) return err(res, 404, "unknown_state", "Unknown state. Valid: AP, TG");
    const ys = first(req.query.year);
    if (ys !== undefined && !/^\d{4}$/.test(ys)) return err(res, 400, "invalid_year", "year must be a 4-digit year");
    const asmYears = [...new Set(data.elections.filter(r => r.state === state && r.type === "assembly").map(r => r.year))].sort((a, b) => a - b);
    const year = ys ? Number(ys) : asmYears[asmYears.length - 1];
    if (!year || !asmYears.includes(year)) return err(res, 404, "no_data", `No assembly election data for ${state}${ys ? ` in ${ys}` : ""}`);
    const lsq = first(req.query.lsYear);
    if (lsq !== undefined && !/^\d{4}$/.test(lsq)) return err(res, 400, "invalid_year", "lsYear must be a 4-digit year");
    segCache ??= loadSegments(baseDir) ?? null;
    if (!segCache) return err(res, 404, "no_data", "Lok Sabha segment mapping is not available");
    const report = splitVotingReport(data.elections, state, year, segCache.segments[state], lsq ? Number(lsq) : undefined);
    if (!report) return err(res, 404, "no_ls_pair", `No Lok Sabha election within 2 years of the ${year} assembly election in ${state}`);
    pubCache(res);
    res.json({
      demo: data.demo, ...report,
      segmentsSource: { delimitation: segCache.delimitation, asOf: segCache.asOf, note: segCache.note },
      source: sourceOf("elections", "lsmap-segments"),
    });
  });

  return router;
}
