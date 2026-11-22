/**
 * Cost model (S-152). Quantities come from scenario volumes (data/reference/cost-assumptions.json, ENGINEERING ASSUMPTIONS);
 * costs are computed only where a unit price is non-null. A null price is UNKNOWN: it is flagged and excluded from the total,
 * never guessed. Also checks the projected OTP load against the caps the code enforces.
 * Usage: tsx scripts/cost-model.ts [--scenario pilot|statewide|all] [--file path/to/assumptions.json] [--json]
 * Reads CIVIC_SMS_HOURLY_BUDGET (default 2000) and CIVIC_OTP_NET_LIMIT (default 60 per 10 minutes) like server/civic/identity/service.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface UnitPrice { value: number | null; unit: string; sourceUrl: string | null; verifiedOn: string | null; notes?: string }
export interface Scenario {
  label: string; basis: string; adultsReachable: number; signupRate: number; otpPerSignup: number; otpLoginsPerUserPerMonth: number;
  noticeSmsPerUserPerMonth: number; ivrShareOfUsers: number; ivrCallsPerIvrUserPerMonth: number; ivrMinutesPerCall: number;
  missedCallsPerUserPerMonth: number; issuesPerUserPerMonth: number; mediaMbPerIssue: number; kbPerUserPerMonthServed: number;
  peakDaySignupShare: number; peakHourShareOfPeakDay: number; peakNetworkSignupsPer10Min: number; numberIntelligenceLookupsPerSignup: number;
}
export interface Assumptions {
  unitPrices: Record<string, UnitPrice>;
  fixed: Record<string, { value: number; unit: string; basis: string }>;
  scenarios: Record<string, Scenario>;
}
export interface Line { item: string; quantity: number; unit: string; priceKey: string; unitPrice: number | null; cost: number | null; note?: string }
export interface Caps { hourlyBudget: number; networkLimitPer10Min: number; peakDayOtps: number; peakHourOtps: number; hoursToClearPeakDay: number; peakNetworkOtpsPer10Min: number; hourVerdict: string; networkVerdict: string }
export interface Result { scenario: string; label: string; users: number; lines: Line[]; knownTotal: number; unknownCount: number; caps: Caps }

/** A price counts as verified only with a value, a source URL and a verification date; otherwise it is UNKNOWN. */
export function effectivePrice(p: UnitPrice | undefined): number | null {
  if (!p || p.value === null || p.value === undefined) return null;
  if (!p.sourceUrl || !p.verifiedOn) return null;
  return p.value;
}

export function loadAssumptions(file?: string): Assumptions {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return JSON.parse(fs.readFileSync(file ?? path.join(root, "data/reference/cost-assumptions.json"), "utf8")) as Assumptions;
}

export function otpCaps(s: Scenario, users: number, env: Record<string, string | undefined> = process.env): Caps {
  const hourlyBudget = Number(env.CIVIC_SMS_HOURLY_BUDGET || 2000);
  const networkLimitPer10Min = Number(env.CIVIC_OTP_NET_LIMIT || 60);
  const peakDayOtps = users * s.peakDaySignupShare * s.otpPerSignup;
  const peakHourOtps = peakDayOtps * s.peakHourShareOfPeakDay;
  const peakNetworkOtpsPer10Min = s.peakNetworkSignupsPer10Min * s.otpPerSignup;
  return {
    hourlyBudget, networkLimitPer10Min, peakDayOtps, peakHourOtps, peakNetworkOtpsPer10Min,
    hoursToClearPeakDay: hourlyBudget > 0 ? peakDayOtps / hourlyBudget : Infinity,
    hourVerdict: peakHourOtps > hourlyBudget ? `EXCEEDS budget by ${Math.ceil(peakHourOtps - hourlyBudget)} OTP/h: signups would be refused or queued; raise CIVIC_SMS_HOURLY_BUDGET (a billing decision), stagger outreach, or accept the queue` : "within budget",
    networkVerdict: peakNetworkOtpsPer10Min > networkLimitPer10Min ? `EXCEEDS per-network cap (${networkLimitPer10Min}/10 min): a shared network (mandal office, kiosk, mobile CGNAT) would block people` : "within cap",
  };
}

