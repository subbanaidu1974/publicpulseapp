import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { ALLIANCES, STATES, allianceGroups, alliancesAsOf, isElectionType, isStateCode } from "../src/lib/states";
import type { ElectionType, StateCode } from "../src/lib/states";
import {
  aggregateAlliances, filterElection, marginBuckets, marginalSeats, seatResults, seatTally, swing, voteShare,
} from "../src/lib/elections";
import type { CandidateResult } from "../src/lib/elections";
import { blackoutResponse, computeForecast } from "../src/lib/forecast";
import type { ForecastResponse } from "../src/lib/forecast";
import { normalizeTcpd } from "../pipeline/normalize";
import { normalizeCensus } from "../pipeline/census";
import { loadGeoLookup } from "../pipeline/geo/lookup";
import type { GeoLookup } from "../pipeline/geo/lookup";
import type { CensusDistrict } from "../pipeline/census";
import crypto from "crypto";
import { requireRole } from "./civic/core";
import { createPeopleRouter } from "./people-api";
import { datasetForPath, loadManifestIndex } from "./manifest";
import type { ManifestIndex } from "./manifest";
import { comparabilityNotes } from "../src/lib/comparability";
import { forecastDecision, loadCalendar, notificationsAllowed, surveysAllowed, windowState } from "./window";
import { createGeoApiRouter } from "./geo-api";
import { createRefreshRouter } from "./refresh";
import { createCountdayRouter } from "./countday/router";
import { createAnalyticsRouter } from "./analytics-api";

export interface DatasetStatus {
  name: string;
  rows: number;
  provenance: string;
  generatedAt: string | null;
}

export interface Datasets {
  elections: CandidateResult[];
  census: CensusDistrict[];
  /** true when demo fixtures (not real generated data) are being served */
  demo: boolean;
  status: DatasetStatus[];
  /** seat enrichment (district, Telugu name) from data/generated/geo; absent for demo data */
  geo?: GeoLookup;
  /** data/generated/manifest.json index; feeds `source` and `asOf` in response envelopes */
  manifest?: ManifestIndex | null;
}

const root = () => process.cwd();

