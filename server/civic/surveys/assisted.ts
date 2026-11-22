/**
 * Assisted channels (S-31, DESIGN_2028 3.3 "secrecy is per channel"): voice/IVR (and any other channel that cannot do client-side crypto).
 * The SERVER stands in for the person: it checks eligibility for the PIN-verified caller, marks has_responded and stores the answers itself.
 * It therefore COULD link person and answer, and says so: these responses are labelled channel='assisted', platform_linkable=1, live in a
 * separate table (survey_response_assisted) and are published as a separate stratum, never merged into the anonymous app/web figures.
 *
 * Only issue/service topics and bills may be asked this way (ASSISTED_TOPICS). A political or election_choice survey is refused with 403
 * channel_not_allowed before anything else is checked.
 *
 * IVR conversation state is encoded in the call's `category` field ("svy:<surveyId>:<digits so far>"), which is persisted by the call
 * store (issues store, TTL minutes, encrypted person id). It holds the survey id and the keys pressed, never a person id or a PIN.
 */
import { getDb } from "../core";
import { checkEligibility, isIneligible, type EligibilityResult } from "./eligibility";
import { enqueueResponse, type Answers, type Strata } from "./responses";
import { getSurveyForResponse, listOpenSurveys, type ResponseQuestion, type SurveyForResponse } from "./source";
import { credentialClock } from "./credential";

export const ASSISTED_TOPICS = ["issue_service", "bill"] as const;
export const GUARANTEE_ASSISTED = "assisted_linkable";

export class AssistedRefused extends Error {
  constructor(public code: "channel_not_allowed" | "survey_not_found" | "already_responded" | IneligibleLike, public status: number, message: string) { super(message); }
}
type IneligibleLike = Extract<EligibilityResult, { ok: false }>["code"];

export const topicAllowedAssisted = (s: Pick<SurveyForResponse, "topic_class">): boolean => (ASSISTED_TOPICS as readonly string[]).includes(s.topic_class);
/** A survey can be read over the phone only when every question is single-choice or a 1-5 scale with at most 9 options. */
export const ivrReadable = (s: SurveyForResponse): boolean =>
  s.questions.length > 0 && s.questions.length <= 6 && s.questions.every((q) => (q.kind === "single" && q.options.length >= 2 && q.options.length <= 9) || q.kind === "scale5");

/** Open, phone-readable, assisted-eligible surveys this person may answer now and has not answered. */
export function listAssistedSurveys(personId: string, now: Date = credentialClock.now()): SurveyForResponse[] {
  return listOpenSurveys().filter((s) => topicAllowedAssisted(s) && ivrReadable(s) && checkEligibility(personId, s, now).ok && !hasRow(personId, s.id));
}
const hasRow = (personId: string, surveyId: string): boolean => !!getDb().prepare("SELECT 1 AS x FROM has_responded WHERE person_id = ? AND survey_id = ?").get(personId, surveyId);

/** Store one assisted response (final: one per person per survey). Throws AssistedRefused. */
export function submitAssisted(personId: string, surveyId: string, answers: Answers, now: Date = credentialClock.now()): void {
  const s = getSurveyForResponse(surveyId);
  if (!s) throw new AssistedRefused("survey_not_found", 404, "no such survey");
  if (!topicAllowedAssisted(s)) throw new AssistedRefused("channel_not_allowed", 403, "this topic cannot be answered by phone or with assistance; use the app");
  const e = checkEligibility(personId, s, now);
  if (isIneligible(e)) throw new AssistedRefused(e.code, e.status, e.message);
  const strata: Strata = { age_band: "NA", gender: "NS", tier: e.tier, quality: e.quality, mandal: e.mandal ?? "NA" };
  const ins = getDb().prepare("INSERT OR IGNORE INTO has_responded (person_id, survey_id, ts) VALUES (?,?,?)").run(personId, surveyId, now.toISOString().slice(0, 10));
  if (Number(ins.changes) !== 1) throw new AssistedRefused("already_responded", 409, "already answered; the answer is final");
  try { enqueueResponse({ survey_id: surveyId, answers, strata, kind: "assisted" }); }
  catch (x) { getDb().prepare("DELETE FROM has_responded WHERE person_id = ? AND survey_id = ?").run(personId, surveyId); throw x; } // not recorded: give the shot back
}

// ---- IVR driver ----
export type IvrSurveyStep =
  | { kind: "none" }
  | { kind: "ask"; state: string; notice: boolean; question: { index: number; of: number; text_en: string; text_te: string | null; digits: { digit: string; label_en: string; label_te: string | null }[] } }
  | { kind: "done" }
  | { kind: "refused"; code: string };

const STATE_RE = /^svy:([0-9a-fA-F-]{8,64}):(\d*)$/;
export const isSurveyIntent = (category: string | undefined): boolean => !!category && category.startsWith("svy");

const optionsFor = (q: ResponseQuestion): { id: string | number; digit: string; label_en: string; label_te: string | null }[] =>
  q.kind === "scale5"
    ? [1, 2, 3, 4, 5].map((n) => ({ id: n, digit: String(n), label_en: String(n), label_te: String(n) }))
    : q.options.map((id, i) => { const l = q.text?.option_labels.find((o) => o.id === id); return { id, digit: String(i + 1), label_en: l?.label_en ?? id, label_te: l?.label_te ?? null }; });

/**
 * Advance one IVR turn. `state` is the call's category ("svy" to start). `digits` is the key just pressed (undefined = (re)ask).
 * Returns the next category string to persist inside `ask`.
 */
export function ivrSurveyStep(personId: string, state: string, digits: string | undefined, now: Date = credentialClock.now()): IvrSurveyStep {
  let surveyId: string, keys: string;
  const m = STATE_RE.exec(state);
  if (m) { surveyId = m[1]; keys = m[2]; }
  else {
    const first = listAssistedSurveys(personId, now)[0];
    if (!first) return { kind: "none" };
    surveyId = first.id; keys = "";
  }
  const s = getSurveyForResponse(surveyId);
  if (!s) return { kind: "none" };
  if (!topicAllowedAssisted(s)) return { kind: "refused", code: "channel_not_allowed" };
  const qs = s.questions;
  if (digits !== undefined && keys.length < qs.length) {
    const opts = optionsFor(qs[keys.length]);
    if (opts.some((o) => o.digit === digits)) keys += digits; // an invalid key re-asks the same question
  }
  if (keys.length >= qs.length) {
    const answers: Answers = {};
    qs.forEach((q, i) => { answers[q.id] = optionsFor(q).find((o) => o.digit === keys[i])!.id as string | number; });
    try { submitAssisted(personId, surveyId, answers, now); } catch (x) { if (x instanceof AssistedRefused) return { kind: "refused", code: x.code }; throw x; }
    return { kind: "done" };
  }
  const q = qs[keys.length];
  return {
    kind: "ask", state: `svy:${surveyId}:${keys}`, notice: keys.length === 0 && !m,
    question: { index: keys.length + 1, of: qs.length, text_en: q.text?.text_en ?? `Question ${keys.length + 1}`, text_te: q.text?.text_te ?? null, digits: optionsFor(q).map((o) => ({ digit: o.digit, label_en: o.label_en, label_te: o.label_te })) },
  };
}
