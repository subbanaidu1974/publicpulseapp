/**
 * Assisted participation (S-49) configuration. The feature is OFF unless an operator turns it on on purpose:
 *
 *   ASSISTED_ENABLED=1           required (default 0)
 *   ASSISTED_SUNSET_DATE=YYYY-MM-DD   required to enable; the feature switches itself off after the end of that day (UTC)
 *   kill switch                  persisted, under dual control (two admins, each with a TOTP code): see ./switch.ts
 *
 * Everything else is tuning with safe defaults. Read per call so tests and operators can change env without a restart.
 * docs/ASSISTED_PARTICIPATION.md has the meaning of each value.
 */
import { getStore } from "../core";

const num = (name: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== "" ? Math.min(max, Math.max(min, v)) : def;
};

export const pairDailyCap = () => Math.floor(num("ASSISTED_PAIR_DAILY_CAP", 15, 1, 1000));
export const villageDailyCap = () => Math.floor(num("ASSISTED_VILLAGE_DAILY_CAP", 40, 1, 10000));
/** Share of records re-checked at random once a pair is past its first records. */
export const recheckSample = () => num("ASSISTED_RECHECK_SAMPLE", 0.2, 0, 1);
/** The first N records of a new pair are all re-checked. */
export const recheckNewPairN = () => Math.floor(num("ASSISTED_RECHECK_NEW_PAIR_N", 10, 0, 1000));
export const recheckDays = () => Math.floor(num("ASSISTED_RECHECK_DAYS", 7, 1, 90));
/** Auto-suspend when not_confirmed / (confirmed + not_confirmed) is strictly above this, after at least `minChecked` checked records. */
export const suspendThreshold = () => num("ASSISTED_SUSPEND_THRESHOLD", 0.25, 0, 1);
export const suspendMinChecked = () => Math.floor(num("ASSISTED_SUSPEND_MIN_CHECKED", 5, 1, 1000));
/** Per-assistant request rate (records and receipt lookups), per minute. */
export const assistantPerMinute = () => Math.floor(num("ASSISTED_RATE_PER_MIN", 20, 1, 1000));
export const receiptAttemptsPerHour = () => Math.floor(num("ASSISTED_RECEIPT_ATTEMPTS_PER_HOUR", 30, 1, 10000));

/** Alert thresholds shown in the reviewer and admin views (they never act on their own; auto-suspension has its own threshold above). */
export const alertUnconfirmedRate = () => num("ASSISTED_ALERT_UNCONFIRMED_RATE", 0.25, 0, 1);
export const alertMinChecked = () => Math.floor(num("ASSISTED_ALERT_MIN_CHECKED", 5, 1, 1000));
export const alertShare = () => num("ASSISTED_ALERT_SHARE", 0.3, 0, 1);
export const alertShareDays = () => Math.floor(num("ASSISTED_ALERT_DAYS", 7, 1, 90));
export const alertShareMinIssues = () => Math.floor(num("ASSISTED_ALERT_MIN_ISSUES", 5, 1, 100000));

/** Sunset date as the last UTC day the feature runs, or null when missing or malformed (which keeps the feature off). */
export function sunsetDate(): string | null {
  const v = (process.env.ASSISTED_SUNSET_DATE ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(v + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

export interface AssistedState { env: boolean; sunset: string | null; sunsetPassed: boolean; killed: boolean; on: boolean; reason: "ok" | "env_off" | "no_sunset" | "sunset_passed" | "kill_switch" }

/** Is the persisted kill switch engaged? The latest approved switch request decides ('disable' engages, 'enable' lifts). */
export function killSwitchEngaged(): boolean {
  try {
    const r = getStore("issues").prepare("SELECT action FROM assisted_switch_request WHERE status='approved' AND action IN ('disable','enable') ORDER BY decided_at DESC, rowid DESC LIMIT 1").get() as { action: string } | undefined;
    return r?.action === "disable";
  } catch { return true; } // table missing: fail closed
}

export function assistedState(now: Date = new Date()): AssistedState {
  const env = process.env.ASSISTED_ENABLED === "1";
  const sunset = sunsetDate();
  const sunsetPassed = !!sunset && now.getTime() >= Date.parse(sunset + "T00:00:00Z") + 86_400_000;
  const killed = env ? killSwitchEngaged() : false;
  const reason = !env ? "env_off" : !sunset ? "no_sunset" : sunsetPassed ? "sunset_passed" : killed ? "kill_switch" : "ok";
  return { env, sunset, sunsetPassed, killed, on: reason === "ok", reason };
}

/** True when assisted reports may be shown and recorded now. */
export const assistedOn = (now?: Date): boolean => assistedState(now).on;
/** Whether existing assisted reports may be shown publicly (same rule: when the feature is off, the segment disappears). */
export const assistedVisible = assistedOn;