function readJson(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[api] could not read ${file}:`, (err as Error).message);
    return null;
  }
}

/** Accepts either a bare array or an envelope `{ rows|data, generatedAt, provenance }`. */
function unwrap<T>(raw: unknown): { rows: T[]; generatedAt: string | null; provenance: string | null } | null {
  if (Array.isArray(raw)) return { rows: raw as T[], generatedAt: null, provenance: null };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const rows = (["results", "districts", "rows", "data"].map(k => o[k]).find(Array.isArray) ?? null) as T[] | null;
    if (rows) {
      return {
        rows,
        generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : null,
        provenance: typeof o.provenance === "string" ? o.provenance : null,
      };
    }
  }
  return null;
}

function readText(file: string): string | null {
  try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null; } catch { return null; }
}

function mtime(file: string): string | null {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

/** Load generated data; fall back to demo fixtures per dataset. Never throws. */
export function loadDatasets(baseDir: string = root()): Datasets {
  const genDir = path.join(baseDir, "data", "generated");
  const fixDir = path.join(baseDir, "pipeline", "fixtures");
  const status: DatasetStatus[] = [];
  let demo = false;

  let elections: CandidateResult[] = [];
  const genEl = unwrap<CandidateResult>(readJson(path.join(genDir, "elections.json")));
  if (genEl && genEl.rows.length) {
    elections = genEl.rows;
    if (genEl.provenance === "demo") demo = true;
    status.push({
      name: "elections", rows: elections.length,
      provenance: genEl.provenance ?? (elections.some(r => r.provenance) ? [...new Set(elections.map(r => r.provenance))].join("+") : "unknown"),
      generatedAt: genEl.generatedAt ?? mtime(path.join(genDir, "elections.json")),
    });
  } else {
    demo = true;
    for (const [file, type] of [["assembly.demo.csv", "assembly"], ["ls.demo.csv", "ls"]] as const) {
      const csv = readText(path.join(fixDir, file)) ?? (type === "assembly" ? readText(path.join(fixDir, "elections.demo.csv")) : null);
      if (csv) elections.push(...normalizeTcpd(csv, type, "demo"));
    }
    if (!elections.length) {
      // any *.demo.csv that holds election data
      try {
        for (const f of fs.readdirSync(fixDir).filter(n => n.endsWith(".demo.csv") && !/census/i.test(n))) {
          const csv = readText(path.join(fixDir, f));
          if (csv) elections.push(...normalizeTcpd(csv, /(^|[-_.])ls([-_.]|$)|lok/i.test(f) ? "ls" : "assembly", "demo"));
        }
      } catch { /* no fixtures dir */ }
    }
    status.push({ name: "elections", rows: elections.length, provenance: "demo", generatedAt: null });
  }

  let census: CensusDistrict[] = [];
  const genCe = unwrap<CensusDistrict>(readJson(path.join(genDir, "census.json")));
  if (genCe && genCe.rows.length) {
    census = genCe.rows;
    if (genCe.provenance === "demo") demo = true;
    status.push({
      name: "census", rows: census.length, provenance: genCe.provenance ?? "Census 2011",
      generatedAt: genCe.generatedAt ?? mtime(path.join(genDir, "census.json")),
    });
  } else {
    demo = true;
    try {
      for (const f of fs.readdirSync(fixDir).filter(n => /census.*\.demo\.csv$/i.test(n))) {
        const csv = readText(path.join(fixDir, f));
        if (csv) census.push(...normalizeCensus(csv, "demo"));
      }
    } catch { /* no fixtures dir */ }
    status.push({ name: "census", rows: census.length, provenance: "demo", generatedAt: null });
  }

  const realElections = !!genEl && genEl.rows.length > 0 && genEl.provenance !== "demo";
  return { elections, census, demo, status, geo: realElections ? loadGeoLookup(baseDir) : undefined, manifest: loadManifestIndex(baseDir) };
}

/* ---------------- helpers ---------------- */

class ApiError extends Error {
  constructor(public status: number, message: string, public code: string = status === 404 ? "not_found" : status === 400 ? "bad_request" : "error") { super(message); }
}
const bad = (m: string, code?: string) => new ApiError(400, m, code);
const notFound = (m: string, code?: string) => new ApiError(404, m, code);

function qstr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function parseState(v: unknown, required = true): StateCode | undefined {
  const s = qstr(v);
  if (!s) { if (required) throw bad("Missing required parameter: state", "missing_state"); return undefined; }
  const up = s.toUpperCase();
  if (!isStateCode(up)) throw notFound(`Unknown state '${s.slice(0, 20)}'. Valid: AP, TG`, "unknown_state");
  return up;
}

function parseYear(v: unknown, name = "year"): number | undefined {
  const s = qstr(v);
  if (!s) return undefined;
  if (!/^\d{4}$/.test(s)) throw bad(`Invalid ${name} '${s.slice(0, 20)}': expected a 4-digit year`, "invalid_year");
  const n = Number(s);
  if (n < 1950 || n > 2100) throw bad(`Invalid ${name} '${s}': out of range`, "invalid_year");
  return n;
}

function parseType(v: unknown, dflt?: ElectionType): ElectionType | undefined {
  const s = qstr(v);
  if (!s) return dflt;
  const lo = s.toLowerCase();
  if (!isElectionType(lo)) throw bad(`Invalid type '${s.slice(0, 20)}'. Valid: assembly, ls`, "invalid_type");
  return lo;
}

function latestYear(rows: CandidateResult[], state: StateCode, type: ElectionType): number | undefined {
  const ys = rows.filter(r => r.state === state && r.type === type).map(r => r.year);
  return ys.length ? Math.max(...ys) : undefined;
}

function getElection(rows: CandidateResult[], state: StateCode, year: number | undefined, type: ElectionType) {
  const y = year ?? latestYear(rows, state, type);
  if (y === undefined) throw notFound(`No ${type} election data for ${state}`, "no_data");
  const el = filterElection(rows, state, y, type);
  if (!el.length) throw notFound(`No ${type} election data for ${state} in ${y}`, "no_data");
  return { year: y, rows: el };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const roundMap = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, r2(v)]));

/* ---------------- router ---------------- */

export function createApiRouter(data: Datasets, opts: { baseDir?: string } = {}): Router {
  const router = express.Router();
  const demo = data.demo;

  // Envelope: attach `source` (dataset, provenance, URLs, licences, attribution) and `asOf` from the dataset manifest.
  router.use((req, res, next) => {
    const id = datasetForPath(req.path);
    const info = id ? data.manifest?.[id] : undefined;
    if (!info) return next();
    const json = res.json.bind(res);
    res.json = (body?: unknown) => {
      if (body && typeof body === "object" && !Array.isArray(body) && res.statusCode < 400) {
        const o = body as Record<string, unknown>;
        return json({ ...o, source: o.source ?? info, asOf: o.asOf ?? info.asOf });
      }
      return json(body);
    };
    next();
  });

  // Turnout/NOTA, assembly-vs-LS comparison, by-elections, pre-bifurcation history, cited party changes (S-112/115/116/117/120). Mounted first so pre-2014 years are served before the main /elections handlers.
  router.use(createAnalyticsRouter(data, opts));

  router.get("/health", (_req, res) => {
    res.json({ ok: true, demo });
  });

  router.get("/data-status", (_req, res) => {
    res.json({ demo, datasets: data.status });
  });

  router.get("/states", (_req, res) => {
    const states = Object.values(STATES).map(s => {
      const seen = new Map<string, { year: number; type: ElectionType }>();
      for (const r of data.elections) if (r.state === s.code) seen.set(`${r.year}|${r.type}`, { year: r.year, type: r.type });
      const elections = [...seen.values()].sort((a, b) => a.year - b.year || a.type.localeCompare(b.type));
      return { ...s, elections };
    });
    res.json({ demo, states });
  });

  router.get("/elections", (req, res) => {
    const state = parseState(req.query.state)!;
    const type = parseType(req.query.type, "assembly")!;
    const { year, rows } = getElection(data.elections, state, parseYear(req.query.year), type);
    const seats = seatResults(rows, data.geo ? n => data.geo!(state, type, n) : undefined);
    res.json({
      demo, state, year, type, count: seats.length,
      expectedSeats: type === "assembly" ? STATES[state].assemblySeats : STATES[state].lsSeats,
      seats, tally: seatTally(seats),
    });
  });

  router.get("/elections/:state/summary", (req, res) => {
    const state = parseState(req.params.state)!;
    const type = parseType(req.query.type, "assembly")!;
    const { year, rows } = getElection(data.elections, state, parseYear(req.query.year), type);
    const seats = seatResults(rows);
    const tally = seatTally(seats);
    const alliances = ALLIANCES[`${state}-${year}-${type}`];
    res.json({
      demo, state, year, type,
      totalSeats: seats.length,
      tally,
      voteShare: roundMap(voteShare(rows)),
      marginBuckets: marginBuckets(seats),
      alliances: alliances ? { definition: alliances, tally: aggregateAlliances(tally, alliances), groups: allianceGroups(state, year, type), asOf: alliancesAsOf } : null,
    });
  });

  router.get("/elections/:state/swing", (req, res) => {
    const state = parseState(req.params.state)!;
    const type = parseType(req.query.type, "assembly")!;
    const from = parseYear(req.query.from, "from");
    const to = parseYear(req.query.to, "to");
    if (from === undefined || to === undefined) throw bad("Both 'from' and 'to' years are required", "missing_range");
    if (from === to) throw bad("'from' and 'to' must differ", "invalid_range");
    const a = getElection(data.elections, state, from, type);
    const b = getElection(data.elections, state, to, type);
    res.json({ demo, state, type, from, to, unit: "percentage points", swing: roundMap(swing(a.rows, b.rows)), notes: comparabilityNotes(state, from, to, type) });
  });

  router.get("/elections/:state/marginal", (req, res) => {
    const state = parseState(req.params.state)!;
    const type = parseType(req.query.type, "assembly")!;
    const raw = qstr(req.query.threshold) ?? "5";
    const threshold = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(threshold) || threshold > 100) {
      throw bad(`Invalid threshold '${raw.slice(0, 20)}': expected a number between 0 and 100`, "invalid_threshold");
    }
    const { year, rows } = getElection(data.elections, state, parseYear(req.query.year), type);
    const seats = marginalSeats(seatResults(rows), threshold);
    res.json({ demo, state, year, type, thresholdPct: threshold, count: seats.length, seats });
  });

  router.get("/census/:state/districts", (req, res) => {
    const state = parseState(req.params.state)!;
    const districts = data.census.filter(d => d.state === state);
    if (!districts.length) throw notFound(`No census data for ${state}`, "no_data");
    res.json({ demo, state, censusYear: districts[0].censusYear ?? 2011, count: districts.length, districts });
  });

  /* Election window (S-118): calendar-driven, fail closed. */
  router.get("/election-window", (req, res) => {
    const state = parseState(req.query.state)!;
    const now = new Date();
    const cal = loadCalendar();
    const fc = forecastDecision(state, now, { calendar: cal });
    res.set("Cache-Control", "no-store");
    res.json({
      state, asOf: now.toISOString(), window: windowState(state, now, { calendar: cal }),
      forecast: { show: fc.show, reason: fc.reason },
      surveysAllowed: surveysAllowed(state, now, { calendar: cal }),
      notificationsAllowed: notificationsAllowed(state, now, { calendar: cal }),
      calendar: cal ? { loaded: true, coveredFrom: cal.coveredFrom, coveredThrough: cal.coveredThrough, verifiedEntries: cal.entries.filter(e => e.verified === true && e.example !== true).length } : { loaded: false },
      flagSource: process.env.FORECAST_BLACKOUT === "1" || process.env.FORECAST_BLACKOUT === "0" ? "env:FORECAST_BLACKOUT" : "calendar",
    });
  });

  /* Forecast cache is keyed to the elections snapshot (size + mtime of data/generated/elections.json). When the file
     changes the datasets are reloaded and the cache is dropped, so a regenerated dataset never serves a stale forecast. */
  const baseDir = opts.baseDir ?? root();
  const elFile = path.join(baseDir, "data", "generated", "elections.json");
  const manFile = path.join(baseDir, "data", "generated", "manifest.json");
  const statSig = (f: string) => { try { const st = fs.statSync(f); return `${st.size}-${Math.round(st.mtimeMs)}`; } catch { return "none"; } };
  // S-76: the snapshot signature covers the elections file and the dataset manifest (a refresh swaps both).
  const sigOf = () => { const e = statSig(elFile), m = statSig(manFile); return m === "none" ? e : `${e}+${m}`; };
  let snapSig = sigOf();
  let snapChecksum: string | null = null;
  const checksumOf = () => { try { return crypto.createHash("sha256").update(fs.readFileSync(elFile)).digest("hex").slice(0, 16); } catch { return null; } };
  const forecastCache = new Map<string, ForecastResponse>();
  const syncSnapshot = () => {
    const sig = sigOf();
    if (sig === snapSig) return;
    snapSig = sig; snapChecksum = null;
    forecastCache.clear();
    const fresh = loadDatasets(baseDir);
    data.elections = fresh.elections; data.census = fresh.census; data.demo = fresh.demo; data.status = fresh.status;
  };
  router.get("/elections/:state/forecast", (req, res) => {
    const state = parseState(req.params.state)!;
    // Fail closed: blackout, or an unknown election window, withholds seats, alliances and back-test.
    const decision = forecastDecision(state);
    if (!decision.show) {
      res.set("Cache-Control", "no-store");
      const notice = decision.reason === "count-day" ? { notice: { en: "Counting is under way. No forecast or projection is shown during the count.", te: "లెక్కింపు జరుగుతోంది. లెక్కింపు సమయంలో ఎలాంటి అంచనా చూపబడదు." } } : {};
      return res.json({ ...blackoutResponse(state), window: decision.state, withheldReason: decision.reason, ...notice });
    }
    syncSnapshot();
    let f = forecastCache.get(state);
    if (!f) {
      const computed = computeForecast(data.elections, state);
      if (!computed) throw notFound(`No assembly election data for ${state}`, "no_data");
      f = computed;
      forecastCache.set(state, f);
    }
    snapChecksum ??= checksumOf();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ ...f, window: decision.state, dataSnapshot: { checksum: snapChecksum, signature: snapSig } });
  });

  /* Admin-only data status (S-47 tail): the civic bearer session must hold the admin role. */
  router.get("/data-status/admin", requireRole("admin"), (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ demo: data.demo, datasets: data.status, snapshot: { signature: snapSig } });
  });

  // Geography, constituency profiles and split voting (S-95, S-98..S-100)
  router.use(createGeoApiRouter(data, { baseDir }));
  // Data freshness per dataset (S-76)
  router.use(createRefreshRouter({ baseDir }));

  // Count-day signed snapshots (S-41)
  router.use("/countday", createCountdayRouter({ dir: process.env.COUNTDAY_DIR || path.join(baseDir, "data", "generated", "countday") }));

  // People pages: parties, office holders, members, contestants, correction/takedown channel (S-104..S-114)
  router.use(createPeopleRouter({ elections: data.elections }, opts));

  // Unknown /api/v1 routes -> JSON 404
  router.use((req, _res, next) => next(notFound(`Not found: ${req.method} ${req.path.slice(0, 80)}`, "route_not_found")));

  // Catch-all error handler: JSON only, never a stack trace
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, code: err.code });
    const status = (err as { status?: number })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return res.status(status).json({ error: "Bad request", code: "bad_request" });
    }
    console.error("[api] unexpected error:", (err as Error)?.message);
    return res.status(500).json({ error: "Internal server error", code: "internal" });
  });

  return router;
}
