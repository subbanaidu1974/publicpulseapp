/**
 * Notification policy, content linter, pre-cleared templates and the MCC gate (S-38 anti-phishing, S-39 MCC mode).
 * Policy: data/civic/notify-policy.json. Templates: data/reference/mcc-templates.json (EXAMPLES ONLY, cleared_by null = not cleared).
 */
import fs from "node:fs";
import path from "node:path";
import { loadCalendar, windowState, type Calendar, type WindowState } from "../../window";

export interface CapPair { daily: number; weekly: number }
export interface NotifyPolicy {
  categories: string[];
  category_labels: Record<string, { en: string; te: string }>;
  org_kinds: Record<string, { categories: string[]; sender_roles: string[] }>;
  sender_roles: string[];
  approvals: { standard: number; emergency_template: number; emergency_free_text: number };
  caps: Record<string, CapPair>;
  sender_caps: { per_org_per_hour: number; per_org_per_day: number; emergency_exempt: boolean };
  quiet_hours: { default_start: string; default_end: string; timezone: string; bypass: string[] };
  sms_fallback: { always_for: string[]; otherwise_only_if_person_opted_in_to_sms: boolean };
  limits: { title_chars: number; text_chars: number; slot_chars: number; reason_chars_min: number; max_audience: number; message_ttl_hours: number; antiphish_min: number; antiphish_max: number };
  webauthn: { challenge_ttl_s: number; require_user_verification: boolean; challenge_rate_per_10min: number };
  allowed_link_domains: string[];
  mcc: { unknown_blocks: string[]; declaration: { text_en: string; text_te: string; min_reason_chars: number } };
}
let cachedPolicy: NotifyPolicy | null = null;
export const policyFile = (): string => path.join(process.cwd(), "data", "civic", "notify-policy.json");
export function notifyPolicy(): NotifyPolicy { if (!cachedPolicy) cachedPolicy = JSON.parse(fs.readFileSync(policyFile(), "utf8")) as NotifyPolicy; return cachedPolicy; }
/** Tests only: replace (or clear with null) the cached policy. */
export function setNotifyPolicy(p: NotifyPolicy | null): void { cachedPolicy = p; }

// ---------------------------------------------------------------------------------------------
// Content linter: a notification never asks for OTP, PIN, password, login, payment, or links outside the allow-list.
// ---------------------------------------------------------------------------------------------

export interface LintHit { rule: string; detail?: string }
const strip = (s: string): string => s.normalize("NFKC").replace(/[​-‏⁠﻿­]/g, "");

const RULES: { rule: string; re: RegExp }[] = [
  { rule: "otp", re: /\bo[\s.\-_*]*t[\s.\-_*]*p\b/i },
  { rule: "otp", re: /\bone[\s-]*time[\s-]*(password|pass\s*code|code|pin)\b/i },
  { rule: "pin", re: /\bp[\s.\-_*]*i[\s.\-_*]*n\b/i },
  { rule: "password", re: /\b(pass\s*word|pass\s*code|passphrase|cvv|mpin|upi\s*pin)\b/i },
  { rule: "login", re: /\b(log\s*-?\s*in|sign\s*-?\s*in|login|credentials?)\b/i },
  { rule: "click_here", re: /\b(click|tap)\s+(here|the\s+link|below)\b/i },
  { rule: "payment", re: /\b(pay(ment|ments)?|upi|net\s*banking|credit\s*card|debit\s*card|card\s*(number|details)|bank\s*(account|details)|ifsc|kyc)\b/i },
  { rule: "identity_number", re: /\b(aadhaar|aadhar)\s*(number|no\.?|card)\b/i },
  { rule: "share_code", re: /\b(share|send|tell|give|enter|reply\s*with)\b[^.\n]{0,40}\b(code|number|otp|pin)\b/i },
  // Telugu equivalents (draft list; needs a native-speaker review)
  { rule: "otp", re: /(ఓటీపీ|ఒటిపి|ఓ\.?టి\.?పి)/ },
  { rule: "pin", re: /(పిన్|పిన్‌)/ },
  { rule: "password", re: /(పాస్\s*‌?వర్డ్|పాస్‌?వర్డ్|పాస్‌వర్డ్|పాస్వర్డ్|రహస్య\s*సంఖ్య)/ },
  { rule: "login", re: /(లాగిన్|లాగ్\s*ఇన్|సైన్\s*ఇన్)/ },
  { rule: "click_here", re: /(ఇక్కడ\s*(క్లిక్|నొక్క)|క్లిక్\s*చేయండి|నొక్కండి)/ },
  { rule: "payment", re: /(చెల్లింపు|చెల్లించ|యూపీఐ|కార్డ్\s*నంబర్|బ్యాంక్?ు?\s*(ఖాతా|వివరాల)|క్రెడిట్\s*కార్డ్|డెబిట్\s*కార్డ్)/ },
  { rule: "identity_number", re: /(ఆధార్\s*(నంబర్|సంఖ్య))/ },
];

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')]+|(?:[a-z0-9-]+\.)+(?:com|in|org|net|co|io|app|link|ly|xyz|info|biz|me|tk|top|online|site|click|live|store|cc|gl|page|dev|ai|gov|nic|edu)\b(?:\/[^\s<>"')]*)?)/gi;

function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes("xn--") || h.includes("@")) return false;
  return allow.some((d) => h === d || h.endsWith("." + d));
}

