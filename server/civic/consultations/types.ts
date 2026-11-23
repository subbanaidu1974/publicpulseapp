/**
 * Bill consultations: shared types, policy loader and small helpers (DESIGN_2028 3.6, S-35/S-36).
 * Vocabulary rule (B1): copy says "consultation", "feedback", "responses", "figures". A consultation is a signal, not a referendum.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { canonicalJson, getKeys } from "../core";
import type { Scope } from "../surveys/types";

export const CONSULTATION_STATUSES = ["draft", "in_review", "approved", "open", "closed", "completed"] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];
export const STANCES = ["support", "support_changes", "oppose", "unclear", "prefer_not"] as const;
export type Stance = (typeof STANCES)[number];

export interface AudioRef { group: string; file_id: string | null; duration_s: number; status: "placeholder" | "recorded" }
export interface ClauseContent { n: number; original_text: string | null; original_ref: string | null; summary_en: string; summary_te: string; audio: AudioRef[] }
/** The frozen, hashed content of one version. */
export interface ConsultationContent {
  title_en: string; title_te: string | null; department: string; bill_ref: string; source_url: string; scope: Scope;
  opens_at: string; closes_at: string; affected_groups: string[]; clauses: ClauseContent[];
}

export interface ConsultationRow {
  id: string; creator_pseudonym: string; department: string; title_en: string; title_te: string | null; bill_ref: string; source_url: string;
  status: ConsultationStatus; scope_state: string; scope_units: string; opens_at: string; closes_at: string; version: number; content_hash: string; draft_json: string;
  created_at: string; registered_at: string | null; approved_at: string | null; published_at: string | null; closed_at: string | null; completed_at: string | null; close_reason: string | null;
}

export interface Policy {
  limits: Record<string, number | boolean>;
  official_domain_suffixes: string[];
  panel: { min_approvals: number; min_reject_note_chars: number };
  stances: { id: Stance; en: string; te: string }[];
  report: { due_days: number };
  review_sample: { min: number; share: number };
  disclaimer: { en: string; te: string };
}
let cached: Policy | null = null;
export const policyPath = (): string => path.join(process.cwd(), "data", "civic", "consultation-policy.json");
export function consultationPolicy(): Policy {
  if (!cached) cached = JSON.parse(fs.readFileSync(policyPath(), "utf8")) as Policy;
  return cached;
}
export function resetConsultationPolicyCache(): void { cached = null; }
export const lim = (k: string): number => Number(consultationPolicy().limits[k]);
export const disclaimer = () => ({ disclaimer_en: consultationPolicy().disclaimer.en, disclaimer_te: consultationPolicy().disclaimer.te });

const num = (v: string | undefined, d: number, min = 0): number => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= min ? n : d; };
/** Tunables (env; defaults documented in .env.example). Read at call time so tests can change them. */
export const cfg = {
  reportDueDays: (): number => num(process.env.CONSULT_REPORT_DUE_DAYS, consultationPolicy().report.due_days, 1),
  perMinPerson: (): number => Math.floor(num(process.env.CONSULT_FEEDBACK_PER_MIN_PERSON, 60, 1)),
  perMinNet: (): number => Math.floor(num(process.env.CONSULT_FEEDBACK_PER_MIN_NET, 120, 1)),
  burstPerMin: (): number => Math.floor(num(process.env.CONSULT_BURST_PER_MIN, 100, 2)),
  dupThreshold: (): number => Math.min(1, Math.max(0.3, num(process.env.CONSULT_DUP_THRESHOLD, 0.8))),
  clusterFlagMin: (): number => Math.floor(num(process.env.CONSULT_CLUSTER_FLAG_MIN, 10, 2)),
};

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const trim = (v: unknown, max: number): string => str(v).replace(/\s+/g, " ").trim().slice(0, max);
export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
export const hashContent = (c: ConsultationContent): string => sha256(canonicalJson(c));
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const iso = (d: Date): string => d.toISOString();

export const fail = (res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void => { res.status(status).json({ error: code, code, ...extra }); };
export const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response): Promise<void> => {
  try { await fn(req, res); } catch (e) { if (!res.headersSent) fail(res, 500, "internal_error"); void e; }
};

/** Keyed pseudonyms (key purpose "survey-actor", the survey module's: no persons.id ever reaches the survey store). */
export const consultActor = (personId: string): string => getKeys().hmac("survey-actor", "consult-actor:" + personId);
/** One pseudonym per (consultation, person): the feedback row's owner. Attributable to the account only through the key. */
export const feedbackKey = (consultationId: string, personId: string): string => getKeys().hmac("survey-actor", `consult-fb:${consultationId}:${personId}`);
export const netKey = (consultationId: string, prefix: string): string => getKeys().hmac("survey-actor", `consult-net:${consultationId}:${prefix}`);

/** Network prefix of a caller: IPv4 /24, IPv6 /48. Never stored in clear (only keyed). */
export function netPrefix(ip: string | undefined): string {
  let a = String(ip || "").trim();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return a.split(".").slice(0, 3).join(".");
  if (a.includes(":")) {
    const [h, t = ""] = a.split("::");
    const head = h ? h.split(":") : [], tail = t ? t.split(":") : [];
    const full = a.includes("::") ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
    return full.slice(0, 3).map((x) => x.toLowerCase()).join(":");
  }
  return "unknown";
}
