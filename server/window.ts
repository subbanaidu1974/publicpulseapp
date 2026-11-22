/**
 * Calendar-driven, fail-closed election-window service (S-118, DESIGN_2028 3.3/3.5).
 *
 * windowState(state, now) -> "open" | "blackout" | "unknown"
 *  - blackout: now is inside a VERIFIED window [mccStart, end) for that state (model code of conduct to end of counting).
 *  - open:     the calendar declares coverage (coveredFrom..coveredThrough) containing `now` and no verified window contains it.
 *  - unknown:  everything else (no calendar, unreadable calendar, empty list, `now` outside coverage). Unknown fails closed.
 * Unverified and `example` entries are ignored: a date nobody confirmed never opens or closes anything.
 *
 * Policy (fail closed): election-choice surveys and notifications run only when the state is "open".
 * The forecast is hidden in blackout and in unknown, unless ELECTION_WINDOW_FAIL_OPEN_FORECAST=1.
 * Historical analytics are not subject to this policy.
 * FORECAST_BLACKOUT=1 forces blackout for every state (operator override); =0 forces open.
 */
import fs from "node:fs";
import path from "node:path";

export type WindowState = "open" | "blackout" | "unknown";

export interface CalendarEntry {
  state: string;
  label?: string;
  mccStart: string;
  pollDate?: string;
  countDate?: string;
  end: string;
  source: string;
  verified: boolean;
  example?: boolean;
}
export interface Calendar {
  schema: number;
  coveredFrom: string | null;
  coveredThrough: string | null;
  entries: CalendarEntry[];
}
interface Opts { calendar?: Calendar | null; env?: NodeJS.ProcessEnv }

const IST = "+05:30";

/** Date-only values are the start of that day in IST; anything else must be a full ISO instant. */
export function parseInstant(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00${IST}` : v;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function calendarPath(): string {
  return process.env.ELECTION_CALENDAR_FILE || path.join(process.cwd(), "data", "reference", "election-calendar.json");
}

/** Reads the calendar; null when missing or invalid (callers fail closed). */
export function loadCalendar(file: string = calendarPath()): Calendar | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) return null;
    return {
      schema: Number(raw.schema) || 1,
      coveredFrom: typeof raw.coveredFrom === "string" ? raw.coveredFrom : null,
      coveredThrough: typeof raw.coveredThrough === "string" ? raw.coveredThrough : null,
      entries: raw.entries as CalendarEntry[],
    };
  } catch { return null; }
}

export function windowState(state: string, now: Date = new Date(), opts: Opts = {}): WindowState {
  const env = opts.env ?? process.env;
  if (env.FORECAST_BLACKOUT === "1") return "blackout";
  if (env.FORECAST_BLACKOUT === "0") return "open";
  const cal = opts.calendar === undefined ? loadCalendar() : opts.calendar;
  if (!cal) return "unknown";
  const t = now.getTime();
  const from = cal.coveredFrom ? parseInstant(cal.coveredFrom) : null;
  const through = cal.coveredThrough ? parseInstant(cal.coveredThrough) : null;
  if (from === null || through === null || t < from || t >= through) return "unknown";
  const code = state.toUpperCase();
  for (const e of cal.entries) {
    if (e.example === true || e.verified !== true || String(e.state).toUpperCase() !== code) continue;
    const a = parseInstant(e.mccStart), b = parseInstant(e.end);
    if (a === null || b === null || b <= a) continue;
    if (t >= a && t < b) return "blackout";
  }
  return "open";
}

export interface ForecastDecision { show: boolean; state: WindowState; reason: "open" | "blackout" | "unknown" | "unknown-fail-open" }

export function forecastDecision(state: string, now: Date = new Date(), opts: Opts = {}): ForecastDecision {
  const env = opts.env ?? process.env;
  const w = windowState(state, now, opts);
  if (w === "open") return { show: true, state: w, reason: "open" };
  if (w === "blackout") return { show: false, state: w, reason: "blackout" };
  if (env.ELECTION_WINDOW_FAIL_OPEN_FORECAST === "1") return { show: true, state: w, reason: "unknown-fail-open" };
  return { show: false, state: w, reason: "unknown" };
}

/** Election-choice surveys and notifications: strictly fail closed (only "open" allows). */
export function surveysAllowed(state: string, now: Date = new Date(), opts: Opts = {}): boolean {
  return windowState(state, now, opts) === "open";
}
export const notificationsAllowed = surveysAllowed;
