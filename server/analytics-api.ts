/**
 * Analytics and history API (S-112, S-115, S-116, S-117, S-120), mounted under /api/v1 by server/api.ts.
 *   GET /elections/:state/turnout?year=&type=      turnout, NOTA, candidate-sex summary per seat / district / state
 *   GET /analytics/compare/:state?year=            assembly vs Lok Sabha party shares, per-PC comparison, incumbency
 *   GET /analytics/candidates/:state?type=&q=      same-seat cross-election candidate trails with match confidence
 *   GET /history/:state                            elections available including pre-bifurcation (undivided AP) years
 *   GET /byelections?state=&type=&acNo=            by-election and re-poll records
 *   GET /party-switches?state=&name=               cited party-change records (hidden in the MCC blackout)
 *   GET /elections, /elections/:state/summary      only for pre-bifurcation years (otherwise falls through to the main handlers)
 * Pre-bifurcation rows live in data/generated/history/prebifurcation.json and are never mixed into the main election dataset,
 * so forecasts, swing and golden numbers are unaffected.
 */
import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { CandidateResult } from "../src/lib/elections";
import { filterElection, seatResults, seatTally, voteShare } from "../src/lib/elections";
import { STATES, isElectionType, isStateCode } from "../src/lib/states";
import type { ElectionType, StateCode } from "../src/lib/states";
import { candidateTrails, constituencyCompare, incumbencySummary, partyShareCompare, TRAIL_NOTE } from "../src/lib/comparison";
import { turnoutReport } from "../src/lib/turnout";
import { partyHistory } from "../src/lib/partyHistory";
import { panchayatResponse, validatePanchayatFile } from "../src/lib/panchayat";
import type { PanchayatFile } from "../src/lib/panchayat";
import { buildDirectory, joinUnits, rollup, trends as panchayatTrends } from "../src/lib/panchayatUnits";
import type { Directory, LgdFile } from "../src/lib/panchayatUnits";
import { comparabilityNotes } from "../src/lib/comparability";
import type { Datasets } from "./api";
import { peopleBlackout } from "./people-api";

const bad = (res: express.Response, status: number, error: string, code: string) => res.status(status).json({ error, code });
const qs = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const r2 = (n: number) => Math.round(n * 100) / 100;

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
}

export interface PartySwitchRecord {
  id: string; person: string; state: StateCode; constituency: { type: ElectionType; acNo: number; name: string };
  from: string; to: string; date: string; status: "reported" | "confirmed"; sources: { publisher: string; url: string }[]; verified: boolean; note?: string;
}

/** Violations of the party-switch policy (used by the build checks and tests). Empty = pass. */
export function validatePartySwitches(records: PartySwitchRecord[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) errs.push(`duplicate id ${r.id}`);
    ids.add(r.id);
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(r.date ?? "")) errs.push(`${r.id}: date missing or malformed`);
    if (r.status !== "reported" && r.status !== "confirmed") errs.push(`${r.id}: status must be reported or confirmed`);
    if (!r.person || !r.from || !r.to || r.from === r.to) errs.push(`${r.id}: person/from/to incomplete`);
    const hosts = new Set<string>();
    for (const s of r.sources ?? []) {
      try { const u = new URL(s.url); if (u.protocol === "https:") hosts.add(u.hostname.replace(/^(www|m|amp)\./, "")); } catch { /* invalid */ }
    }
    if (hosts.size < 2) errs.push(`${r.id}: needs sources from at least two different sites (has ${hosts.size})`);
    if (r.verified !== true) errs.push(`${r.id}: only verified entries may ship`);
    if (/turncoat|defector|traitor/i.test(`${r.note ?? ""} ${r.person}`)) errs.push(`${r.id}: judgemental wording`);
  }
  return errs;
}