/** Lints text that will reach a person. Returns the hits (empty = clean). Rule names only, never the matched text in logs. */
export function lintContent(texts: string[], allow: string[] = notifyPolicy().allowed_link_domains): LintHit[] {
  const hits: LintHit[] = [];
  for (const raw of texts) {
    const t = strip(raw);
    for (const r of RULES) if (r.re.test(t)) hits.push({ rule: r.rule });
    for (const m of t.matchAll(URL_RE)) {
      const u = m[1];
      const httpsOk = !/^http:\/\//i.test(u);
      const host = u.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
      if (!httpsOk || !hostAllowed(host, allow)) hits.push({ rule: "link_not_allowed", detail: host });
    }
  }
  const seen = new Set<string>();
  return hits.filter((h) => { const k = h.rule + "|" + (h.detail ?? ""); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------------------------------------------------------------------------------------------
// Pre-cleared templates
// ---------------------------------------------------------------------------------------------

export interface MccTemplate {
  id: string; category: string; text_en: string; text_te: string; slots: Record<string, { max: number }>;
  cleared_by: string | null; cleared_on: string | null; source: string; example?: boolean;
}
let cachedTemplates: MccTemplate[] | null = null;
export const templatesFile = (): string => process.env.NOTIFY_MCC_TEMPLATES_FILE || path.join(process.cwd(), "data", "reference", "mcc-templates.json");
export function mccTemplates(): MccTemplate[] {
  if (!cachedTemplates) {
    try { cachedTemplates = (JSON.parse(fs.readFileSync(templatesFile(), "utf8")).templates ?? []) as MccTemplate[]; } catch { cachedTemplates = []; }
  }
  return cachedTemplates;
}
/** Tests only. */
export function setMccTemplates(t: MccTemplate[] | null): void { cachedTemplates = t; }
/** Cleared = a named authority and a real date, and not an example entry. Anything else is unusable in an MCC window. */
export const isCleared = (t: MccTemplate): boolean => !!t.cleared_by && !!t.cleared_on && /^\d{4}-\d{2}-\d{2}$/.test(t.cleared_on) && t.example !== true;
export const findTemplate = (id: string): MccTemplate | undefined => mccTemplates().find((t) => t.id === id);

/** Fill a template; every slot must be supplied, within its length, and no unknown slots. Returns null on any mismatch. */
export function renderTemplate(t: MccTemplate, slots: Record<string, unknown>): { en: string; te: string } | null {
  const names = Object.keys(t.slots);
  const given = Object.keys(slots ?? {});
  if (given.some((g) => !names.includes(g))) return null;
  const maxAll = notifyPolicy().limits.slot_chars;
  for (const n of names) {
    const v = (slots ?? {})[n];
    if (typeof v !== "string" || !v.trim() || v.length > Math.min(t.slots[n].max, maxAll) || /[{}\n\r]/.test(v)) return null;
  }
  const fill = (s: string) => s.replace(/\{([a-z0-9_]+)\}/gi, (_m, n: string) => String((slots as Record<string, string>)[n] ?? ""));
  return { en: fill(t.text_en), te: fill(t.text_te) };
}

// ---------------------------------------------------------------------------------------------
// MCC gate
// ---------------------------------------------------------------------------------------------

let calendarOverride: Calendar | null | undefined;
/** Tests only: a fake calendar (null = unreadable calendar -> unknown; undefined = real file). */
export function setNotifyCalendar(c: Calendar | null | undefined): void { calendarOverride = c; }
export function notifyWindow(state: string, district: string | null | undefined, now: Date): WindowState {
  const cal = calendarOverride === undefined ? loadCalendar() : calendarOverride;
  const s = windowState(state, now, { calendar: cal });
  if (s === "unknown" || !district) return s;
  // District-level entries use the key "<STATE>:<DISTRICT>" in the same calendar file. A blackout on either level wins.
  return windowState(`${state}:${district}`, now, { calendar: cal }) === "blackout" ? "blackout" : s;
}

export interface Declaration { accepted: boolean; reason: string; text_hash?: string }
export type MccBlockReason = "mcc_unknown_window" | "mcc_not_precleared" | "mcc_template_not_cleared" | "mcc_declaration_missing";
export interface MccInput { category: string; state: string; district?: string | null; templateId?: string | null; declaration?: Declaration | null; now: Date }
export interface MccDecision { allowed: boolean; window: WindowState; reason?: MccBlockReason }

export function mccGate(i: MccInput): MccDecision {
  const p = notifyPolicy();
  const window = notifyWindow(i.state, i.district, i.now);
  const declared = !!i.declaration && i.declaration.accepted === true && (i.declaration.reason ?? "").trim().length >= p.mcc.declaration.min_reason_chars;
  if (window === "open") return { allowed: true, window };
  if (i.category === "emergency") return declared ? { allowed: true, window } : { allowed: false, window, reason: "mcc_declaration_missing" };
  if (window === "unknown") return p.mcc.unknown_blocks.includes(i.category) ? { allowed: false, window, reason: "mcc_unknown_window" } : { allowed: true, window };
  // blackout: only a pre-cleared template of this category, plus the sender's self-declaration
  const t = i.templateId ? findTemplate(i.templateId) : undefined;
  if (!t || t.category !== i.category) return { allowed: false, window, reason: "mcc_not_precleared" };
  if (!isCleared(t)) return { allowed: false, window, reason: "mcc_template_not_cleared" };
  if (!declared) return { allowed: false, window, reason: "mcc_declaration_missing" };
  return { allowed: true, window };
}
