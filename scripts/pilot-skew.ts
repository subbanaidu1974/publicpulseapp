/**
 * Pilot skew tool (S-153, E2E-168; RELEASE_GATE row 3). Method and limits: docs/PILOT_SKEW_PLAN.md.
 *
 * Input is AGGREGATE counts only: for each stratum of gender, age band, phone ownership and shared-SIM status, how many people were
 * invited and how many responded. It computes response-rate skew (each stratum's rate against the overall rate), a simple
 * representativeness index against reference marginals, and flags strata below the minimum cell size.
 *
 * It must never ingest individual-level data. The parser accepts only the columns dimension, stratum, invited, responded
 * (and optionally reference_share), refuses any other column, refuses more than MAX_ROWS rows, refuses labels that look like a phone
 * number or an identifier, and refuses non-integer or inconsistent counts. A file that looks individual-level is rejected whole.
 *
 * Reference marginals: Census 2011 (data/generated/census-subdistricts.json, census.json) supplies sex only (all ages, so it is an
 * approximation for adults). Age-band and phone-ownership marginals are NOT in those files and electoral-roll marginals are not available;
 * a human may supply reference shares in the input (sourced and cited in the report). Nothing is invented here.
 *
 * Usage: npm run pilot:skew -- --input counts.csv|counts.json [--census subdistrict=Adilabad/Tamsi] [--min-cell 30] [--json]
 *        --census district=Srikakulam            (AP or TG district name or code; "TG:Adilabad" to disambiguate)
 *        --census subdistrict=Adilabad/Tamsi,Adilabad/ADILABAD MANDAL   (district/subdistrict, summed)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DIMENSIONS = ["gender", "age_band", "phone_ownership", "shared_sim"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const MAX_ROWS = 200;
export const MAX_STRATA_PER_DIMENSION = 12;
export const DEFAULT_MIN_CELL = 30;
export const DEFAULT_SKEW_BAND: [number, number] = [0.8, 1.25];
export const DEFAULT_INDEX_WARN = 0.9;

export const CAVEATS = [
  "Pilot results are a signal, not a representative sample: phone ownership, gender and age skew who participates.",
  "Electoral-roll marginals are not available; Census 2011 gives sex (all ages) and SC/ST only. Age-band and phone-ownership references must come from a cited source supplied by a human.",
  "Strata below the minimum cell size are flagged and must not be reported as findings.",
  "The thresholds (skew band, index warning) are screening defaults chosen for this tool, not standards.",
];

export interface StratumInput { dimension: Dimension; stratum: string; invited: number; responded: number; reference_share?: number }
export interface PilotInput { area?: string; strata: StratumInput[]; reference_shares?: Partial<Record<Dimension, Record<string, number>>> }

export class AggregateOnlyError extends Error {}

const FORBIDDEN_COLUMN = /phone|mobile|msisdn|name|id$|^id|person|aadhaar|aadhar|voter|epic|address|email|dob|birth|response_text|answer/i;
const CSV_COLUMNS = new Set(["dimension", "stratum", "invited", "responded", "reference_share"]);

function checkCount(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n < 0) throw new AggregateOnlyError(`${what} must be a non-negative integer count`);
  return n;
}

/** Validate rows and reject anything that looks individual-level. */
export function validateAggregate(rows: StratumInput[]): StratumInput[] {
  if (rows.length === 0) throw new AggregateOnlyError("no strata in the input");
  if (rows.length > MAX_ROWS) throw new AggregateOnlyError(`${rows.length} rows: this tool accepts aggregate counts only (at most ${MAX_ROWS} rows); individual-level data is refused`);
  const seen = new Set<string>();
  const perDim = new Map<string, number>();
  for (const r of rows) {
    if (!DIMENSIONS.includes(r.dimension)) throw new AggregateOnlyError(`unknown dimension "${r.dimension}" (allowed: ${DIMENSIONS.join(", ")})`);
    const label = String(r.stratum ?? "");
    if (!label || label.length > 40) throw new AggregateOnlyError("stratum label must be 1 to 40 characters");
    if (/\d{7,}/.test(label.replace(/[\s-]/g, "")) || /@/.test(label)) throw new AggregateOnlyError(`stratum label "${label.slice(0, 12)}..." looks like an identifier or phone number; individual-level data is refused`);
    const key = r.dimension + "|" + label.toLowerCase();
    if (seen.has(key)) throw new AggregateOnlyError(`duplicate stratum ${r.dimension}/${label}`);
    seen.add(key);
    perDim.set(r.dimension, (perDim.get(r.dimension) ?? 0) + 1);
    if (r.responded > r.invited) throw new AggregateOnlyError(`${r.dimension}/${label}: responded exceeds invited`);
    if (r.reference_share !== undefined && !(r.reference_share >= 0 && r.reference_share <= 1)) throw new AggregateOnlyError(`${r.dimension}/${label}: reference_share must be between 0 and 1`);
  }
  for (const [d, n] of perDim) if (n > MAX_STRATA_PER_DIMENSION) throw new AggregateOnlyError(`${d} has ${n} strata (at most ${MAX_STRATA_PER_DIMENSION}); individual-level data is refused`);
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function parseCsv(text: string): PilotInput {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) throw new AggregateOnlyError("CSV needs a header and at least one row");
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  for (const h of header) {
    if (!CSV_COLUMNS.has(h)) throw new AggregateOnlyError(FORBIDDEN_COLUMN.test(h) ? `column "${h}" looks like an individual-level field; this tool accepts aggregate counts only (dimension, stratum, invited, responded)` : `unknown column "${h}" (allowed: ${[...CSV_COLUMNS].join(", ")})`);
  }
  for (const need of ["dimension", "stratum", "invited", "responded"]) if (!header.includes(need)) throw new AggregateOnlyError(`missing column "${need}"`);
  if (lines.length - 1 > MAX_ROWS) throw new AggregateOnlyError(`${lines.length - 1} rows: aggregate counts only (at most ${MAX_ROWS})`);
  const idx = (n: string) => header.indexOf(n);
  const strata = lines.slice(1).map((l, i) => {
    const c = splitCsvLine(l);
    if (c.length !== header.length) throw new AggregateOnlyError(`row ${i + 2} has ${c.length} fields, expected ${header.length}`);
    const row: StratumInput = {
      dimension: c[idx("dimension")].toLowerCase() as Dimension, stratum: c[idx("stratum")],
      invited: checkCount(c[idx("invited")], `row ${i + 2} invited`), responded: checkCount(c[idx("responded")], `row ${i + 2} responded`),
    };
    if (idx("reference_share") >= 0 && c[idx("reference_share")] !== "") row.reference_share = Number(c[idx("reference_share")]);
    return row;
  });
  return { strata };
}

