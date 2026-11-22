/**
 * Layered content moderation for issue reports (S-27, DESIGN_2028 3.4).
 *
 * Layer 1  normalisation: NFKC, zero-width and diacritic stripping, homoglyph and leetspeak folding, merging of
 *          letter-by-letter spacing ("b r i b e"), collapsing repeated letters and common Telugu transliteration
 *          variants (aa/a, th/t, w/v ...), Telugu digits to ASCII.
 * Layer 2  lexicon rules (data/civic/moderation-lexicon.json, Telugu + English + transliteration): titles followed by a
 *          name, honorific suffixes (garu), accusations, caste/religion targeting, abuse, personal identifiers.
 * Layer 3  named-individual heuristics: capitalised multi-word names that are not known places, and a capitalised
 *          word next to an accusation.
 * Layer 4  hold-for-review default: any signal, text we cannot analyse (unsupported script, mostly symbols) or a missing
 *          lexicon HOLDS the report. Nothing here auto-rejects; a held report is invisible publicly, appealable, and a
 *          moderator releases or takes it down.
 *
 * Reasons returned are rule ids only; the text itself is never copied into the reasons or logs.
 */
import fs from "node:fs";
import path from "node:path";

export interface LexiconChange { version: number; date: string; op: "add" | "retire" | "initial"; list?: string; term?: string; change_id?: string; approvals?: number; note?: string }
export interface Lexicon {
  version: number;
  changelog?: LexiconChange[];
  honorifics: { en: string[]; te: string[] };
  roleTitles: { en: string[]; te: string[] };
  personSuffix: { en: string[]; te: string[] };
  introducers: { en: string[]; te: string[] };
  accusations: { en: string[]; te: string[]; translit?: string[] };
  communityTargeting: { en: string[]; te: string[]; translit?: string[] };
  abuse: { en: string[]; te: string[]; translit?: string[] };
  allowCapitalised: string[];
  stopAfterTitle: string[];
}

export type Severity = "strong" | "weak";
export interface Signal { rule: string; severity: Severity }
export interface Assessment { verdict: "ok" | "hold"; reasons: string[]; signals: Signal[] }
export interface AssessOptions { knownNames?: string[]; lexicon?: Lexicon }

