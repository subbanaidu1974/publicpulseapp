/**
 * Damped uniform-swing model projection ("uniform-swing-damped-v1").
 * A transparent projection computed ONLY from past results. It is not a poll,
 * not a vote and not a prediction of any outcome. See docs/FORECAST_METHOD.md.
 */
import type { CandidateResult } from "./elections";
import { ALLIANCES } from "./states";
import type { StateCode } from "./states";

export const METHOD = "uniform-swing-damped-v1";
export const DISCLAIMER = "Model projection from past results. Not a poll, not a prediction of any outcome.";

/** Tunables, fixed up-front (never tuned against the back-test). */
export const PARAMS = {
  damping: 0.5,          // fraction of the observed state-level shift carried forward
  lsWeight: 0.5,         // blend weight of the Lok Sabha shift (assembly shift gets 1 - lsWeight)
  runs: 2000,
  presenceMinPct: 10,    // a bloc is "in contention" in a seat when its share >= this
  safeProb: 0.95,
  leanProb: 0.75,        // lean: [0.75, 0.95); toss-up: < 0.75
  minSigmaSamples: 30,
  fallbackSigma: 6,      // pp, used only when history is too short (flagged in output)
  fallbackTau: 4,        // pp, used only when history is too short (flagged in output)
};

export const OTHERS = "Others";

/** Static party -> bloc groupings per state (hindsight blocs, see docs). Merged with ALLIANCES when present. */
const BLOCS: Record<StateCode, Record<string, string[]>> = {
  AP: { "NDA (TDP+JSP+BJP)": ["TDP", "JSP", "BJP"], YSRCP: ["YSRCP"], INC: ["INC"] },
  TG: { BRS: ["BRS", "TRS"], INC: ["INC"], BJP: ["BJP"], AIMIM: ["AIMIM"] },
};

export function blocsFor(state: StateCode, year?: number): Record<string, string[]> {
  const out: Record<string, string[]> = { ...BLOCS[state] };
  const extra = year !== undefined ? ALLIANCES[`${state}-${year}-assembly`] : undefined;
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = [...new Set([...(out[k] ?? []), ...v])];
  return out;
}

function partyBloc(blocs: Record<string, string[]>): (p: string) => string | null {
  const m = new Map<string, string>();
  for (const [b, ps] of Object.entries(blocs)) for (const p of ps) m.set(p, b);
  return p => m.get(p) ?? null;
}

/* ---------------- per-seat tables ---------------- */

interface SeatTable {
  acNo: number; acName: string; district?: string;
  share: Record<string, number>; // named blocs, % of votes in the seat
  othersTop: number;             // largest single un-blocked candidate, %
  contested: boolean;
  winnerBloc: string;
}

function seatTables(rows: CandidateResult[], blocs: Record<string, string[]>): Map<number, SeatTable> {
  const toBloc = partyBloc(blocs);
  const by = new Map<number, CandidateResult[]>();
  for (const r of rows) { const l = by.get(r.acNo); if (l) l.push(r); else by.set(r.acNo, [r]); }
  const out = new Map<number, SeatTable>();
  for (const [acNo, list] of by) {
    const sorted = [...list].sort((a, b) => (b.votes || 0) - (a.votes || 0) || (a.position || 99) - (b.position || 99) || a.candidate.localeCompare(b.candidate));
    const total = list.reduce((s, c) => s + (c.votes || 0), 0);
    const share: Record<string, number> = {};
    for (const b of Object.keys(blocs)) share[b] = 0;
    let othersTop = 0;
    for (const c of list) {
      const pct = total ? ((c.votes || 0) / total) * 100 : 0;
      const b = toBloc(c.party);
      if (b) share[b] += pct; else othersTop = Math.max(othersTop, pct);
    }
    const w = sorted[0];
    out.set(acNo, {
      acNo, acName: w.acName, district: w.district, share, othersTop,
      contested: list.length > 1 && total > 0,
      winnerBloc: toBloc(w.party) ?? OTHERS,
    });
  }
  return out;
}