export function parseJsonInput(text: string): PilotInput {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new AggregateOnlyError("input is not valid JSON"); }
  const o = j as { area?: unknown; strata?: unknown; reference_shares?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.strata)) throw new AggregateOnlyError('JSON must be {"strata": [...]}');
  if (o.strata.length > MAX_ROWS) throw new AggregateOnlyError(`${o.strata.length} rows: aggregate counts only (at most ${MAX_ROWS})`);
  const strata = (o.strata as Record<string, unknown>[]).map((s, i) => {
    for (const k of Object.keys(s)) if (!CSV_COLUMNS.has(k)) throw new AggregateOnlyError(FORBIDDEN_COLUMN.test(k) ? `field "${k}" looks like an individual-level field; aggregate counts only` : `unknown field "${k}" in strata[${i}]`);
    const row: StratumInput = { dimension: String(s.dimension).toLowerCase() as Dimension, stratum: String(s.stratum ?? ""), invited: checkCount(s.invited, `strata[${i}].invited`), responded: checkCount(s.responded, `strata[${i}].responded`) };
    if (s.reference_share !== undefined) row.reference_share = Number(s.reference_share);
    return row;
  });
  const out: PilotInput = { strata };
  if (typeof o.area === "string") out.area = o.area.slice(0, 120);
  if (o.reference_shares && typeof o.reference_shares === "object") out.reference_shares = o.reference_shares as PilotInput["reference_shares"];
  return out;
}

export function parseInputFile(file: string): PilotInput {
  const text = fs.readFileSync(file, "utf8");
  return /\.json$/i.test(file) ? parseJsonInput(text) : parseCsv(text);
}

// ---------------------------------------------------------------------------------------------
// Census reference (sex only)
// ---------------------------------------------------------------------------------------------

