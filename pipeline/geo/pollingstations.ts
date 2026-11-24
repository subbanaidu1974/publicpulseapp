/**
 * S-91: polling-station REFERENCE list (station number, name, AC, part, location text, optional lat/lon). Schema, validator and CSV
 * importer only: no station data ships with the repository and electoral-roll PDFs are never ingested (docs/DESIGN_2028.md 3.4/8).
 *
 * Legal guard: a record or CSV header carrying anything voter-level (elector name, EPIC, relative name, age, gender, house number,
 * an individual's address, phone, photo, Aadhaar) is REJECTED, not stripped. A header-level hit rejects the whole file because it
 * means the source is a roll extract. The guard is deliberately stricter than needed: it errs on the side of rejecting.
 */
import { createHash } from "node:crypto";
import { parseCsv } from "./util";

export interface PollingStation {
  stationNo: string; name: string; acNo: number; partNo: number | null; location: string;
  lat: number | null; lon: number | null; source: string; asOf: string;
}
export const STATION_FIELDS = ["stationNo", "name", "acNo", "partNo", "location", "lat", "lon", "source", "asOf"] as const;
const ALLOWED = new Set<string>(STATION_FIELDS);

/** Key fragments that mark voter-level or individual-level data. Matched against the normalised key (lowercase, alnum only). */
const FORBIDDEN_KEY = /(epic|voter|elector(?!al)|electorname|relative|relation|father|husband|mother|wife|guardian|spouse|\bage\b|^age|gender|^sex|dob|birth|aadhaar|aadhar|mobile|phone|email|photo|image|serialno|slno|houseno|housenumber|address|caste|religion|nameofelector)/;
const FORBIDDEN_NORM = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, "");

export class LegalGuardError extends Error { constructor(message: string) { super(message); this.name = "LegalGuardError"; } }

/** EPIC (voter id) is three letters and seven digits. */
const EPIC = /\b[A-Z]{3}\d{7}\b/;
const PHONE = /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/;
const AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_NAME = 120, MAX_LOCATION = 200;

/** Forbidden keys present on a raw record (also catches unknown keys, since only the schema fields are allowed). */
export function voterLevelKeys(rec: Record<string, unknown>): string[] {
  return Object.keys(rec).filter(k => FORBIDDEN_KEY.test(FORBIDDEN_NORM(k)));
}

/** Validate one raw record. [] = valid. Any voter-level field, EPIC-like or phone-like value is an error. */
export function validateStation(raw: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const bad = voterLevelKeys(raw);
  if (bad.length) errs.push(`voter-level field(s) not allowed: ${bad.join(", ")}`);
  for (const k of Object.keys(raw)) if (!ALLOWED.has(k) && !bad.includes(k)) errs.push(`unknown field '${k}' (allowed: ${STATION_FIELDS.join(", ")})`);
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    if (EPIC.test(v)) errs.push(`field '${k}' contains an EPIC (voter id) pattern`);
    if (PHONE.test(v) && k !== "stationNo") errs.push(`field '${k}' contains a phone number pattern`);
    if (AADHAAR.test(v)) errs.push(`field '${k}' contains an Aadhaar-like number`);
  }
  const s = raw as Partial<Record<(typeof STATION_FIELDS)[number], unknown>>;
  if (typeof s.stationNo !== "string" || !/^[0-9]{1,4}[A-Za-z]{0,2}$/.test(s.stationNo)) errs.push("stationNo must be 1-4 digits with an optional letter suffix (e.g. 12 or 12A)");
  if (typeof s.name !== "string" || !s.name.trim() || s.name.length > MAX_NAME) errs.push(`name is required (max ${MAX_NAME} characters)`);
  if (!Number.isInteger(s.acNo) || (s.acNo as number) < 1 || (s.acNo as number) > 300) errs.push("acNo must be an integer 1-300");
  if (s.partNo !== null && s.partNo !== undefined && (!Number.isInteger(s.partNo) || (s.partNo as number) < 1 || (s.partNo as number) > 9999)) errs.push("partNo must be an integer 1-9999 or null");
  if (typeof s.location !== "string" || !s.location.trim() || s.location.length > MAX_LOCATION) errs.push(`location text is required (max ${MAX_LOCATION} characters: a building or landmark, never a person's address)`);
  const hasLat = s.lat !== null && s.lat !== undefined, hasLon = s.lon !== null && s.lon !== undefined;
  if (hasLat !== hasLon) errs.push("lat and lon must both be present or both absent");
  if (hasLat && hasLon) {
    if (typeof s.lat !== "number" || typeof s.lon !== "number" || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) || s.lat < 5 || s.lat > 40 || s.lon < 60 || s.lon > 100) errs.push("lat/lon must be numbers inside India");
  }
  if (typeof s.source !== "string" || !s.source.trim()) errs.push("source (provenance of this row) is required");
  if (typeof s.asOf !== "string" || !ISO.test(s.asOf)) errs.push("asOf must be an ISO date (YYYY-MM-DD)");
  return errs;
}