function stateShares(rows: CandidateResult[], blocs: Record<string, string[]>): Record<string, number> {
  const toBloc = partyBloc(blocs);
  const v: Record<string, number> = {};
  for (const b of Object.keys(blocs)) v[b] = 0;
  let total = 0;
  for (const r of rows) { total += r.votes || 0; const b = toBloc(r.party); if (b) v[b] += r.votes || 0; }
  for (const b of Object.keys(v)) v[b] = total ? (v[b] / total) * 100 : 0;
  return v;
}

const rowsOf = (rows: CandidateResult[], state: StateCode, year: number, type: "assembly" | "ls") =>
  rows.filter(r => r.state === state && r.year === year && r.type === type);

const round = (x: number, d = 2) => { const k = 10 ** d; return Math.round(x * k) / k; };

/* ---------------- fit ---------------- */

export interface ProjectedSeat {
  acNo: number; acName: string; district?: string;
  proj: Record<string, number>;       // contender -> projected share (named blocs + Others)
  leader: string; runnerUp: string; marginPct: number;
}

export interface Model {
  state: StateCode; baseYear: number; prevYear: number | null; lsYear: number | null;
  blocs: string[];
  delta: Record<string, number>;      // pp applied to every seat
  assemblyShift: Record<string, number> | null;
  lsShift: Record<string, number> | null;
  sigma: number; tau: number;
  uncertaintySource: "estimated" | "fallback-prior";
  seats: ProjectedSeat[];
}

function mean(a: number[]) { return a.reduce((s, x) => s + x, 0) / a.length; }
function stdev(a: number[]) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }

