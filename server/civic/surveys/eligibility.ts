/**
 * Server-side eligibility for a Pulse Survey credential (S-29). Every rule here is enforced on the server; the client only displays the result.
 *
 *   1. authenticated person (the route uses requireAuth); an account IS an adult: minor dependents have no account (hh_member.status =
 *      'dependent' rows carry person_id NULL by constraint), so a dependent cannot reach this code;
 *   2. not a pending enrolment (volunteer-enrolled adult who has not yet proven phone control and set their own PIN);
 *   3. account age >= CIVIC_SURVEY_MIN_ACCOUNT_DAYS (default 14) from persons.created_at;
 *   4. trust tier >= T1 (a self-declared residence);
 *   5. the residence unit lies inside the survey scope (state, then district / mandal / village / constituency / ac_no units);
 *   6. number intelligence: a recycled number ('recently_reissued') is excluded; a VoIP number is admitted at REDUCED trust (quality
 *      'low': a different key class, so published figures can show it as its own stratum) instead of being excluded;
 *   7. the survey is open now. (One-response-per-person is the atomic has_responded insert in credential.ts.)
 *
 * The key class the person must use ('T1' | 'T2' | 'T1_LOW' | 'T2_LOW') is decided HERE, so the tier/quality stratum of a response is
 * server-verified, not client-asserted.
 */
import { getStore } from "../core";
import { ancestors, electionConstituency, getUnit, villageConstituencies } from "../geo/service";
import { PENDING_FLAG, getPerson, type PersonRow } from "../identity/service";
import { isOpenNow, type SurveyForResponse } from "./source";
import type { Scope } from "./types";

export type KeyClass = "T1" | "T2" | "T1_LOW" | "T2_LOW";
export const KEY_CLASSES: KeyClass[] = ["T1", "T2", "T1_LOW", "T2_LOW"];
export const tierOfClass = (k: KeyClass): "T1" | "T2" => (k.startsWith("T2") ? "T2" : "T1");
export const qualityOfClass = (k: KeyClass): "normal" | "low" => (k.endsWith("_LOW") ? "low" : "normal");

export const minAccountDays = (): number => {
  const v = Number(process.env.CIVIC_SURVEY_MIN_ACCOUNT_DAYS);
  return Number.isFinite(v) && process.env.CIVIC_SURVEY_MIN_ACCOUNT_DAYS !== undefined && process.env.CIVIC_SURVEY_MIN_ACCOUNT_DAYS !== "" ? Math.max(0, v) : 14;
};

export type IneligibleCode =
  | "survey_not_found" | "survey_not_open" | "person_not_found" | "pending_enrolment" | "account_too_new" | "tier_too_low"
  | "residence_missing" | "outside_scope" | "number_recycled";
export type EligibilityResult =
  | { ok: true; keyClass: KeyClass; tier: "T1" | "T2"; quality: "normal" | "low"; mandal: string | null }
  | { ok: false; code: IneligibleCode; status: number; message: string; eligible_from?: string };

const DAY = 86_400_000;
const flagsOf = (p: Pick<PersonRow, "flags">): string[] => { try { return JSON.parse(p.flags) as string[]; } catch { return []; } };

// ---- scope / geography ----
/** Last dash-separated segment: "DEMO-D-GNT" -> "GNT", "D-501" -> "501", "AC-3161" -> "3161", "3161" -> "3161". */
const tail = (code: string): string => String(code).split("-").pop() ?? "";
const listHas = (list: string[] | undefined, code: string): boolean => !!list?.some((x) => x === code || tail(x) === tail(code));

export function stateCodeOfUnit(lgd: string, asOf?: Date): string | null {
  for (const u of ancestors(lgd, asOf)) {
    if (u.level !== "state") continue;
    const t = tail(u.lgd).toUpperCase();
    if (t === "AP" || t === "28" || /andhra/i.test(u.name_en)) return "AP";
    if (t === "TG" || t === "36" || /telangana/i.test(u.name_en)) return "TG";
  }
  return null;
}
const hasUnits = (s: Scope): boolean => Object.values(s.units ?? {}).some((l) => Array.isArray(l) && l.length);