/** Whole-list checks: duplicates per (acNo, stationNo). */
export function validateStations(list: PollingStation[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const k = `${s.acNo}|${s.stationNo}`;
    if (seen.has(k)) errs.push(`duplicate station ${s.stationNo} in AC ${s.acNo}`);
    seen.add(k);
  }
  return errs;
}

/** The only shape the API and the generated file expose: reference fields, nothing else. */
export function toReference(s: PollingStation): PollingStation {
  return { stationNo: s.stationNo, name: s.name, acNo: s.acNo, partNo: s.partNo ?? null, location: s.location, lat: s.lat ?? null, lon: s.lon ?? null, source: s.source, asOf: s.asOf };
}

/* ---------- CSV import ---------- */
const HEADER_ALIASES: Record<string, (typeof STATION_FIELDS)[number]> = {
  stationno: "stationNo", psno: "stationNo", pollingstationno: "stationNo", pollingstationnumber: "stationNo", stationnumber: "stationNo",
  name: "name", psname: "name", stationname: "name", pollingstationname: "name",
  acno: "acNo", acnumber: "acNo", constituencyno: "acNo", assemblyconstituencyno: "acNo",
  partno: "partNo", part: "partNo", partnumber: "partNo",
  location: "location", locationtext: "location", building: "location", landmark: "location",
  lat: "lat", latitude: "lat", lon: "lon", lng: "lon", longitude: "lon",
  source: "source", asof: "asOf",
};

export interface ImportResult { records: PollingStation[]; rejected: { row: number; errors: string[] }[]; sha256: string; rows: number }

export function parseStationCsv(text: string, ctx: { source: string; asOf: string }): ImportResult {
  const sha256 = createHash("sha256").update(text).digest("hex");
  const table = parseCsv(text);
  const headers = table.length ? Object.keys(table[0]) : [];
  const forbidden = headers.filter(h => FORBIDDEN_KEY.test(FORBIDDEN_NORM(h)));
  if (forbidden.length) throw new LegalGuardError(`rejected: CSV has voter-level column(s) [${forbidden.join(", ")}]. This looks like an electoral-roll extract; only polling-station reference columns are accepted.`);
  const unknown = headers.filter(h => !HEADER_ALIASES[FORBIDDEN_NORM(h)]);
  if (unknown.length) throw new LegalGuardError(`rejected: unknown CSV column(s) [${unknown.join(", ")}]. Allowed columns: station number, name, AC number, part number, location, lat, lon, source, asOf.`);
  const records: PollingStation[] = [], rejected: ImportResult["rejected"] = [];
  table.forEach((row, i) => {
    const raw: Record<string, unknown> = {};
    for (const [h, v] of Object.entries(row)) raw[HEADER_ALIASES[FORBIDDEN_NORM(h)]] = v;
    const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v === "" || v === undefined ? null : v);
    const rec = {
      stationNo: String(raw.stationNo ?? "").trim(), name: String(raw.name ?? "").trim(), acNo: num(raw.acNo), partNo: num(raw.partNo),
      location: String(raw.location ?? "").trim(), lat: num(raw.lat), lon: num(raw.lon),
      source: String(raw.source ?? "").trim() || ctx.source, asOf: String(raw.asOf ?? "").trim() || ctx.asOf,
    };
    const errs = validateStation(rec as unknown as Record<string, unknown>);
    if (errs.length) rejected.push({ row: i + 2, errors: errs }); else records.push(toReference(rec as PollingStation));
  });
  const dup = validateStations(records);
  if (dup.length) rejected.push({ row: 0, errors: dup });
  return { records, rejected, sha256, rows: table.length };
}