export function createAnalyticsRouter(data: Datasets, opts: { baseDir?: string } = {}): Router {
  const router = express.Router();
  const baseDir = opts.baseDir ?? process.cwd();
  const hist = readJson<{ results?: CandidateResult[]; note?: string }>(path.join(baseDir, "data/generated/history/prebifurcation.json"), {});
  const histRows: CandidateResult[] = hist.results ?? [];
  const byel = readJson<{ records?: Record<string, unknown>[]; note?: string; asOf?: string }>(path.join(baseDir, "data/reference/history/byelections.json"), {});
  const switches = readJson<{ records?: PartySwitchRecord[]; policy?: string; asOf?: string }>(path.join(baseDir, "data/reference/history/party-switches.json"), {});
  const segments = readJson<{ segments?: Record<string, Record<string, number>> }>(path.join(baseDir, "data/generated/lsmap/segments.json"), {});

  let cacheKey: CandidateResult[] | null = null;
  let cached: CandidateResult[] = [];
  /** main dataset plus pre-bifurcation rows; recomputed when the main dataset is reloaded */
  const all = () => {
    if (cacheKey !== data.elections) { cacheKey = data.elections; cached = [...data.elections, ...histRows]; }
    return cached;
  };
  const isHist = (state: StateCode, year: number, type: ElectionType) => histRows.some(r => r.state === state && r.year === year && r.type === type)
    && !data.elections.some(r => r.state === state && r.year === year && r.type === type);
  const source = (state: StateCode, year: number, type: ElectionType) => (isHist(state, year, type) ? data.manifest?.["history-prebifurcation"] : data.manifest?.elections) ?? null;

  const state_ = (v: unknown): StateCode | null => { const s = String(v ?? "").toUpperCase(); return isStateCode(s) ? s : null; };
  const geoFn = (state: StateCode, type: ElectionType) => (data.geo ? (n: number) => data.geo!(state, type, n) : undefined);
  const yearsFor = (state: StateCode, type: ElectionType) => [...new Set(all().filter(r => r.state === state && r.type === type).map(r => r.year))].sort((a, b) => b - a);

  /* ---- pre-bifurcation years in the existing /elections endpoints ---- */
  router.get("/elections", (req, res, next) => {
    const state = state_(req.query.state), type = (qs(req.query.type) ?? "assembly").toLowerCase();
    const year = Number(qs(req.query.year));
    if (!state || !isElectionType(type) || !Number.isInteger(year) || !isHist(state, year, type)) return next();
    const seats = seatResults(filterElection(histRows, state, year, type), geoFn(state, type));
    res.json({
      demo: false, state, year, type, count: seats.length, comparability: "pre-bifurcation",
      expectedSeats: type === "assembly" ? STATES[state].assemblySeats : STATES[state].lsSeats, seats, tally: seatTally(seats), source: source(state, year, type),
    });
  });
  router.get("/elections/:state/summary", (req, res, next) => {
    const state = state_(req.params.state), type = (qs(req.query.type) ?? "assembly").toLowerCase();
    const year = Number(qs(req.query.year));
    if (!state || !isElectionType(type) || !Number.isInteger(year) || !isHist(state, year, type)) return next();
    const rows = filterElection(histRows, state, year, type);
    const seats = seatResults(rows);
    const vs = voteShare(rows);
    res.json({
      demo: false, state, year, type, comparability: "pre-bifurcation", totalSeats: seats.length, tally: seatTally(seats),
      voteShare: Object.fromEntries(Object.entries(vs).map(([k, v]) => [k, r2(v)])), marginBuckets: { "<2%": 0, "2-5%": 0, "5-10%": 0, ">10%": 0, ...bucket(seats) },
      alliances: null, source: source(state, year, type),
    });
  });
  function bucket(seats: { marginPct: number }[]) {
    const o: Record<string, number> = { "<2%": 0, "2-5%": 0, "5-10%": 0, ">10%": 0 };
    for (const s of seats) o[s.marginPct < 2 ? "<2%" : s.marginPct < 5 ? "2-5%" : s.marginPct < 10 ? "5-10%" : ">10%"]++;
    return o;
  }

  /* ---- S-120 turnout / NOTA ---- */
  router.get("/elections/:state/turnout", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const type = (qs(req.query.type) ?? "assembly").toLowerCase();
    if (!isElectionType(type)) return bad(res, 400, "Invalid type. Valid: assembly, ls", "invalid_type");
    const ys = yearsFor(state, type);
    const yq = qs(req.query.year);
    if (yq && !/^\d{4}$/.test(yq)) return bad(res, 400, "Invalid year: expected a 4-digit year", "invalid_year");
    const year = yq ? Number(yq) : ys[0];
    if (year === undefined || !ys.includes(year)) return bad(res, 404, `No ${type} election data for ${state}${yq ? ` in ${yq}` : ""}`, "no_data");
    const rows = filterElection(all(), state, year, type);
    res.set("Cache-Control", "public, max-age=300");
    res.json({ demo: data.demo, ...turnoutReport(rows, state, year, type, geoFn(state, type)), years: ys, source: source(state, year, type) });
  });

  /* ---- S-117 comparison and incumbency ---- */
  router.get("/analytics/compare/:state", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const both = yearsFor(state, "assembly").filter(y => yearsFor(state, "ls").includes(y));
    const yq = qs(req.query.year);
    if (yq && !/^\d{4}$/.test(yq)) return bad(res, 400, "Invalid year: expected a 4-digit year", "invalid_year");
    const year = yq ? Number(yq) : both[0];
    if (year === undefined || !both.includes(year)) return bad(res, 404, `Both assembly and Lok Sabha results are needed for ${state}${yq ? ` in ${yq}` : ""}`, "no_data");
    const a = filterElection(all(), state, year, "assembly"), l = filterElection(all(), state, year, "ls");
    const acToPc = segments.segments?.[state] ?? {};
    const notes = [
      "Lok Sabha results in the dataset are per parliamentary constituency, so the per-constituency view compares a PC's Lok Sabha share with the sum of its assembly segments, not with a segment's own Lok Sabha count.",
      "Party shares are of valid votes polled; a party that did not contest one of the elections counts as 0%. Alliances differ between assembly and Lok Sabha polls, so a gap between the two can come from an alliance arrangement as well as from voter choice.",
      ...comparabilityNotes(state, year, year, "assembly").filter(n => /boundar|delimitation|renamed/i.test(n)),
    ];
    if (year <= 2014) notes.push(`${year} elections were held ${year === 2009 ? "in undivided Andhra Pradesh and are split onto today's seats by the 2008 delimitation order" : "alongside the bifurcation: the 2014 Lok Sabha poll was fought in undivided Andhra Pradesh and is split onto today's seats"}.`);
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      demo: data.demo, state, year, years: both, parties: partyShareCompare(a, l), constituencies: constituencyCompare(a, l, acToPc),
      incumbency: { assembly: incumbencySummary(all(), state, year, "assembly"), ls: incumbencySummary(all(), state, year, "ls") },
      comparability: isHist(state, year, "ls") || isHist(state, year, "assembly") ? "pre-bifurcation" : undefined, notes,
      source: data.manifest?.elections ?? null,
    });
  });

  /* ---- S-195 parties: every party's seats, votes and vote share in each election held in the dataset ---- */
  router.get("/analytics/parties/:state", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const rows = all().filter(r => r.state === state);
    if (!rows.length) return bad(res, 404, `No election data for ${state}`, "no_data");
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      demo: data.demo, ...partyHistory(all(), state),
      notes: [
        "Seats are seats won; share is of all votes polled in that election, NOTA included. A party with no row for an election did not stand in it.",
        "Alliances differ between elections, so a party's share can move because of an alliance arrangement and not only because of voters.",
        "Elections before 2014 in the pre-bifurcation history are mapped onto today's AP and TG seats and are not like-for-like with later ones.",
      ],
      source: data.manifest?.elections ?? null,
    });
  });

  /* ---- S-203 panchayat elections: empty until an approved results file exists at data/reference/panchayat/results-<ST>.json ---- */
  router.get("/analytics/panchayat/:state", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    res.set("Cache-Control", "public, max-age=300");
    res.json(panchayatResponse(state, readJson<unknown | null>(path.join(baseDir, `data/reference/panchayat/results-${state}.json`), null)));
  });

  /* ---- S-213 to S-215 panchayat unit-level browsing and trends. Unit rows come from units-<ST>.json in data/reference/panchayat (none exists yet) or, for tests, from PANCHAYAT_UNITS_DIR. ---- */
  const unitsDir = process.env.PANCHAYAT_UNITS_DIR ? path.resolve(process.env.PANCHAYAT_UNITS_DIR) : path.join(baseDir, "data/reference/panchayat");
  const lgdCache = new Map<string, Directory | null>();
  const directory = (state: StateCode): Directory | null => {
    if (!lgdCache.has(state)) {
      const lgd = readJson<LgdFile | null>(path.join(baseDir, `data/generated/geo/lgd-${state}.json`), null);
      lgdCache.set(state, lgd && Array.isArray(lgd.gps) ? buildDirectory(lgd) : null);
    }
    return lgdCache.get(state) ?? null;
  };
  /** The unit-level file for a state, or the reasons it was not accepted. Sample (fixture) data is refused unless the test directory was set. */
  const unitFile = (state: StateCode): { file: PanchayatFile | null; problems: string[] } => {
    const raw = readJson<unknown | null>(path.join(unitsDir, `units-${state}.json`), null);
    if (raw == null) return { file: null, problems: [] };
    const problems = validatePanchayatFile(raw, state);
    const f = raw as PanchayatFile;
    if (f.fixture === true && !process.env.PANCHAYAT_UNITS_DIR) problems.push("sample data is refused outside the test directory");
    if (!problems.length && !f.elections.some((e) => e.units?.length)) problems.push("no election in this file has unit rows");
    return problems.length ? { file: null, problems } : { file: f, problems: [] };
  };
  const unitNotes = [
    "Unit rows are shown only from a file with a stated source and licence. Places are matched to the Local Government Directory by code, or by district, mandal and name when that is unique; units that cannot be matched are listed, never guessed.",
    "Places are listed by name. Nothing here ranks a village, mandal or district.",
  ];

  router.get("/analytics/panchayat/:state/units", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    res.set("Cache-Control", "no-store");
    const { file, problems } = unitFile(state);
    if (!file) return res.json({ state, loaded: false, fixture: false, elections: [], problems, notes: unitNotes });
    const withUnits = file.elections.filter((e) => e.units?.length).sort((a, b) => b.year - a.year || a.level.localeCompare(b.level));
    const id = qs(req.query.election) ?? withUnits[0].id;
    const e = withUnits.find((x) => x.id === id);
    if (!e) return bad(res, 404, "Unknown election id", "unknown_election");
    const joined = joinUnits(e.units!, e.level, directory(state), e.id);
    const district = qs(req.query.district); const mandal = qs(req.query.mandal); const q = qs(req.query.q)?.toLowerCase();
    let scope = joined.units;
    if (district) scope = scope.filter((u) => u.district === district);
    if (mandal) scope = scope.filter((u) => (u.mandal ?? "-") === mandal);
    if (q) scope = scope.filter((u) => u.name.toLowerCase().includes(q) || (u.nameTe ?? "").includes(qs(req.query.q)!) || u.district.toLowerCase().includes(q) || (u.mandal ?? "").toLowerCase().includes(q));
    const level = mandal ? "units" : district ? "mandal" : "district";
    res.json({
      state, loaded: true, fixture: file.fixture === true, source: file.source, notes: unitNotes, problems: [],
      elections: withUnits.map((x) => ({ id: x.id, level: x.level, year: x.year, period: x.period, units: x.units!.length })),
      election: { id: e.id, level: e.level, year: e.year, period: e.period, phases: e.phases ?? [], caveats: e.caveats ?? [] },
      view: q ? "search" : level, district: district ?? null, mandal: mandal ?? null, q: q ?? null,
      groups: q ? [] : level === "district" ? rollup(scope, "district") : level === "mandal" ? rollup(scope, "mandal") : [],
      units: q || level === "units" ? scope.slice(0, 200) : [], unitTotal: scope.length,
      join: joined.stats,
    });
  });

  router.get("/analytics/panchayat/:state/trends", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    res.set("Cache-Control", "no-store");
    const { file, problems } = unitFile(state);
    if (!file) return res.json({ state, loaded: false, fixture: false, trends: [], problems, notes: unitNotes });
    res.json({
      state, loaded: true, fixture: file.fixture === true, source: file.source, problems: [], notes: unitNotes,
      trends: (["gp", "mptc", "zptc"] as const).map((l) => panchayatTrends(file.elections, l)).filter((t) => t.points.length > 0),
    });
  });

  router.get("/analytics/candidates/:state", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const type = (qs(req.query.type) ?? "assembly").toLowerCase();
    if (!isElectionType(type)) return bad(res, 400, "Invalid type. Valid: assembly, ls", "invalid_type");
    const q = qs(req.query.q) ?? "";
    if (q.replace(/[^A-Za-z]/g, "").length < 2) return bad(res, 400, "Query must have at least 2 letters", "query_too_short");
    res.set("Cache-Control", "no-store");
    res.json({ state, type, query: q, trails: candidateTrails(all(), state, type, q), note: TRAIL_NOTE, ordering: "alphabetical, not ranked", years: yearsFor(state, type) });
  });

  /* ---- S-116 history listing ---- */
  router.get("/history/:state", (req, res) => {
    const state = state_(req.params.state);
    if (!state) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const items = (["assembly", "ls"] as const).flatMap(type => yearsFor(state, type).map(year => {
      const rows = filterElection(all(), state, year, type);
      const pre = rows.some(r => r.comparability === "pre-bifurcation");
      return {
        year, type, seats: new Set(rows.map(r => r.acNo)).size, comparability: pre ? "pre-bifurcation" : "current",
        note: pre ? "Held in undivided Andhra Pradesh; split onto today's seats by the 2008 delimitation order. Party names and alliances are not like-for-like with later elections." : null,
      };
    })).sort((a, b) => b.year - a.year || a.type.localeCompare(b.type));
    res.json({
      state, elections: items,
      notes: [
        "Andhra Pradesh was bifurcated on 2 June 2014. Elections before that, and the 2014 Lok Sabha poll, were fought in undivided Andhra Pradesh (294 assembly, 42 Lok Sabha seats).",
        "Assembly seats 1-119 of the 2009 numbering are today's Telangana seats and 120-294 are Andhra Pradesh (number minus 119); Lok Sabha seats 1-17 are Telangana and 18-42 Andhra Pradesh (number minus 17). The 2008 delimitation applies from 2009 onward.",
      ],
      source: data.manifest?.["history-prebifurcation"] ?? null,
    });
  });

  /* ---- S-115 by-elections ---- */
  router.get("/byelections", (req, res) => {
    const st = qs(req.query.state)?.toUpperCase();
    if (st && !isStateCode(st)) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const type = qs(req.query.type)?.toLowerCase();
    if (type && !isElectionType(type)) return bad(res, 400, "Invalid type. Valid: assembly, ls", "invalid_type");
    const acRaw = qs(req.query.acNo);
    if (acRaw && !/^\d{1,3}$/.test(acRaw)) return bad(res, 400, "Invalid constituency number", "invalid_ac");
    const records = (byel.records ?? []).filter(r => (!st || r.state === st) && (!type || r.type === type) && (!acRaw || r.acNo === Number(acRaw)));
    res.json({
      records, count: records.length, note: byel.note, asOf: byel.asOf,
      source: { dataset: "byelections", provenance: "TCPD Lok Dhaba and ECI results via in-rolls/eci_results", urls: ["https://lokdhaba.ashoka.edu.in/", "https://github.com/in-rolls/eci_results"], licences: ["tcpd-nc", "in-rolls-eci-results"], asOf: byel.asOf ?? null },
    });
  });

  /* ---- S-112 party changes (cited) ---- */
  router.get("/party-switches", (req, res) => {
    const blackout = peopleBlackout(undefined);
    const st = qs(req.query.state)?.toUpperCase();
    if (st && !isStateCode(st)) return bad(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const name = qs(req.query.name)?.toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(t => t.length > 1).sort().join(" ");
    const acRaw = qs(req.query.acNo), type = qs(req.query.type)?.toLowerCase();
    const tok = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(t => t.length > 1).sort().join(" ");
    const records = blackout ? [] : (switches.records ?? []).filter(r =>
      (!st || r.state === st) && (!name || tok(r.person) === name) && (!acRaw || r.constituency.acNo === Number(acRaw)) && (!type || r.constituency.type === type));
    res.set("Cache-Control", "no-store");
    res.json({
      records, count: records.length, blackout, asOf: switches.asOf, policy: switches.policy,
      notice: blackout ? { en: "Party-change records are paused during the model code of conduct period so that this site stays neutral.", te: "ఆదర్శ ప్రవర్తనా నియమావళి కాలంలో తటస్థత కోసం పార్టీ మార్పు వివరాలు నిలిపివేయబడ్డాయి." } : null,
    });
  });

  return router;
}
