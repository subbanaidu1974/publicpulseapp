/**
 * The seam between the credential/response code and the survey registry (agent A's tables). Everything the credential path needs to know
 * about a survey is this one shape; `getSurveyForResponse` is the only function that reads the registry, so a registry change touches
 * this file only. Tests install a fake with `setSurveySource`.
 */
import { getStore } from "../core";
import type { Scope, TopicClass } from "./types";

export interface ResponseQuestion {
  /** Stable id the response uses as the answer key. */
  id: string;
  kind: "single" | "multi" | "scale5";
  max_select: number | null;
  /** Allowed option ids (single/multi). A scale5 question is answered with an integer 1..5 or, when listed here, a "prefer not" option id. */
  options: string[];
  /** Display text (needed only by channels that read the question aloud). */
  text?: { text_en: string; text_te: string | null; option_labels: { id: string; label_en: string; label_te: string | null }[] };
}
export interface SurveyForResponse {
  id: string;
  status: string;
  topic_class: TopicClass;
  scope: Scope;
  opens_at: string;
  closes_at: string;
  wording_hash: string;
  questions: ResponseQuestion[];
}

export type SurveySource = (surveyId: string) => SurveyForResponse | null;
let override: SurveySource | null = null;
let registryLookup: SurveySource | null = null;

/** Tests (and any alternative registry) install a lookup; null restores the default. */
export function setSurveySource(fn: SurveySource | null): void { override = fn; }
/** Called by the registry module at load to plug itself in (kept as a seam so this file has no import cycle with it). */
export function registerRegistryLookup(fn: SurveySource): void { registryLookup = fn; }

export function getSurveyForResponse(surveyId: string): SurveyForResponse | null {
  if (override) return override(surveyId);
  return registryLookup ? registryLookup(surveyId) : null;
}

/** The survey is accepting credentials and responses now: status open and inside its window. */
export function isOpenNow(s: SurveyForResponse, now: Date): boolean {
  return s.status === "open" && s.opens_at <= now.toISOString() && now.toISOString() < s.closes_at;
}

let listOverride: (() => SurveyForResponse[]) | null = null;
export function setOpenSurveyList(fn: (() => SurveyForResponse[]) | null): void { listOverride = fn; }
/** Surveys currently open (any scope), for channels that pick a survey for the caller. */
export function listOpenSurveys(): SurveyForResponse[] { return listOverride ? listOverride() : registryOpenSurveys(); }

/** Default: open surveys from the registry tables (survey store, read only) with the question and option text a phone call needs. */
function registryOpenSurveys(): SurveyForResponse[] {
  if (!registryLookup) return [];
  const d = getStore("survey");
  try {
    const ids = d.prepare("SELECT id FROM surveys WHERE status = 'open'").all() as unknown as { id: string }[];
    const out: SurveyForResponse[] = [];
    for (const { id } of ids) {
      const s = registryLookup(id);
      if (!s || s.status !== "open") continue;
      for (const q of s.questions) {
        const t = d.prepare("SELECT text_en, text_te FROM survey_questions WHERE id = ?").get(q.id) as { text_en: string; text_te: string | null } | undefined;
        const labels = d.prepare("SELECT id, label_en, label_te FROM survey_options WHERE question_id = ? ORDER BY ord").all(q.id) as unknown as { id: string; label_en: string; label_te: string | null }[];
        if (t) q.text = { text_en: t.text_en, text_te: t.text_te, option_labels: labels };
      }
      out.push(s);
    }
    return out;
  } catch { return []; }
}