/** Fit the model using only results up to `baseYear` (assemblies <= baseYear; LS in [baseYear, targetYear)). */
export function fit(rows: CandidateResult[], state: StateCode, baseYear: number, targetYear: number | null): Model | null {
  const years = [...new Set(rows.filter(r => r.state === state && r.type === "assembly" && r.year <= baseYear).map(r => r.year))].sort((a, b) => a - b);
  if (!years.includes(baseYear)) return null;
  const blocs = blocsFor(state, baseYear);
  const names = Object.keys(blocs);
  const base = seatTables(rowsOf(rows, state, baseYear, "assembly"), blocs);
  const baseShare = stateShares(rowsOf(rows, state, baseYear, "assembly"), blocs);

  const prevYear = years.length > 1 ? years[years.length - 2] : null;
  const lsYears = [...new Set(rows.filter(r => r.state === state && r.type === "ls" && r.year >= baseYear && (targetYear === null || r.year < targetYear)).map(r => r.year))].sort((a, b) => a - b);
  const lsYear = lsYears.length ? lsYears[lsYears.length - 1] : null;

  let assemblyShift: Record<string, number> | null = null;
  if (prevYear !== null) {
    const p = stateShares(rowsOf(rows, state, prevYear, "assembly"), blocs);
    assemblyShift = Object.fromEntries(names.map(b => [b, baseShare[b] - p[b]]));
  }
  let lsShift: Record<string, number> | null = null;
  if (lsYear !== null) {
    const l = stateShares(rowsOf(rows, state, lsYear, "ls"), blocs);
    lsShift = Object.fromEntries(names.map(b => [b, l[b] - baseShare[b]]));
  }
  const delta: Record<string, number> = {};
  for (const b of names) {
    const a = assemblyShift?.[b], l = lsShift?.[b];
    const blend = a !== undefined && l !== undefined ? (1 - PARAMS.lsWeight) * a + PARAMS.lsWeight * l : (a ?? l ?? 0);
    delta[b] = PARAMS.damping * blend;
  }

  // Noise estimates from consecutive assembly pairs up to baseYear.
  const resid: number[] = [];
  const stateMoves: number[] = [];
  for (let i = 1; i < years.length; i++) {
    const y0 = years[i - 1], y1 = years[i];
    const t0 = seatTables(rowsOf(rows, state, y0, "assembly"), blocs), t1 = seatTables(rowsOf(rows, state, y1, "assembly"), blocs);
    const s0 = stateShares(rowsOf(rows, state, y0, "assembly"), blocs), s1 = stateShares(rowsOf(rows, state, y1, "assembly"), blocs);
    for (const b of names) stateMoves.push(s1[b] - s0[b]);
    for (const [no, a] of t1) {
      const o = t0.get(no);
      if (!o || !a.contested || !o.contested) continue;
      for (const b of names) {
        if (Math.max(a.share[b], o.share[b]) < PARAMS.presenceMinPct) continue;
        resid.push(a.share[b] - o.share[b] - (s1[b] - s0[b]));
      }
    }
  }
  const estimated = resid.length >= PARAMS.minSigmaSamples && stateMoves.length > 0;
  const sigma = estimated ? stdev(resid) : PARAMS.fallbackSigma;
  const tau = stateMoves.length ? Math.sqrt(mean(stateMoves.map(x => x * x))) : PARAMS.fallbackTau;

  const seats: ProjectedSeat[] = [];
  for (const s of [...base.values()].sort((a, b) => a.acNo - b.acNo)) {
    const proj: Record<string, number> = {};
    for (const b of names) proj[b] = Math.max(0, s.share[b] + delta[b]);
    proj[OTHERS] = s.othersTop;
    const order = Object.entries(proj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    seats.push({
      acNo: s.acNo, acName: s.acName, district: s.district, proj,
      leader: order[0][0], runnerUp: order[1][0], marginPct: order[0][1] - order[1][1],
    });
  }
  return {
    state, baseYear, prevYear, lsYear, blocs: [...names, OTHERS], delta, assemblyShift, lsShift,
    sigma, tau, uncertaintySource: estimated ? "estimated" : "fallback-prior", seats,
  };
}

/* ---------------- probability ---------------- */

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf approximation, abs err < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export type SeatClass = "safe" | "lean" | "toss-up";

/** P(leader beats runner-up) = Phi(margin / sd), sd = sqrt(2 sigma^2 + 2 tau^2). */
export function winProb(marginPct: number, sigma: number, tau: number): number {
  const sd = Math.sqrt(2 * sigma * sigma + 2 * tau * tau);
  const p = sd > 0 ? normCdf(marginPct / sd) : marginPct > 0 ? 1 : 0.5;
  return Math.min(1, Math.max(0, p));
}
export function classify(p: number): SeatClass {
  return p >= PARAMS.safeProb ? "safe" : p >= PARAMS.leanProb ? "lean" : "toss-up";
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function gaussian(rnd: () => number): number {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

export interface AllianceSim { alliance: string; seatsMedian: number; seatsP10: number; seatsP90: number; majorityProb: number }

/** Seeded Monte Carlo: state shock per bloc (sd tau) + independent seat noise per contending bloc (sd sigma). */
export function simulate(model: Model, runs = PARAMS.runs, seedKey = `${model.state}-${model.baseYear}`): AllianceSim[] {
  const rnd = mulberry32(hashSeed(seedKey));
  const names = model.blocs;
  const counts: Record<string, number[]> = Object.fromEntries(names.map(b => [b, new Array(runs).fill(0)]));
  const need = Math.floor(model.seats.length / 2) + 1;
  for (let r = 0; r < runs; r++) {
    const shock: Record<string, number> = {};
    for (const b of names) shock[b] = b === OTHERS ? 0 : gaussian(rnd) * model.tau;
    for (const s of model.seats) {
      let best = "", bv = -Infinity;
      for (const b of names) {
        const p = s.proj[b];
        const v = p >= PARAMS.presenceMinPct ? p + shock[b] + gaussian(rnd) * model.sigma : p;
        if (v > bv) { bv = v; best = b; }
      }
      counts[best][r]++;
    }
  }
  const q = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  return names.map(b => {
    const sorted = [...counts[b]].sort((x, y) => x - y);
    return {
      alliance: b, seatsMedian: q(sorted, 0.5), seatsP10: q(sorted, 0.1), seatsP90: q(sorted, 0.9),
      majorityProb: counts[b].filter(c => c >= need).length / runs,
    };
  });
}

/* ---------------- back-test ---------------- */

export interface CalibrationBin { lo: number; hi: number; n: number; meanPredicted: number | null; observed: number | null }
const BIN_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
/** Bin (probability, hit) pairs. Leader probabilities are >= 0.5 by construction. */
export function calibrationBins(pairs: { p: number; hit: number }[]): CalibrationBin[] {
  return BIN_EDGES.slice(0, -1).map((lo, i) => {
    const hi = BIN_EDGES[i + 1];
    const m = pairs.filter(x => x.p >= lo && x.p < hi);
    return {
      lo, hi: Math.min(hi, 1), n: m.length,
      meanPredicted: m.length ? round(mean(m.map(x => x.p)), 4) : null,
      observed: m.length ? round(mean(m.map(x => x.hit)), 4) : null,
    };
  });
}

export interface BacktestRun {
  predictedFrom: { assembly: number; assemblyPrev: number | null; ls: number | null };
  target: number;
  seatsCompared: number;
  trendAvailable: boolean;
  uncertaintySource: Model["uncertaintySource"];
  winnerHitRate: number;
  persistenceHitRate: number; // naive baseline: last winner (by bloc) holds
  brier: number;              // mean (winProbLeader - hit)^2 over seats
  /** Reliability bins: stated leader probability vs how often the leader actually won (S-119). */
  calibration: CalibrationBin[];
  seatError: { alliance: string; predicted: number; predictedMedian: number; actual: number; error: number }[];
  meanAbsSeatError: number;
  notes: string[];
}

export function backtest(rows: CandidateResult[], state: StateCode, baseYear: number, targetYear: number): BacktestRun | null {
  const m = fit(rows, state, baseYear, targetYear);
  const targetRows = rowsOf(rows, state, targetYear, "assembly");
  if (!m || !targetRows.length) return null;
  const blocs = blocsFor(state, baseYear);
  const actual = seatTables(targetRows, blocs);
  const baseT = seatTables(rowsOf(rows, state, baseYear, "assembly"), blocs);
  let hit = 0, pers = 0, n = 0, brier = 0;
  const pairs: { p: number; hit: number }[] = [];
  const predicted: Record<string, number> = {}, act: Record<string, number> = {};
  for (const b of m.blocs) { predicted[b] = 0; act[b] = 0; }
  for (const s of m.seats) {
    const a = actual.get(s.acNo);
    if (!a) continue;
    n++;
    const ok = s.leader === a.winnerBloc ? 1 : 0;
    hit += ok;
    if (baseT.get(s.acNo)?.winnerBloc === a.winnerBloc) pers++;
    const pw = winProb(s.marginPct, m.sigma, m.tau);
    brier += (pw - ok) ** 2;
    pairs.push({ p: pw, hit: ok });
    predicted[s.leader]++;
    act[a.winnerBloc] = (act[a.winnerBloc] ?? 0) + 1;
  }
  const sim = simulate(m, PARAMS.runs, `bt-${state}-${baseYear}-${targetYear}`);
  const seatError = m.blocs.map(b => ({
    alliance: b, predicted: predicted[b], predictedMedian: sim.find(x => x.alliance === b)!.seatsMedian,
    actual: act[b] ?? 0, error: predicted[b] - (act[b] ?? 0),
  }));
  const trendAvailable = m.prevYear !== null || m.lsYear !== null;
  const notes: string[] = [];
  if (!trendAvailable) notes.push("No earlier assembly or Lok Sabha result: this run is pure persistence (zero trend).");
  if (m.uncertaintySource === "fallback-prior") notes.push("Too little history to estimate noise; fixed fallback sigma/tau used, so probabilities and Brier score are not data-derived.");
  return {
    predictedFrom: { assembly: baseYear, assemblyPrev: m.prevYear, ls: m.lsYear },
    target: targetYear, seatsCompared: n, trendAvailable, uncertaintySource: m.uncertaintySource,
    winnerHitRate: n ? round(hit / n, 4) : 0, persistenceHitRate: n ? round(pers / n, 4) : 0,
    brier: n ? round(brier / n, 4) : 0, calibration: calibrationBins(pairs), seatError,
    meanAbsSeatError: round(mean(seatError.map(e => Math.abs(e.error))), 2), notes,
  };
}

/* ---------------- public entry ---------------- */

export interface ForecastResponse {
  state: StateCode;
  basedOn: { assembly: number; assemblyPrev: number | null; ls: number | null };
  method: typeof METHOD;
  generatedFrom: string;
  disclaimer: string;
  blackout: boolean;
  parameters?: {
    damping: number; lsWeight: number; runs: number; sigmaPp: number; tauPp: number;
    uncertaintySource: Model["uncertaintySource"]; trendPp: Record<string, number>; thresholds: { safe: number; lean: number };
  };
  seats?: { acNo: number; acName: string; district?: string; leader: string; runnerUp: string; marginPct: number; winProbLeader: number; class: SeatClass }[];
  alliances?: { alliance: string; seatsMedian: number; seatsP10: number; seatsP90: number; majorityProb: number }[];
  backtest?: { runs: BacktestRun[]; summary: string; calibration?: CalibrationBin[] };
}

/** Fail-closed response used during an election blackout window: no seats, no alliances. */
export function blackoutResponse(state: StateCode): ForecastResponse {
  return { state, basedOn: { assembly: 0, assemblyPrev: null, ls: null }, method: METHOD, generatedFrom: "withheld", disclaimer: DISCLAIMER, blackout: true };
}

/** Pool the per-run reliability bins (weighted by n) into one table. */
export function poolCalibration(runs: BacktestRun[]): CalibrationBin[] {
  return BIN_EDGES.slice(0, -1).map((lo, i) => {
    const bins = runs.map(r => r.calibration?.[i]).filter((b): b is CalibrationBin => !!b && b.n > 0);
    const n = bins.reduce((a, b) => a + b.n, 0);
    return {
      lo, hi: Math.min(BIN_EDGES[i + 1], 1), n,
      meanPredicted: n ? round(bins.reduce((a, b) => a + b.n * (b.meanPredicted ?? 0), 0) / n, 4) : null,
      observed: n ? round(bins.reduce((a, b) => a + b.n * (b.observed ?? 0), 0) / n, 4) : null,
    };
  });
}

/** Compute the full forecast for a state, or null when there is no assembly data. */
export function computeForecast(rows: CandidateResult[], state: StateCode): ForecastResponse | null {
  const years = [...new Set(rows.filter(r => r.state === state && r.type === "assembly").map(r => r.year))].sort((a, b) => a - b);
  if (!years.length) return null;
  const last = years[years.length - 1];
  const m = fit(rows, state, last, null);
  if (!m) return null;
  const sim = simulate(m);
  const seats = m.seats.map(s => {
    const p = winProb(s.marginPct, m.sigma, m.tau);
    return {
      acNo: s.acNo, acName: s.acName, ...(s.district ? { district: s.district } : {}),
      leader: s.leader, runnerUp: s.runnerUp, marginPct: round(s.marginPct), winProbLeader: round(p, 4), class: classify(p),
    };
  });
  const runs: BacktestRun[] = [];
  for (let i = 0; i + 1 < years.length; i++) { const r = backtest(rows, state, years[i], years[i + 1]); if (r) runs.push(r); }
  const provs = [...new Set(rowsOf(rows, state, last, "assembly").map(r => r.provenance ?? "unknown"))].sort();
  const summary = runs.length
    ? `Winner hit-rate by run: ${runs.map(r => `${r.predictedFrom.assembly}->${r.target} ${(r.winnerHitRate * 100).toFixed(1)}% (persistence baseline ${(r.persistenceHitRate * 100).toFixed(1)}%)`).join("; ")}.`
    : "No back-test possible (fewer than two assembly elections).";
  return {
    state,
    basedOn: { assembly: last, assemblyPrev: m.prevYear, ls: m.lsYear },
    method: METHOD,
    generatedFrom: provs.join("+") || "unknown",
    disclaimer: DISCLAIMER,
    blackout: false,
    parameters: {
      damping: PARAMS.damping, lsWeight: PARAMS.lsWeight, runs: PARAMS.runs, sigmaPp: round(m.sigma), tauPp: round(m.tau),
      uncertaintySource: m.uncertaintySource,
      trendPp: Object.fromEntries(Object.entries(m.delta).map(([k, v]) => [k, round(v)])),
      thresholds: { safe: PARAMS.safeProb, lean: PARAMS.leanProb },
    },
    seats,
    alliances: sim.map(a => ({ alliance: a.alliance, seatsMedian: a.seatsMedian, seatsP10: a.seatsP10, seatsP90: a.seatsP90, majorityProb: round(a.majorityProb, 4) })),
    backtest: { runs, summary, calibration: poolCalibration(runs) },
  };
}
