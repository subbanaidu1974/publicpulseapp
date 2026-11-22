/**
 * Pulse Survey registry: shared types, policy loader and small helpers (DESIGN_2028 3.3).
 * Vocabulary rule (B1): survey copy says "Pulse Survey", "opinion", "responses", "figures".
 */
import fs from "node:fs";
import path from "node:path";

export const SURVEY_STATUSES = ["draft", "in_review", "approved", "open", "closed", "cancelled"] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];
export const TOPIC_CLASSES = ["issue_service", "bill", "political", "election_choice"] as const;
export type TopicClass = (typeof TOPIC_CLASSES)[number];
export const ORG_KINDS = ["party", "government", "civil_society", "media", "academic", "platform"] as const;
export type OrgKind = (typeof ORG_KINDS)[number];
export const QUESTION_KINDS = ["single", "multi", "scale5"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const SCOPE_UNIT_KEYS = ["district", "mandal", "village", "constituency", "ac_no"] as const;

export type ScopeUnits = Partial<Record<(typeof SCOPE_UNIT_KEYS)[number], string[]>>;
export interface Scope { state: string; units: ScopeUnits }

export interface OptionInput { label_en: string; label_te?: string | null; prefer_not?: boolean }
export interface QuestionInput { kind: QuestionKind; text_en: string; text_te?: string | null; max_select?: number | null; options?: OptionInput[] }

/** The frozen wording: exactly what is hashed (sha256 of canonical JSON) and snapshotted per registered version. */
export interface WordingSnapshot {
  title_en: string; title_te: string | null; topic_class: TopicClass; election_choice: boolean;
  creator_org_kind: OrgKind; creator_org_code: string | null; department: string | null;
  scope: Scope; opens_at: string; closes_at: string;
  questions: { kind: QuestionKind; max_select: number | null; text_en: string; text_te: string | null; options: { label_en: string; label_te: string | null; prefer_not: boolean }[] }[];
}

export interface SurveyRow {
  id: string; creator_pseudonym: string; creator_org_kind: OrgKind; creator_org_code: string | null; department: string | null;
  topic_class: TopicClass; election_choice: number; title_en: string; title_te: string | null; status: SurveyStatus;
  scope_state: string; scope_units: string; opens_at: string; closes_at: string; version: number; wording_hash: string;
  created_at: string; registered_at: string | null; approved_at: string | null; opened_at: string | null; closed_at: string | null; close_reason: string | null;
}

export interface Finding { code: string; severity: "block" | "warn"; where: string; text: string }

export interface Policy {
  limits: { max_questions: number; min_options: number; max_options: number; max_title_chars: number; max_question_chars: number; max_duration_days: number; max_scope_units: number; require_telugu_at_submit: boolean };
  panel: { min_approvals: number; min_reject_note_chars: number };
  cancellation: { reason_codes: string[]; min_reason_text_chars: number; max_reason_text_chars: number };
  quota: {
    window_days: number; count_as: Record<string, string>;
    kinds: Record<string, { per: "org_code" | "department" | "creator"; allowed: string[]; limits: Record<string, number | null>; needs_department?: boolean }>;
  };
  wording: {
    banned_framing_en: string[]; banned_framing_te: string[]; leading_en: string[]; leading_te: string[];
    double_barrelled: { conjunctions: string[]; stance_terms: string[] };
    party_preference: { verbs: string[]; nouns: string[] };
    severity: Record<string, "block" | "warn">;
  };
  scale5_labels: { en: string; te: string }[];
  prefer_not_label: { en: string; te: string };
  disclaimer: { en: string; te: string };
}

let cached: Policy | null = null;
export function policyPath(): string { return path.join(process.cwd(), "data", "civic", "survey-policy.json"); }
export function surveyPolicy(): Policy {
  if (!cached) cached = JSON.parse(fs.readFileSync(policyPath(), "utf8")) as Policy;
  return cached;
}
/** Tests only. */
export function resetSurveyPolicyCache(): void { cached = null; }

/** Disclaimer carried by every public survey payload. */
export const disclaimer = () => ({ disclaimer_en: surveyPolicy().disclaimer.en, disclaimer_te: surveyPolicy().disclaimer.te });

let clock: () => Date = () => new Date();
/** Registry clock (tests inject time; the election-window boundary tests rely on it). */
export const registryNow = (): Date => clock();
export function setRegistryClock(fn: (() => Date) | null): void { clock = fn ?? (() => new Date()); }

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Election-choice surveys: fail closed. Needs the env flag AND a verified-open window for the survey's state. */
export function electionChoiceFlag(env: NodeJS.ProcessEnv = process.env): boolean { return env.CIVIC_ELECTION_CHOICE_SURVEYS === "1"; }