/** True when a VILLAGE lies inside the scope (state first, then the union of the listed units). */
export function villageInScope(village: string, scope: Scope, asOf?: Date): boolean {
  if (!getUnit(village, asOf)) return false;
  const chain = ancestors(village, asOf);
  const st = stateCodeOfUnit(village, asOf);
  if (!st || st !== scope.state) return false;
  if (!hasUnits(scope)) return true;
  const u = scope.units;
  if (chain.some((x) => x.level === "district" && listHas(u.district, x.lgd))) return true;
  if (chain.some((x) => x.level === "mandal" && listHas(u.mandal, x.lgd))) return true;
  if (listHas(u.village, village)) return true;
  if (u.constituency?.length || u.ac_no?.length) {
    for (const c of villageConstituencies(village, asOf)) {
      if (listHas(u.constituency, c.lgd)) return true;
      if (u.ac_no?.length) {
        const ec = electionConstituency(c.lgd, asOf);
        if (ec && u.ac_no.some((n) => String(n) === String(ec.acNo)) && ec.state === scope.state) return true;
      }
    }
  }
  return false;
}

/** True when a MANDAL has at least one village in the scope (the mandal stratum of a response must be a real mandal inside the survey). */
export function mandalInScope(mandal: string, scope: Scope): boolean {
  const m = getUnit(mandal);
  if (!m || m.level !== "mandal") return false;
  const st = stateCodeOfUnit(mandal);
  if (!st || st !== scope.state) return false;
  if (!hasUnits(scope)) return true;
  if (listHas(scope.units.mandal, mandal)) return true;
  if (ancestors(mandal).some((x) => x.level === "district" && listHas(scope.units.district, x.lgd))) return true;
  const kids = getStore("issues").prepare("SELECT DISTINCT lgd_code FROM admin_unit WHERE parent_lgd = ? AND level = 'village'").all(mandal) as { lgd_code: string }[];
  return kids.some((k) => villageInScope(k.lgd_code, scope));
}

/** Mandal (LGD code) containing the person's declared residence village, when known; used to prefill the mandal stratum. */
export function mandalOfResidence(unit: string | null): string | null {
  if (!unit) return null;
  const m = ancestors(unit).find((x) => x.level === "mandal");
  return m ? m.lgd : null;
}

export function checkEligibility(personId: string, survey: SurveyForResponse | null, now: Date = new Date()): EligibilityResult {
  if (!survey) return { ok: false, code: "survey_not_found", status: 404, message: "no such survey" };
  if (!isOpenNow(survey, now)) return { ok: false, code: "survey_not_open", status: 409, message: "this survey is not open for responses" };
  const p = getPerson(personId);
  if (!p) return { ok: false, code: "person_not_found", status: 401, message: "sign in again" };
  const flags = flagsOf(p);
  if (flags.includes(PENDING_FLAG)) return { ok: false, code: "pending_enrolment", status: 403, message: "finish activating your account (set your own PIN) before answering" };
  const eligibleFrom = new Date(new Date(p.created_at).getTime() + minAccountDays() * DAY);
  if (eligibleFrom.getTime() > now.getTime()) return { ok: false, code: "account_too_new", status: 403, message: "accounts can answer surveys after a waiting period", eligible_from: eligibleFrom.toISOString() };
  if (p.tier !== "T1" && p.tier !== "T2") return { ok: false, code: "tier_too_low", status: 403, message: "declare where you live (a village) to answer surveys" };
  if (!p.residence_unit) return { ok: false, code: "residence_missing", status: 403, message: "declare where you live (a village) to answer surveys" };
  if (!villageInScope(p.residence_unit, survey.scope, now)) return { ok: false, code: "outside_scope", status: 403, message: "this survey is for people living elsewhere" };
  if (flags.includes("recently_reissued")) return { ok: false, code: "number_recycled", status: 403, message: "this phone number was recently reissued; confirm it with a volunteer to answer" };
  // S-162: a number the intelligence vendor rated medium/high risk (ported, young prepaid, ...) is also admitted at reduced trust, in the *_LOW key class.
  const quality: "normal" | "low" = flags.includes("voip") || flags.includes("number_risk_medium") || flags.includes("number_risk_high") ? "low" : "normal";
  const keyClass = `${p.tier}${quality === "low" ? "_LOW" : ""}` as KeyClass;
  return { ok: true, keyClass, tier: p.tier, quality, mandal: mandalOfResidence(p.residence_unit) };
}

export type Ineligible = Extract<EligibilityResult, { ok: false }>;
export type Eligible = Extract<EligibilityResult, { ok: true }>;
/** Type guards (the project compiles without strictNullChecks, where boolean-literal unions do not narrow on their own). */
export const isIneligible = (e: EligibilityResult): e is Ineligible => !e.ok;