let cached: Lexicon | null = null;
/** Lexicon file: CIVIC_LEXICON_FILE, else data/civic/moderation-lexicon.json. Curation (./curation) edits this file and bumps its version. */
export const lexiconPath = () => path.resolve(process.env.CIVIC_LEXICON_FILE || path.join(process.cwd(), "data/civic/moderation-lexicon.json"));
export function loadLexicon(file = lexiconPath()): Lexicon {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Lexicon;
}
export function resetLexiconCache(): void { cached = null; }
function lexicon(): Lexicon | null {
  if (cached) return cached;
  try { cached = loadLexicon(); return cached; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Layer 1: normalisation
// ---------------------------------------------------------------------------------------------

const HOMOGLYPHS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g", ⅼ: "l",
  А: "A", Е: "E", О: "O", Р: "P", С: "C", Х: "X", І: "I", Ѕ: "S",
  α: "a", ο: "o", ν: "v", ι: "i", ρ: "p", τ: "t", υ: "u", κ: "k", Α: "A", Ο: "O", Ν: "N", Ι: "I", Κ: "K", Τ: "T",
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i", "+": "t", "|": "i", "€": "e", "£": "l" };
const TELUGU_DIGITS = "౦౧౨౩౪౫౬౭౮౯";

export interface Word { orig: string; low: string; sk: string; sentenceStart: boolean; telugu: boolean }

/** Phonetic skeleton for Latin words so transliteration variants and doubled letters collide. */
export function skeleton(w: string): string {
  if (!/^[a-z]+$/.test(w)) return w;
  return w
    .replace(/(.)\1+/g, "$1")
    .replace(/(th|dh|kh|bh|gh|ph|sh|ch)/g, (m) => m[0])
    .replace(/w/g, "v").replace(/q/g, "k").replace(/c/g, "k").replace(/z/g, "j").replace(/x/g, "ks")
    .replace(/(.)\1+/g, "$1");
}

/** Cleaned text (case preserved) before word splitting; also used for identifier detection. */
export function cleanText(raw: string): string {
  let s = String(raw ?? "").normalize("NFKC");
  s = s.replace(/[​-‏⁠﻿­‪-‮]/g, "");
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC"); // Latin diacritics only; Telugu marks are outside this range
  s = s.replace(/[^\u0000-\u007fఀ-౿\s]/g, (c) => HOMOGLYPHS[c] ?? c);
  s = s.replace(/[౦-౯]/g, (c) => String(TELUGU_DIGITS.indexOf(c)));
  return s;
}

export function toWords(raw: string): Word[] {
  let s = cleanText(raw);
  // letter-by-letter spacing: "b r i b e", "m.r.o", "l-a-n-c-h-a-m"
  s = s.replace(/(?<![\p{L}\p{N}])(?:[A-Za-z][\s.\-_*,'·|/]+){2,}[A-Za-z]\.?(?![\p{L}\p{N}])/gu, (m) => {
    const j = m.replace(/[\s.\-_*,'·|/]+/g, "");
    return /^[aiAI]/.test(j) && j.length >= 5 ? `${j} ${j.slice(1)}` : j; // "a b r i b e": also offer the word without the article
  });
  s = s.replace(/(?<![ఀ-౿])(?:[ఀ-౿][\s.\-_*,'·|/]+){2,}[ఀ-౿](?![ఀ-౿])/g, (m) => m.replace(/[\s.\-_*,'·|/]+/g, ""));
  s = s.replace(/\b(mr|mrs|ms|dr|smt|sri|shri|st|no|prof)\.(?=\s)/gi, "$1"); // abbreviation dots are not sentence ends
  // sentence boundaries survive tokenisation as a sentinel
  s = s.replace(/[.!?।\n]+(?=\s|$)/g, " ¶ ");
  const out: Word[] = [];
  let start = true;
  for (const m of s.matchAll(/¶|[^\s¶]+/gu)) {
    const tok = m[0];
    if (tok === "¶") { start = true; continue; }
    // leetspeak only inside tokens that already contain letters; strip inner separators ("br.ibe", "bri_be")
    let t = tok.replace(/(?<=[\p{L}\p{M}])[.\-_*'·](?=[\p{L}\p{M}])/gu, "");
    if (/\p{L}/u.test(t) && /[\p{L}]{2,}|\p{L}[0-9@$!+|]|[0-9@$!+|€£]\p{L}/u.test(t)) {
      t = t.replace(/[0-9@$!+|€£]/g, (c) => LEET[c] ?? c);
    }
    for (const part of t.split(/[^\p{L}\p{M}\p{N}]+/u)) {
      if (!part) continue;
      const low = part.toLowerCase();
      out.push({ orig: part, low, sk: skeleton(low), sentenceStart: start, telugu: /[ఀ-౿]/.test(part) });
      start = false;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layer 2: lexicon matching
// ---------------------------------------------------------------------------------------------

interface Term { words: string[]; prefix: boolean }
const compile = (list: string[] | undefined): Term[] => (list ?? []).map((t) => {
  const words = toWords(t).map((w) => w.sk);
  const joined = words.join("");
  return { words, prefix: joined.length >= 5 || /[ఀ-౿]/.test(joined) };
}).filter((t) => t.words.length);
const wordMatches = (w: string, term: string, prefix: boolean) => (prefix ? w.startsWith(term) : w === term);

function findAll(words: Word[], terms: Term[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const t of terms) {
      if (i + t.words.length > words.length) continue;
      let ok = true;
      for (let k = 0; k < t.words.length; k++) if (!wordMatches(words[i + k].sk, t.words[k], t.prefix && k === t.words.length - 1)) { ok = false; break; }
      if (ok) { hits.push(i); break; }
    }
  }
  return hits;
}
/** Compact match for splits inside a word ("bri be", "lan cham"): long Latin terms only. */
function compactHit(words: Word[], terms: Term[]): boolean {
  return terms.some((t) => {
    const j = t.words.join("");
    if (j.length < 5 || !/^[a-z]+$/.test(j)) return false;
    for (let i = 0; i < words.length; i++) {
      let acc = "";
      for (let n = 0; n < 3 && i + n < words.length; n++) {
        const w = words[i + n];
        if (w.telugu || !/^[a-z]+$/.test(w.sk)) break;
        acc += w.sk;
        if (n > 0 && wordMatches(acc, j, t.prefix) && acc.length - words[i + n].sk.length < j.length) return true; // a real split: the first piece alone is shorter than the term
      }
    }
    return false;
  });
}

const compiled = new WeakMap<Lexicon, Record<string, Term[]>>();
function terms(lx: Lexicon): Record<string, Term[]> {
  let c = compiled.get(lx);
  if (!c) {
    c = {
      honorific: compile([...lx.honorifics.en, ...lx.honorifics.te]),
      role: compile([...lx.roleTitles.en, ...lx.roleTitles.te]),
      suffix: compile([...lx.personSuffix.en, ...lx.personSuffix.te]),
      introUnconditional: compile([...lx.introducers.en.filter((x) => x !== "named" && x !== "called"), ...lx.introducers.te]),
      introNamed: compile(lx.introducers.en.filter((x) => x === "named" || x === "called")),
      accusation: compile([...lx.accusations.en, ...lx.accusations.te, ...(lx.accusations.translit ?? [])]),
      community: compile([...lx.communityTargeting.en, ...lx.communityTargeting.te, ...(lx.communityTargeting.translit ?? [])]),
      abuse: compile([...lx.abuse.en, ...lx.abuse.te, ...(lx.abuse.translit ?? [])]),
    };
    compiled.set(lx, c);
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------------------------

export function assessText(text: string, opts: AssessOptions = {}): Assessment {
  const signals: Signal[] = [];
  const add = (rule: string, severity: Severity) => { if (!signals.some((s) => s.rule === rule)) signals.push({ rule, severity }); };
  const raw = String(text ?? "");
  const lx = opts.lexicon ?? lexicon();
  if (!lx) add("lexicon_unavailable", "weak"); // fail closed: hold for review

  // personal identifiers (phone, Aadhaar-like, email)
  const clean = cleanText(raw);
  const digitsJoined = clean.replace(/(?<=\d)[\s-]+(?=\d)/g, "");
  if (/(?<!\d)(?:\+?91)?[6-9]\d{9}(?!\d)/.test(digitsJoined) || /(?<!\d)\d{12}(?!\d)/.test(digitsJoined) || /[\w.+-]+\s*@\s*[\w-]+\.[a-z]{2,}/i.test(clean)) add("personal_identifier", "strong");

  const words = toWords(raw);

  // text we cannot analyse
  const visible = [...clean].filter((c) => !/\s/.test(c));
  if (visible.length >= 8) {
    const known = visible.filter((c) => /[A-Za-zఀ-౿0-9]/.test(c)).length;
    const letters = visible.filter((c) => /[A-Za-zఀ-౿]/.test(c)).length;
    if (visible.filter((c) => /\p{L}/u.test(c) && !/[A-Za-zఀ-౿]/.test(c)).length / visible.length > 0.2) add("unsupported_script", "weak");
    else if (known / visible.length < 0.7 && letters / visible.length < 0.5) add("unsupported_or_obfuscated_text", "weak");
  }

  if (lx) {
    const T = terms(lx);
    const stop = new Set(lx.stopAfterTitle.map((x) => x.toLowerCase()));
    const allow = new Set([...lx.allowCapitalised, ...(opts.knownNames ?? []).flatMap((n) => toWords(n).map((w) => w.low))].map((x) => x.toLowerCase()));
    const isName = (w: Word | undefined) => !!w && !stop.has(w.low) && (w.telugu || (/^[A-Z][a-z]{1,}$/.test(w.orig) && !allow.has(w.low)));
    const capName = (w: Word | undefined) => !!w && !w.telugu && /^[A-Z][a-z]{1,}$/.test(w.orig) && !allow.has(w.low) && !stop.has(w.low);

    // titles and honorifics followed by a name
    for (const i of findAll(words, T.honorific)) if (isName(words[i + 1]) && !words[i + 1].sentenceStart) add("honorific_name", "strong");
    for (const i of findAll(words, T.role)) if (capName(words[i + 1]) && !words[i + 1].sentenceStart) add("role_named", "strong");
    for (const i of findAll(words, T.suffix)) if (i > 0 && !stop.has(words[i - 1].low) && !words[i].sentenceStart) add("person_suffix", "strong");
    for (const i of findAll(words, T.introUnconditional)) { void i; add("introduces_name", "weak"); }
    for (const i of findAll(words, T.introNamed)) if (isName(words[i + 1])) add("introduces_name", "strong");

    // named individual: run of 2+ capitalised non-place words (skipped for Title Case text)
    const latin = words.filter((w) => !w.telugu && /^[A-Za-z]+$/.test(w.orig));
    const titleCase = latin.length >= 4 && latin.filter((w) => /^[A-Z]/.test(w.orig)).length / latin.length > 0.6;
    let run = 0, singles = 0;
    for (const w of words) {
      if (w.sentenceStart) run = 0;
      if (capName(w)) { run++; if (run === 2) add(titleCase ? "title_case_text" : "possible_full_name", titleCase ? "weak" : "strong"); if (!w.sentenceStart) singles++; }
      else run = 0;
    }
    if (titleCase) signals.splice(0, signals.length, ...signals.filter((s) => s.rule !== "title_case_text"));

    const accused = findAll(words, T.accusation).length > 0 || compactHit(words, T.accusation);
    const personish = signals.some((s) => s.severity === "strong" && s.rule !== "personal_identifier") || singles > 0 || findAll(words, T.role).length > 0 || findAll(words, T.honorific).length > 0;
    if (accused) add(personish ? "accusation_with_person" : "accusation", personish ? "strong" : "weak");
    if (findAll(words, T.community).length || compactHit(words, T.community)) add("community_targeting", "strong");
    if (findAll(words, T.abuse).length || compactHit(words, T.abuse)) add("abusive_language", "strong");
  }

  return { verdict: signals.length ? "hold" : "ok", reasons: signals.map((s) => s.rule), signals };
}

/** Back-compatible boolean: true when the text must be held for human review. */
export function needsReview(text: string, opts?: AssessOptions): boolean { return assessText(text, opts).verdict === "hold"; }