export function compute(a: Assumptions, name: string, env: Record<string, string | undefined> = process.env): Result {
  const s = a.scenarios[name];
  if (!s) throw new Error(`unknown scenario ${name}`);
  const months = a.fixed.months.value;
  const users = Math.round(s.adultsReachable * s.signupRate);
  const logins = users * s.otpLoginsPerUserPerMonth * months;
  const otps = users * s.otpPerSignup + logins;
  const issues = users * s.issuesPerUserPerMonth * months;
  const gb = (issues * s.mediaMbPerIssue) / 1024;
  const lines: Line[] = [];
  const add = (item: string, quantity: number, unit: string, priceKey: string, note?: string) => {
    const unitPrice = effectivePrice(a.unitPrices[priceKey]);
    lines.push({ item, quantity: Math.round(quantity * 100) / 100, unit, priceKey, unitPrice, cost: unitPrice === null ? null : unitPrice * quantity, note });
  };
  add("SMS OTP (signup + login)", otps, "SMS", "smsOtpPerMessage");
  add("SMS notices and references", users * s.noticeSmsPerUserPerMonth * months, "SMS", "smsNoticePerMessage");
  add("DLT registration", 1, "one-off", "dltRegistrationOneOff");
  add("IVR minutes", users * s.ivrShareOfUsers * s.ivrCallsPerIvrUserPerMonth * s.ivrMinutesPerCall * months, "minutes", "ivrPerMinute");
  add("IVR number rental", months, "months", "ivrNumberRentalPerMonth");
  add("Missed calls", users * s.missedCallsPerUserPerMonth * months, "calls", "missedCallPerCall");
  add("Hosting compute (India region)", months, "months", "hostingComputePerMonth");
  add("Storage incl. backups (linear growth)", (gb * (months + 1)) / 2, "GB-months", "storagePerGbMonth", `${gb.toFixed(1)} GB of issue media at month ${months}`);
  add("Egress", (users * s.kbPerUserPerMonthServed * months) / (1024 * 1024), "GB", "egressPerGb");
  add("KMS keys", a.fixed.kmsPurposeKeys.value * months, "key-months", "kmsPerKeyMonth");
  add("KMS requests (one per signup and per login)", (users + logins) / 10000, "x10k requests", "kmsPer10kRequests");
  add("Dedicated HSM (only if managed KMS is not accepted)", months, "months", "hsmPerMonth", "alternative to the KMS lines; do not add both without a decision");
  add("Number intelligence", users * s.numberIntelligenceLookupsPerSignup, "lookups", "numberIntelligencePerLookup");
  add("Audio recording", a.fixed.ivrPromptsToRecord.value * a.fixed.dialects.value, "prompt-dialects", "audioPerPromptPerDialect");
  add("Linguist review", a.fixed.dialects.value, "dialects", "linguistReviewPerDialect");
  add("Independent red team", a.fixed.redTeamEngagements.value, "engagements", "redTeamEngagement");
  add("Counsel retainer", months, "months", "counselRetainerPerMonth");
  add("Counsel one-off review", a.fixed.counselOneOffReviews.value, "reviews", "counselOneOffReview");
  const known = lines.filter((l) => l.cost !== null);
  return {
    scenario: name, label: s.label, users, lines,
    knownTotal: known.reduce((t, l) => t + (l.cost ?? 0), 0),
    unknownCount: lines.length - known.length,
    caps: otpCaps(s, users, env),
  };
}

const n = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-IN") : "inf");

export function renderMarkdown(r: Result): string {
  const out = [
    `### Scenario: ${r.scenario} - ${r.label}`, "",
    `Signed-up users (assumed): ${n(r.users)}. Money is INR over the assumed period. UNKNOWN = no verified unit price; excluded from the total.`, "",
    "| Item | Quantity | Unit | Unit price | Cost |", "|---|---:|---|---:|---:|",
    ...r.lines.map((l) => `| ${l.item}${l.note ? ` (${l.note})` : ""} | ${n(l.quantity)} | ${l.unit} | ${l.unitPrice === null ? "UNKNOWN" : l.unitPrice} | ${l.cost === null ? "UNKNOWN" : n(l.cost)} |`),
    "", `Total of known lines: ${n(r.knownTotal)} INR. Lines with UNKNOWN price: ${r.unknownCount} of ${r.lines.length}. **The total is NOT a budget while any line is UNKNOWN.**`, "",
    "OTP load against code caps:", "",
    `- Peak-day OTPs: ${n(r.caps.peakDayOtps)}; peak-hour OTPs: ${n(r.caps.peakHourOtps)} vs CIVIC_SMS_HOURLY_BUDGET ${n(r.caps.hourlyBudget)}: ${r.caps.hourVerdict}. Hours to clear the peak day at the budget rate: ${r.caps.hoursToClearPeakDay.toFixed(1)}.`,
    `- Busiest network, OTPs per 10 minutes: ${n(r.caps.peakNetworkOtpsPer10Min)} vs CIVIC_OTP_NET_LIMIT ${n(r.caps.networkLimitPer10Min)}: ${r.caps.networkVerdict}.`, "",
  ];
  return out.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const a = loadAssumptions(arg("--file"));
  const which = arg("--scenario") ?? "all";
  const names = which === "all" ? Object.keys(a.scenarios) : [which];
  const results = names.map((nm) => compute(a, nm));
  console.log(process.argv.includes("--json") ? JSON.stringify(results, null, 2) : results.map(renderMarkdown).join("\n"));
}
