/**
 * Wording checks (leading/loaded questions) and the independent wording panel rules (DESIGN_2028 3.3, decision A4).
 * The lists live in data/civic/survey-policy.json so the panel (not the engineers) can change them in review.
 */
import fs from "node:fs";
import path from "node:path";
import { hasRole, listRolesDetailed } from "../core";
import { surveyPolicy } from "./types";
import type { Finding, OrgKind, QuestionInput, TopicClass, WordingSnapshot } from "./types";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive match for Latin phrases; plain substring for Telugu (no word boundaries there). */
function hasWord(text: string, w: string): boolean {
  if (/[^\x00-\x7f]/.test(w)) return text.includes(w);
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc(w).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

let partyCodes: string[] | null = null;
function parties(): string[] {
  if (!partyCodes) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "reference", "parties.json"), "utf8")) as { parties: { code: string }[] };
      partyCodes = j.parties.map((p) => p.code).filter((c) => c !== "NOTA" && c !== "IND");
    } catch { partyCodes = []; }
  }
  return partyCodes;
}
export const partyCodeList = (): string[] => [...parties(), "IND", "NOTA"];
export const isPartyCode = (c: string): boolean => parties().includes(c.toUpperCase());

/** True when the text asks a person to choose or prefer a party or candidate. */
export function asksPartyPreference(text: string): boolean {
  const pp = surveyPolicy().wording.party_preference;
  const verb = pp.verbs.some((v) => hasWord(text, v));
  if (!verb) return false;
  if (pp.nouns.some((n) => hasWord(text, n))) return true;
  return parties().some((c) => new RegExp(`(?<![A-Za-z])${esc(c)}(?![A-Za-z])`).test(text));
}

function doubleBarrelled(text: string): boolean {
  const db = surveyPolicy().wording.double_barrelled;
  for (const c of db.conjunctions) {
    const re = c === "&" ? /\s&\s/ : new RegExp(`\\s${esc(c)}\\s`, "i");
    const m = re.exec(text);
    if (!m) continue;
    const left = text.slice(0, m.index), right = text.slice(m.index + m[0].length);
    const stance = (s: string) => db.stance_terms.some((t) => hasWord(s, t));
    if (stance(left) && stance(right)) return true;
  }
  return false;
}

/** Findings for one piece of text. */
function textFindings(where: string, text: string, isQuestion: boolean): Finding[] {
  const w = surveyPolicy().wording;
  const out: Finding[] = [];
  const add = (code: string, hit: string) => out.push({ code, severity: w.severity[code] ?? "block", where, text: hit });
  for (const b of [...w.banned_framing_en, ...w.banned_framing_te]) if (hasWord(text, b)) { add("banned_framing", b); break; }
  for (const l of [...w.leading_en, ...w.leading_te]) if (hasWord(text, l)) { add("leading", l); break; }
  if (isQuestion && doubleBarrelled(text)) add("double_barrelled", text.slice(0, 80));
  return out;
}

/** All wording findings for a draft (title, questions, option labels). `block` findings stop submission. */
export function checkWording(title_en: string, title_te: string | null, questions: QuestionInput[]): Finding[] {
  const out: Finding[] = [...textFindings("title", title_en, false)];
  if (title_te) out.push(...textFindings("title_te", title_te, false));
  questions.forEach((q, i) => {
    out.push(...textFindings(`q${i + 1}`, q.text_en, true));
    if (q.text_te) out.push(...textFindings(`q${i + 1}_te`, q.text_te, true));
    (q.options ?? []).forEach((o, j) => out.push(...textFindings(`q${i + 1}.o${j + 1}`, o.label_en, false)));
  });
  return out;
}

/** Does any text in the survey ask for a party or candidate preference? */
export function detectsPartyPreference(title_en: string, questions: QuestionInput[]): boolean {
  return asksPartyPreference(title_en) || questions.some((q) => asksPartyPreference(q.text_en) || (q.options ?? []).some((o) => parties().some((c) => c === o.label_en.trim().toUpperCase())));
}

/** Political and election-choice surveys must give every question a "prefer not to say" option. Returns the 1-based question numbers missing it. */
export function missingPreferNot(topic: TopicClass, election: boolean, questions: { options?: { prefer_not?: boolean }[] }[]): number[] {
  if (topic !== "political" && topic !== "election_choice" && !election) return [];
  return questions.map((q, i) => ((q.options ?? []).some((o) => o.prefer_not) ? 0 : i + 1)).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

/** Organisation tags of a person (roles held), used for the creator/reviewer conflict rule. Tag = "kind:code". */
export function orgTagsOf(personId: string): string[] {
  const tags = new Set<string>();
  for (const r of listRolesDetailed(personId)) {
    const dept = (r.department ?? "").trim();
    if (r.role === "politician") tags.add(`party:${dept.toUpperCase()}`);
    else if (r.role === "officer") tags.add(`government:${dept}`);
    else if (r.role === "journalist") tags.add(`media:${dept}`);
    else if (r.role === "survey_panel" && dept) {
      // a panel seat carries its nominating organisation: a party code, or one of the org kinds, or "kind:code"
      if (dept.includes(":")) tags.add(dept.includes(":") ? dept.split(":").map((x, i) => (i === 0 ? x.toLowerCase() : x)).join(":") : dept);
      else if (isPartyCode(dept)) tags.add(`party:${dept.toUpperCase()}`);
      else tags.add(`${dept.toLowerCase()}:`);
    }
  }
  return [...tags];
}

export const orgTag = (kind: OrgKind, code: string | null): string => {
  if (kind === "party") return `party:${(code ?? "").toUpperCase()}`;
  return `${kind}:${code ?? ""}`;
};

/** Reviewer conflict: the creator themself, or anyone sharing the creator's organisation. */
export function reviewerConflict(reviewerId: string, reviewerPseudonym: string, creatorPseudonym: string, creatorKind: OrgKind, creatorCode: string | null, creatorDepartment: string | null): string | null {
  if (reviewerPseudonym === creatorPseudonym) return "creator";
  const mine = orgTagsOf(reviewerId);
  const theirs = creatorKind === "government" ? `government:${creatorDepartment ?? creatorCode ?? ""}` : orgTag(creatorKind, creatorCode);
  if (mine.includes(theirs)) return "same_org";
  // kind-level match for orgs without a code (media, academic, civil society, platform): a panel seat "civil_society" cannot review a civil-society creator without a code
  if (creatorKind !== "party" && creatorKind !== "government" && !creatorCode && mine.some((t) => t.startsWith(creatorKind + ":"))) return "same_org";
  return null;
}

export const canReview = (personId: string): boolean => hasRole(personId, "admin") || hasRole(personId, "survey_panel");

/** Canonical wording for hashing. */
export function buildSnapshot(s: Omit<WordingSnapshot, "questions"> & { questions: WordingSnapshot["questions"] }): WordingSnapshot { return s; }