export interface CensusReference { label: string; population: number; shares: Record<string, number>; source: string }

interface CensusDistrict { state: string; district: string; districtCode: string; males: number; females: number; population: number }
interface CensusSub { state: string; district: string; districtCode: string; subDistrict: string; subDistrictCode: string; males: number; females: number; population: number }

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const withState = (item: string): { state: string | null; rest: string } => {
  const m = /^(AP|TG):(.*)$/i.exec(item.trim());
  return m ? { state: m[1].toUpperCase(), rest: m[2].trim() } : { state: null, rest: item.trim() };
};

/** Resolve `district=A,B` or `subdistrict=District/Mandal,...` against the Census 2011 files and sum the sexes. */
export function loadCensusReference(root: string, spec: string): CensusReference {
  const m = /^(district|subdistrict)=(.+)$/i.exec(spec.trim());
  if (!m) throw new Error('--census must be "district=<name|code>[,...]" or "subdistrict=<district>/<subdistrict>[,...]"');
  const kind = m[1].toLowerCase();
  const items = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  const gen = path.join(root, "data", "generated");
  let males = 0, females = 0;
  const labels: string[] = [];
  let source = "";
  if (kind === "district") {
    const j = JSON.parse(fs.readFileSync(path.join(gen, "census.json"), "utf8")) as { districts: CensusDistrict[]; source?: string };
    source = `Census of India 2011 (data/generated/census.json): ${j.source ?? ""}`.trim();
    for (const it of items) {
      const { state, rest } = withState(it);
      const hit = j.districts.filter((d) => (!state || d.state === state) && (eq(d.district, rest) || d.districtCode === rest));
      if (hit.length === 0) throw new Error(`no census district matches "${it}"`);
      if (hit.length > 1) throw new Error(`"${it}" matches ${hit.length} districts; prefix with AP: or TG:`);
      males += hit[0].males; females += hit[0].females; labels.push(`${hit[0].state}:${hit[0].district}`);
    }
  } else {
    const j = JSON.parse(fs.readFileSync(path.join(gen, "census-subdistricts.json"), "utf8")) as { subDistricts: CensusSub[]; source?: string };
    source = `Census of India 2011 (data/generated/census-subdistricts.json): ${j.source ?? ""}`.trim();
    for (const it of items) {
      const { state, rest } = withState(it);
      const [dist, sub] = rest.split("/").map((s) => s?.trim());
      if (!dist || !sub) throw new Error(`"${it}": use <district>/<subdistrict>`);
      const hit = j.subDistricts.filter((d) => (!state || d.state === state) && (eq(d.district, dist) || d.districtCode === dist) && (eq(d.subDistrict, sub) || d.subDistrictCode === sub));
      if (hit.length === 0) throw new Error(`no census sub-district matches "${it}"`);
      if (hit.length > 1) throw new Error(`"${it}" matches ${hit.length} sub-districts; prefix with AP: or TG: or use codes`);
      males += hit[0].males; females += hit[0].females; labels.push(`${hit[0].state}:${hit[0].district}/${hit[0].subDistrict}`);
    }
  }
  const pop = males + females;
  if (!(pop > 0)) throw new Error("census reference has no population");
  return { label: labels.join(" + "), population: pop, shares: { male: males / pop, female: females / pop }, source };
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

export interface AnalyseOptions { minCell?: number; skewBand?: [number, number]; indexWarn?: number; census?: CensusReference | null }
export interface StratumResult {
  stratum: string; invited: number; responded: number;
  rate: number | null; skewRatio: number | null; invitedShare: number | null; respondentShare: number | null; referenceShare: number | null;
  belowMinCell: boolean; flags: string[];
}
export interface DimensionResult {
  dimension: Dimension; invited: number; responded: number; overallRate: number | null;
  strata: StratumResult[]; referenceSource: string | null;
  index: number | null; indexReliable: boolean; invitedIndex: number | null; disparity: number | null; flags: string[];
}
export interface SkewReport {
  synthetic?: boolean; area: string | null; minCell: number; skewBand: [number, number]; indexWarn: number;
  dimensions: DimensionResult[]; flaggedStrata: string[]; warnings: string[]; caveats: string[]; censusReference: CensusReference | null;
}

const round = (x: number | null, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function analyse(input: PilotInput, opts: AnalyseOptions = {}): SkewReport {
  const rows = validateAggregate(input.strata);
  const minCell = opts.minCell ?? DEFAULT_MIN_CELL;
  const band = opts.skewBand ?? DEFAULT_SKEW_BAND;
  const indexWarn = opts.indexWarn ?? DEFAULT_INDEX_WARN;
  const warnings: string[] = [];
  const flagged: string[] = [];
  const dims: DimensionResult[] = [];
  for (const d of DIMENSIONS) {
    const sel = rows.filter((r) => r.dimension === d);
    if (!sel.length) continue;
    const invited = sel.reduce((a, r) => a + r.invited, 0), responded = sel.reduce((a, r) => a + r.responded, 0);
    const overall = invited > 0 ? responded / invited : null;
    // Reference shares: census for gender, then input reference_shares, then per-row reference_share.
    const ref = new Map<string, number>();
    let refSource: string | null = null;
    if (d === "gender" && opts.census) { for (const [k, v] of Object.entries(opts.census.shares)) ref.set(k, v); refSource = opts.census.source; }
    const fromInput = input.reference_shares?.[d];
    if (fromInput) { for (const [k, v] of Object.entries(fromInput)) ref.set(k.toLowerCase(), v); refSource = "reference_shares in the input (cite the source in the report)"; }
    for (const r of sel) if (r.reference_share !== undefined) { ref.set(r.stratum.toLowerCase(), r.reference_share); refSource = refSource ?? "reference_share in the input (cite the source in the report)"; }
    const refSum = [...ref.values()].reduce((a, b) => a + b, 0);
    if (ref.size && Math.abs(refSum - 1) > 0.02 && sel.every((r) => ref.has(r.stratum.toLowerCase()))) warnings.push(`${d}: reference shares sum to ${round(refSum, 3)}, not 1; they are renormalised`);
    const refStrata = sel.filter((r) => ref.has(r.stratum.toLowerCase()));
    const refTotal = refStrata.reduce((a, r) => a + (ref.get(r.stratum.toLowerCase()) ?? 0), 0);
    const respRef = refStrata.reduce((a, r) => a + r.responded, 0), invRef = refStrata.reduce((a, r) => a + r.invited, 0);
    const dimFlags: string[] = [];
    const strata: StratumResult[] = sel.map((r) => {
      const below = r.invited < minCell || r.responded < minCell;
      const rate = r.invited > 0 ? r.responded / r.invited : null;
      const skew = rate !== null && overall ? rate / overall : null;
      const p = ref.get(r.stratum.toLowerCase());
      const flags: string[] = [];
      if (below) flags.push(`below_min_cell(${minCell})`);
      if (!below && skew !== null && (skew < band[0] || skew > band[1])) flags.push(skew < band[0] ? "under_responding" : "over_responding");
      if (ref.size && p === undefined) flags.push("no_reference_share");
      if (flags.length) flagged.push(`${d}/${r.stratum}: ${flags.join(", ")}`);
      return {
        stratum: r.stratum, invited: r.invited, responded: r.responded, rate: round(rate), skewRatio: round(skew),
        invitedShare: invited > 0 ? round(r.invited / invited) : null, respondentShare: responded > 0 ? round(r.responded / responded) : null,
        referenceShare: p === undefined || refTotal <= 0 ? null : round(p / refTotal), belowMinCell: below, flags,
      };
    });
    let index: number | null = null, invitedIndex: number | null = null;
    if (refStrata.length >= 2 && refTotal > 0 && respRef > 0) {
      index = 1 - 0.5 * refStrata.reduce((a, r) => a + Math.abs(r.responded / respRef - (ref.get(r.stratum.toLowerCase()) ?? 0) / refTotal), 0);
      if (invRef > 0) invitedIndex = 1 - 0.5 * refStrata.reduce((a, r) => a + Math.abs(r.invited / invRef - (ref.get(r.stratum.toLowerCase()) ?? 0) / refTotal), 0);
    } else if (ref.size === 0) dimFlags.push("no_reference");
    const unreliable = refStrata.some((r) => r.invited < minCell || r.responded < minCell);
    if (index !== null && unreliable) dimFlags.push("index_unreliable_small_cells");
    if (index !== null && index < indexWarn) dimFlags.push(`low_representativeness(<${indexWarn})`);
    const reliableRates = strata.filter((s) => !s.belowMinCell && s.rate !== null && s.rate > 0).map((s) => s.rate as number);
    const disparity = reliableRates.length >= 2 ? Math.max(...reliableRates) / Math.min(...reliableRates) : null;
    if (dimFlags.length) flagged.push(`${d}: ${dimFlags.join(", ")}`);
    dims.push({ dimension: d, invited, responded, overallRate: round(overall), strata, referenceSource: refSource, index: round(index), indexReliable: index !== null && !unreliable, invitedIndex: round(invitedIndex), disparity: round(disparity), flags: dimFlags });
  }
  const totals = new Set(dims.map((x) => x.invited));
  if (totals.size > 1) warnings.push(`invited totals differ across dimensions (${dims.map((x) => `${x.dimension}=${x.invited}`).join(", ")}); the dimensions should describe the same invited population`);
  const g = dims.find((x) => x.dimension === "gender");
  if (g && opts.census && g.strata.some((s) => !["male", "female"].includes(s.stratum.toLowerCase()))) warnings.push("gender: strata other than male/female have no census reference and are left out of the index");
  if (opts.census) warnings.push("census sex shares cover all ages; adults may differ slightly");
  return { area: input.area ?? null, minCell, skewBand: band, indexWarn, dimensions: dims, flaggedStrata: flagged, warnings, caveats: CAVEATS, censusReference: opts.census ?? null };
}

const pct = (x: number | null) => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");

export function formatSkew(r: SkewReport): string {
  const L: string[] = [];
  L.push(`Pilot skew report${r.area ? " - " + r.area : ""}${r.synthetic ? " [SYNTHETIC DATA]" : ""}`);
  L.push(`minimum cell ${r.minCell}; skew band ${r.skewBand[0]} to ${r.skewBand[1]}; index warning below ${r.indexWarn}`);
  if (r.censusReference) L.push(`census reference: ${r.censusReference.label} (population ${r.censusReference.population}; male ${pct(r.censusReference.shares.male)}, female ${pct(r.censusReference.shares.female)})`);
  L.push("");
  for (const d of r.dimensions) {
    L.push(`${d.dimension}: invited ${d.invited}, responded ${d.responded}, overall rate ${pct(d.overallRate)}`);
    for (const s of d.strata) {
      L.push(`  ${s.stratum.padEnd(18)} n=${String(s.invited).padStart(5)} resp=${String(s.responded).padStart(5)} rate=${pct(s.rate).padStart(6)} skew=${s.skewRatio === null ? "n/a" : s.skewRatio.toFixed(2)} ref=${pct(s.referenceShare)} ${s.flags.length ? "[" + s.flags.join("; ") + "]" : ""}`);
    }
    L.push(`  representativeness index: ${d.index === null ? "n/a (no reference)" : d.index.toFixed(3) + (d.indexReliable ? "" : " (UNRELIABLE: small cells)")}; invited-frame index: ${d.invitedIndex === null ? "n/a" : d.invitedIndex.toFixed(3)}; rate disparity (max/min, reliable cells): ${d.disparity === null ? "n/a" : d.disparity.toFixed(2)}`);
  }
  L.push("", `Flagged: ${r.flaggedStrata.length ? "" : "none"}`);
  for (const f of r.flaggedStrata) L.push("  " + f);
  if (r.warnings.length) { L.push("", "Warnings:"); for (const w of r.warnings) L.push("  " + w); }
  L.push("", "Caveats:"); for (const c of r.caveats) L.push("  " + c);
  return L.join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const val = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const file = val("--input");
    if (!file) throw new Error("usage: npm run pilot:skew -- --input counts.csv|counts.json [--census subdistrict=District/Mandal] [--min-cell 30] [--json]");
    const input = parseInputFile(path.resolve(file));
    const census = val("--census") ? loadCensusReference(root, val("--census") as string) : null;
    const minCell = val("--min-cell") ? Number(val("--min-cell")) : undefined;
    const report = analyse(input, { census, minCell });
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatSkew(report));
  } catch (e) {
    console.error("pilot-skew: " + (e as Error).message);
    process.exit(e instanceof AggregateOnlyError ? 3 : 2);
  }
}
