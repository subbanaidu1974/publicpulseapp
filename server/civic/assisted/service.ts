/**
 * Assisted participation service (S-49, docs/ASSISTED_PARTICIPATION.md). Two enrolled volunteers, both signed in on the request, record an
 * issue for a consenting adult who is present. The record carries channel 'assisted', a pair id and a village, and NOTHING about the adult.
 */
import { randomInt, randomUUID } from "node:crypto";
import { audit, auditPrivilegedRead, getDb, getKeys, getStore, hasRole, listRolesDetailed, runInStore } from "../core";
import { actorPseudonym } from "../core/pseudonyms";
import { rateAllow } from "../identity/service";
import { getUnit } from "../geo/service";
import { CATEGORIES, HttpError, assessText, clock, inUnit, placeNames } from "../issues/service";
import { createPlaceResolver, sanitizeDescription } from "../issues/public";
import * as cfg from "./config";
import { villageHeld } from "./controls";
import "./store";

const idb = () => getStore("issues");
const iso = (d: Date) => d.toISOString();
const err = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) => new HttpError(status, message, { code, ...extra });

/** Random draw for the re-check sample; tests replace it. */
const defaultRng = () => randomInt(0, 1_000_000) / 1_000_000;
let rng: () => number = defaultRng;
export function setAssistedRandom(fn: (() => number) | null): void { rng = fn ?? defaultRng; }

// ---------- who is who ----------
/** Person behind a session token (the second assistant authenticates with their own token on the same request). Does not touch the session. */
export function personFromToken(token: string): string | null {
  if (!token) return null;
  try {
    const row = getDb().prepare(
      `SELECT p.id AS id, s.expires_at AS exp FROM sessions s JOIN persons p ON p.id = s.person_id WHERE s.token_hash = ? AND p.deleted_at IS NULL`)
      .get(getKeys().hmac("session", token)) as { id: string; exp: string } | undefined;
    return row && row.exp >= new Date().toISOString() ? row.id : null;
  } catch { return null; }
}

/** Does the person hold the role with a grant that reaches the village (an empty grant reaches everywhere)? */
export function roleReaches(personId: string, role: "assist_coordinator" | "assist_reviewer", village: string): boolean {
  if (!hasRole(personId, role)) return false;
  return listRolesDetailed(personId).filter((g) => g.role === role).some((g) => !g.jurisdiction || inUnit(village, g.jurisdiction));
}
export const isAdmin = (p: string) => hasRole(p, "admin");

interface PairRow { reinstated_at?: string | null; suspended_by?: string | null; id: string; village_lgd: string; label: string | null; member_a: string; member_b: string; formed_by: string; status: string; suspended_reason: string | null; suspended_at: string | null; created_at: string }
export const pairById = (id: string) => idb().prepare("SELECT * FROM assist_pair WHERE id=?").get(id) as unknown as PairRow | undefined;
export const isMember = (p: PairRow, personId: string) => { const a = actorPseudonym(personId); return p.member_a === a || p.member_b === a; };
const activePairOf = (personId: string) => {
  const a = actorPseudonym(personId);
  return idb().prepare("SELECT * FROM assist_pair WHERE status='active' AND (member_a=? OR member_b=?) LIMIT 1").get(a, a) as unknown as PairRow | undefined;
};

// ---------- pairs ----------
export function createPair(coordinator: string, b: { village_lgd?: unknown; member_a?: unknown; member_b?: unknown; label?: unknown }, now = clock.now()) {
  const village = typeof b.village_lgd === "string" ? getUnit(b.village_lgd, now) : null;
  if (!village || village.level !== "village") throw err(400, "village_lgd must be a valid village", "invalid_village");
  if (!roleReaches(coordinator, "assist_coordinator", village.lgd)) throw err(403, "you are not a coordinator for this village", "outside_scope");
  const a = typeof b.member_a === "string" ? b.member_a.trim() : "", c = typeof b.member_b === "string" ? b.member_b.trim() : "";
  if (!a || !c) throw err(400, "two volunteers are required", "two_assistants_required");
  if (a === c) throw err(400, "the two assistants must be different people", "two_assistants_required");
  if (a === coordinator || c === coordinator) throw err(403, "a coordinator cannot be a member of a pair they form", "coordinator_not_member");
  for (const m of [a, c]) {
    const p = getDb().prepare("SELECT 1 AS x FROM persons WHERE id=? AND deleted_at IS NULL").get(m);
    if (!p) throw err(404, "volunteer not found", "volunteer_not_found");
    if (!hasRole(m, "volunteer")) throw err(409, "each assistant must be an enrolled volunteer", "not_a_volunteer");
    if (activePairOf(m)) throw err(409, "this volunteer is already in an active pair", "already_paired");
  }
  const label = typeof b.label === "string" ? (sanitizeDescription(b.label, 60) ?? null) : null;
  const id = randomUUID();
  runInStore("issues", () => {
    idb().prepare("INSERT INTO assist_pair (id,village_lgd,label,member_a,member_b,formed_by,status,created_at) VALUES (?,?,?,?,?,?,'active',?)")
      .run(id, village.lgd, label, actorPseudonym(a), actorPseudonym(c), actorPseudonym(coordinator), iso(now));
    audit(coordinator, "assisted.pair.create", `pair:${id}`, { village: village.lgd });
  });
  return { id, village_lgd: village.lgd, label, status: "active" };
}

export function pairStats(id: string) {
  const d = idb();
  const n = (sql: string) => (d.prepare(sql).get(id) as { c: number }).c;
  const records = n("SELECT COUNT(*) c FROM assisted_record WHERE pair_id=?");
  const confirmed = n("SELECT COUNT(*) c FROM assisted_record WHERE pair_id=? AND recheck_state='confirmed'");
  const notConfirmed = n("SELECT COUNT(*) c FROM assisted_record WHERE pair_id=? AND recheck_state='not_confirmed'");
  const unreachable = n("SELECT COUNT(*) c FROM assisted_record WHERE pair_id=? AND recheck_state='unreachable'");
  const queued = n("SELECT COUNT(*) c FROM assisted_record WHERE pair_id=? AND recheck_state='queued'");
  const checked = confirmed + notConfirmed;
  return { records, queued, confirmed, not_confirmed: notConfirmed, unreachable, checked, not_confirmed_rate: checked ? Math.round((notConfirmed / checked) * 1000) / 1000 : null };
}

/** Coordinators and reviewers see the pairs whose village their grant reaches; admins see all. Members are never named (only pseudonyms are stored). */
export function listPairs(actor: string) {
  if (!isAdmin(actor) && !hasRole(actor, "assist_coordinator") && !hasRole(actor, "assist_reviewer")) throw err(403, "coordinator or reviewer role required", "role_required");
  const rows = idb().prepare("SELECT * FROM assist_pair ORDER BY created_at DESC LIMIT 500").all() as unknown as PairRow[];
  const admin = isAdmin(actor);
  const mine = rows.filter((p) => admin || roleReaches(actor, "assist_coordinator", p.village_lgd) || roleReaches(actor, "assist_reviewer", p.village_lgd));
  auditPrivilegedRead(actor, "assisted:pairs", "list assisted pairs");
  const place = createPlaceResolver();
  return {
    pairs: mine.map((p) => ({
      id: p.id, village: place(p.village_lgd).village ?? { lgd: p.village_lgd, name_en: p.village_lgd, name_te: null }, label: p.label, status: p.status, suspended_reason: p.suspended_reason,
      created_at: p.created_at, suspended_at: p.suspended_at, ...pairStats(p.id),
    })),
  };
}

export function suspendCore(pair: PairRow, by: string, reason: string, now: Date) {
  idb().prepare("UPDATE assist_pair SET status='suspended', suspended_reason=?, suspended_by=?, suspended_at=? WHERE id=? AND status='active'").run(reason, by, iso(now), pair.id);
}

export function suspendPair(actor: string, pairId: string, reasonIn: unknown, now = clock.now()) {
  const pair = pairById(pairId);
  if (!pair) throw err(404, "pair not found", "not_found");
  const ok = isAdmin(actor) || roleReaches(actor, "assist_coordinator", pair.village_lgd) || roleReaches(actor, "assist_reviewer", pair.village_lgd);
  if (!ok) throw err(403, "not allowed for this pair", "outside_scope");
  const reason = typeof reasonIn === "string" ? reasonIn.trim() : "";
  if (reason.length < 5 || reason.length > 300) throw err(400, "a reason of 5 to 300 characters is required", "reason_required");
  if (pair.status !== "active") return { id: pair.id, status: pair.status, already: true };
  runInStore("issues", () => { suspendCore(pair, actorPseudonym(actor), reason, now); audit(actor, "assisted.pair.suspend", `pair:${pair.id}`, { reason }); });
  return { id: pair.id, status: "suspended" };
}

/** For the signed-in volunteer: are they in an active pair, and where? (The partner is never named.) */
export function myPair(personId: string) {
  const p = activePairOf(personId);
  if (!p) return { in_pair: false as const };
  const v = createPlaceResolver()(p.village_lgd).village;
  return { in_pair: true as const, pair_id: p.id, village: v ?? { lgd: p.village_lgd, name_en: p.village_lgd, name_te: null }, label: p.label, status: p.status };
}

// ---------- the content linter for assisted entries ----------
const PARTY_EN = /\b(party|parties|candidates?|mla|mp|minister|elections?|campaign|manifesto|polling|voters?|votes?|voting|ballot|tdp|ysrcp|ycp|bjp|congress|janasena|jsp|brs|trs|cpi|cpm|aimim)\b/i;
const PARTY_TE = /(పార్టీ|అభ్యర్థి|ఎమ్మెల్యే|ఎంపీ|మంత్రి|ఎన్నిక|ప్రచారం|మేనిఫెస్టో|ఓటు|వోటు|ఓటర్|వోటర్|తెలుగుదేశం|టీడీపీ|వైసీపీ|వైఎస్సార్సీపీ|బీజేపీ|కాంగ్రెస్|జనసేన|బీఆర్ఎస్)/;
export const mentionsPartyOrCandidate = (text: string): boolean => PARTY_EN.test(text) || PARTY_TE.test(text);

// ---------- recording ----------
const FORBIDDEN_FIELDS = ["name", "person_name", "full_name", "phone", "mobile", "msisdn", "aadhaar", "aadhar", "dob", "age", "address", "person_id", "voter_id", "email", "photo_ref", "voice_ref", "lat", "lon", "gps"];
export const CONSENT_TICKS = ["adult", "explained", "willing_self", "deletion_known"] as const;
const RECEIPT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newReceiptCode = (): string => { let s = ""; for (let i = 0; i < 12; i++) s += RECEIPT_ALPHABET[randomInt(0, RECEIPT_ALPHABET.length)]; return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`; };
export const normaliseReceipt = (code: unknown): string => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const receiptHash = (code: unknown): string => getKeys().hmac("assist-receipt", normaliseReceipt(code));

function checkConsent(label: string, v: unknown) {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const missing = CONSENT_TICKS.filter((k) => o[k] !== true);
  if (missing.length) throw err(422, `consent ticks missing for assistant ${label}`, "consent_required", { assistant: label, missing });
}

export interface RecordInput { category?: unknown; description_en?: unknown; description_te?: unknown; village_lgd?: unknown; adult_attested?: unknown; consent_a?: unknown; consent_b?: unknown; [k: string]: unknown }

export function recordIssue(a: string, b: string, body: RecordInput, now = clock.now()) {
  if (!a || !b || a === b) throw err(401, "two different signed-in assistants are required", "two_assistants_required");
  if (!rateAllow("assist:" + a, cfg.assistantPerMinute(), 60_000, now.getTime())) throw err(429, "too many requests; wait a minute", "rate_limited");
  const d = idb();
  const stored = d.prepare("SELECT * FROM assist_pair WHERE (member_a=? AND member_b=?) OR (member_a=? AND member_b=?) LIMIT 1").get(actorPseudonym(a), actorPseudonym(b), actorPseudonym(b), actorPseudonym(a)) as unknown as PairRow | undefined;
  if (!stored) throw err(403, "these two people are not a formed pair", "not_a_pair");
  if (stored.status !== "active") throw err(403, "this pair is suspended", "pair_suspended");
  if (villageHeld(stored.village_lgd)) throw err(403, "assisted recording is paused for this village", "village_suspended");

  for (const k of FORBIDDEN_FIELDS) if (k in body) throw err(400, `field "${k}" is not accepted: nothing about the person is recorded`, "personal_field_not_allowed", { field: k });
  if (body.minor === true || body.adult_attested !== true) throw err(422, "both assistants must attest that the person is an adult (18 or over)", "adult_required");
  checkConsent("a", body.consent_a); checkConsent("b", body.consent_b);

  const cat = CATEGORIES[String(body.category)];
  if (!cat) throw err(400, "unknown category", "unknown_category", { categories: Object.keys(CATEGORIES) });
  const en = typeof body.description_en === "string" ? body.description_en.trim() : "";
  const te = typeof body.description_te === "string" ? body.description_te.trim() : "";
  if (!en && !te) throw err(400, "description_en or description_te required", "description_required");
  if (en.length > 2000 || te.length > 2000) throw err(400, "description too long", "description_too_long");
  if (body.village_lgd !== undefined && body.village_lgd !== stored.village_lgd) throw err(403, "this pair records for its own village only", "outside_pair_village");
  const village = getUnit(stored.village_lgd, now);
  if (!village || village.level !== "village") throw err(400, "the pair's village is no longer valid", "invalid_village");

  const dayAgo = iso(new Date(now.getTime() - 86_400_000));
  const pairToday = (d.prepare("SELECT COUNT(*) c FROM assisted_record WHERE pair_id=? AND created_at>=?").get(stored.id, dayAgo) as { c: number }).c;
  if (pairToday >= cfg.pairDailyCap()) throw err(429, "this pair has reached its daily limit", "pair_daily_cap", { limit: cfg.pairDailyCap() });
  const villageToday = (d.prepare("SELECT COUNT(*) c FROM assisted_record WHERE village_lgd=? AND created_at>=?").get(stored.village_lgd, dayAgo) as { c: number }).c;
  if (villageToday >= cfg.villageDailyCap()) throw err(429, "this village has reached its daily limit for assisted records", "village_daily_cap", { limit: cfg.villageDailyCap() });

  const text = `${en}\n${te}`;
  const verdict = assessText(text, { knownNames: placeNames(village, now) });
  const topic = mentionsPartyOrCandidate(text);
  const reasons = [...(verdict.verdict === "hold" ? verdict.reasons : []), ...(topic ? ["party_or_candidate_topic"] : [])];
  const held = reasons.length > 0;

  const priorRecords = (d.prepare("SELECT COUNT(*) c FROM assisted_record WHERE pair_id=?").get(stored.id) as { c: number }).c;
  const risky = !!d.prepare("SELECT 1 x FROM assisted_record WHERE pair_id=? AND (flagged=1 OR recheck_state='not_confirmed') LIMIT 1").get(stored.id);
  const sampled = priorRecords < cfg.recheckNewPairN() || risky || rng() < cfg.recheckSample();

  const code = newReceiptCode();
  const issueId = randomUUID(), t = iso(now);
  runInStore("issues", () => {
    d.prepare(`INSERT INTO issue (id,category,desc_en,desc_te,village_lgd,department,status,moderation,moderation_reason,reporter_id,created_at,updated_at,sla_due,jurisdiction_lgd,channel)
      VALUES (?,?,?,?,?,?,'Reported',?,?,'assisted',?,?,?,?,'assisted')`)
      .run(issueId, String(body.category), en || null, te || null, village.lgd, cat.department, held ? "held" : "ok", held ? reasons.join(",") : null, t, t, iso(new Date(now.getTime() + cat.slaHours * 3600_000)), village.lgd);
    d.prepare("INSERT INTO assisted_record (issue_id,pair_id,village_lgd,consent_by_a,consent_by_b,consent_at,receipt_code_hash,recheck_state,recheck_due,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(issueId, stored.id, village.lgd, actorPseudonym(a), actorPseudonym(b), t, receiptHash(code), sampled ? "queued" : "not_sampled", sampled ? iso(new Date(now.getTime() + cfg.recheckDays() * 86_400_000)) : null, t);
    if (!held) d.prepare("INSERT INTO issue_event (issue_id,type,status,village_lgd,category,department,at) VALUES (?,?,?,?,?,?,?)").run(issueId, "reported", "Reported", village.lgd, String(body.category), cat.department, t);
    audit(a, held ? "assisted.record_held" : "assisted.record", `issue:${issueId}`, { pair: stored.id, village: village.lgd, partner: actorPseudonym(b), held, reasons: held ? reasons : undefined, sampled });
  });
  return { id: issueId, channel: "assisted" as const, held, status: "Reported", receipt_code: code, receipt_note: "Shown once. Give it to the person on paper; it cannot be shown again.", recheck_queued: sampled, pair_id: stored.id };
}

// ---------- receipts (the person's only handle; no account, no phone) ----------
function receiptRecord(code: unknown, ip: string, now: Date) {
  if (!rateAllow("assist-receipt:" + ip, cfg.receiptAttemptsPerHour(), 3_600_000, now.getTime()) || !rateAllow("assist-receipt:all", cfg.receiptAttemptsPerHour() * 40, 3_600_000, now.getTime())) throw err(429, "too many attempts; try later", "rate_limited");
  const n = normaliseReceipt(code);
  if (n.length !== 12) throw err(404, "receipt not found", "receipt_not_found");
  const r = idb().prepare("SELECT * FROM assisted_record WHERE receipt_code_hash=?").get(receiptHash(n)) as { issue_id: string; pair_id: string; village_lgd: string; recheck_state: string; flagged: number; deleted_at: string | null; created_at: string } | undefined;
  if (!r) throw err(404, "receipt not found", "receipt_not_found");
  return r;
}

export function receiptStatus(code: unknown, ip: string, now = clock.now()) {
  const r = receiptRecord(code, ip, now);
  const i = idb().prepare("SELECT category, status, moderation, updated_at FROM issue WHERE id=?").get(r.issue_id) as { category: string; status: string; moderation: string; updated_at: string };
  return {
    channel: "assisted" as const, deleted: !!r.deleted_at, state: r.deleted_at ? "deleted" : i.moderation === "ok" ? "published" : "held_for_review",
    category: r.deleted_at ? null : i.category, status: i.status, village_lgd: r.village_lgd, created_at: r.created_at, updated_at: i.updated_at, reported_for_review: !!r.flagged,
  };
}

/** Deletion by the person (paper receipt): the words are erased; the row stays as a stub so counts and the audit trail still add up. Idempotent. */
export function deleteByReceipt(code: unknown, ip: string, now = clock.now()) {
  const r = receiptRecord(code, ip, now);
  if (r.deleted_at) return { deleted: true, already: true };
  eraseRecord(r.issue_id, r.pair_id, "receipt", "receipt", now);
  return { deleted: true, already: false };
}

/** Erase the words of a record and keep a stub (counts, audit). `via`: the paper receipt, or two-person approval for a lost receipt. */
export function eraseRecord(issueId: string, pairId: string, auditActor: string, via: "receipt" | "approved_request", now: Date) {
  const r = { issue_id: issueId, pair_id: pairId };
  const t = iso(now);
  runInStore("issues", () => {
    idb().prepare("UPDATE issue SET desc_en=NULL, desc_te=NULL, photo_ref=NULL, voice_ref=NULL, lat=NULL, lon=NULL, gps_enc=NULL, moderation='taken_down', moderation_reason='deleted_by_receipt', updated_at=? WHERE id=?").run(t, r.issue_id);
    idb().prepare("INSERT INTO issue_event (issue_id,type,status,at) VALUES (?,?,?,?)").run(r.issue_id, "taken_down", null, t);
    idb().prepare("UPDATE assisted_record SET deleted_at=?, recheck_state=CASE WHEN recheck_state IN ('queued','not_sampled') THEN 'deleted' ELSE recheck_state END, recheck_due=NULL WHERE issue_id=?").run(t, r.issue_id);
    audit(auditActor, "assisted.delete", `issue:${r.issue_id}`, { pair: r.pair_id, via });
  });
}

/** Counts of re-check outcomes for a pair, optionally only those after a reinstatement (a fresh start, not an instant re-suspension). */
function pairStatsSince(id: string, since: string | null | undefined) {
  const rows = idb().prepare("SELECT c.outcome FROM assist_recheck c JOIN assisted_record r ON r.issue_id=c.record_id WHERE r.pair_id=? AND (? IS NULL OR c.at>?)").all(id, since ?? null, since ?? null) as { outcome: string }[];
  const confirmed = rows.filter((x) => x.outcome === "confirmed").length, notConfirmed = rows.filter((x) => x.outcome === "not_confirmed").length;
  return { checked: confirmed + notConfirmed, not_confirmed: notConfirmed };
}

/** The person (or someone with the paper) reports that the record is wrong or was pushed on them: it goes to the front of the re-check queue and the pair is sampled in full. */
export function reportMisuse(code: unknown, ip: string, now = clock.now()) {
  const r = receiptRecord(code, ip, now);
  if (r.deleted_at) return { reported: true, already: true };
  runInStore("issues", () => {
    idb().prepare("UPDATE assisted_record SET flagged=1, recheck_state=CASE WHEN recheck_state='not_sampled' THEN 'queued' ELSE recheck_state END, recheck_due=COALESCE(recheck_due, ?) WHERE issue_id=?")
      .run(iso(new Date(now.getTime() + cfg.recheckDays() * 86_400_000)), r.issue_id);
    audit("receipt", "assisted.flagged", `issue:${r.issue_id}`, { pair: r.pair_id });
  });
  return { reported: true, already: !!r.flagged };
}

// ---------- reviewer re-check ----------
interface QueueRow { issue_id: string; pair_id: string; village_lgd: string; recheck_due: string | null; flagged: number; created_at: string; category: string; desc_en: string | null; desc_te: string | null }

export function recheckQueue(reviewer: string, limit = 50, now = clock.now()) {
  if (!hasRole(reviewer, "assist_reviewer")) throw err(403, "reviewer role required", "role_required");
  const rows = idb().prepare(`SELECT r.issue_id, r.pair_id, r.village_lgd, r.recheck_due, r.flagged, r.created_at, i.category, i.desc_en, i.desc_te
    FROM assisted_record r JOIN issue i ON i.id=r.issue_id WHERE r.recheck_state='queued' AND r.deleted_at IS NULL ORDER BY r.flagged DESC, r.recheck_due, r.created_at LIMIT 500`).all() as unknown as QueueRow[];
  const place = createPlaceResolver(now);
  const out = [];
  for (const r of rows) {
    if (!roleReaches(reviewer, "assist_reviewer", r.village_lgd)) continue;
    const p = pairById(r.pair_id);
    if (!p || isMember(p, reviewer)) continue; // never your own pair's records
    out.push({
      record_id: r.issue_id, pair_id: r.pair_id, village: place(r.village_lgd).village, category: r.category, flagged: !!r.flagged,
      text_en: sanitizeDescription(r.desc_en), text_te: sanitizeDescription(r.desc_te), created_at: r.created_at, due_by: r.recheck_due, overdue: !!r.recheck_due && r.recheck_due < iso(now),
    });
    if (out.length >= Math.min(Math.max(limit, 1), 200)) break;
  }
  auditPrivilegedRead(reviewer, "assisted:recheck_queue", "reviewer reads the re-check queue");
  return { items: out };
}

export const OUTCOMES = ["confirmed", "not_confirmed", "unreachable"] as const;

export function submitRecheck(reviewer: string, recordId: string, outcomeIn: unknown, noteIn: unknown, now = clock.now()) {
  const outcome = String(outcomeIn);
  if (!(OUTCOMES as readonly string[]).includes(outcome)) throw err(400, "outcome must be confirmed, not_confirmed or unreachable", "invalid_outcome", { outcomes: OUTCOMES });
  const rec = idb().prepare("SELECT * FROM assisted_record WHERE issue_id=?").get(recordId) as { issue_id: string; pair_id: string; village_lgd: string; recheck_state: string; deleted_at: string | null } | undefined;
  if (!rec) throw err(404, "record not found", "not_found");
  if (!roleReaches(reviewer, "assist_reviewer", rec.village_lgd)) throw err(403, "you are not a reviewer for this village", "outside_scope");
  const pair = pairById(rec.pair_id);
  if (pair && isMember(pair, reviewer)) throw err(403, "you cannot re-check your own pair's record", "own_record");
  if (rec.deleted_at) throw err(410, "the person asked for this record to be deleted", "record_deleted");
  if (rec.recheck_state !== "queued") throw err(409, `record is not waiting for a re-check (${rec.recheck_state})`, "not_queued");
  const note = typeof noteIn === "string" ? (sanitizeDescription(noteIn, 200) ?? null) : null;
  const t = iso(now);
  let suspended = false;
  runInStore("issues", () => {
    idb().prepare("INSERT INTO assist_recheck (id,record_id,reviewer_id,outcome,note,at) VALUES (?,?,?,?,?,?)").run(randomUUID(), rec.issue_id, actorPseudonym(reviewer), outcome, note, t);
    idb().prepare("UPDATE assisted_record SET recheck_state=? WHERE issue_id=?").run(outcome, rec.issue_id);
    if (outcome === "not_confirmed") idb().prepare("UPDATE issue SET moderation='held', moderation_reason='assisted_not_confirmed', updated_at=? WHERE id=?").run(t, rec.issue_id); // leaves the public segment until a moderator rules
    audit(reviewer, "assisted.recheck", `issue:${rec.issue_id}`, { pair: rec.pair_id, outcome });
    suspended = maybeAutoSuspend(rec.pair_id, now);
  });
  return { record_id: rec.issue_id, outcome, pair_suspended: suspended };
}

/** Suspend the pair when its not_confirmed rate is above the threshold after enough checked records. Called inside the recheck transaction. */
export function maybeAutoSuspend(pairId: string, now = clock.now()): boolean {
  const pair = pairById(pairId);
  if (!pair || pair.status !== "active") return false;
  const s = pairStatsSince(pairId, pair.reinstated_at);
  if (s.checked < cfg.suspendMinChecked() || s.not_confirmed / s.checked <= cfg.suspendThreshold()) return false;
  suspendCore(pair, "auto", `automatic: ${s.not_confirmed} of ${s.checked} checked records were not confirmed`, now);
  audit("system", "assisted.pair.auto_suspend", `pair:${pairId}`, { checked: s.checked, not_confirmed: s.not_confirmed, threshold: cfg.suspendThreshold() });
  return true;
}

// ---------- public segment ----------
export const SEGMENT_LABEL = { en: "Reported with assistance", te: "సహాయంతో నమోదు చేసినవి" } as const;

/**
 * The labelled segment. Newest first, never ranked, no support counts, never merged into the organic list. Only visible reports (moderation ok) of
 * records that were not deleted. The route answers 404 when the feature is off.
 */
export function publicSegment(q: Record<string, unknown>, now = clock.now()) {
  const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 25, 1), 50);
  const where = ["i.channel='assisted'", "i.moderation='ok'", "r.deleted_at IS NULL"], params: (string | number)[] = [];
  if (typeof q.village === "string" && q.village) { where.push("i.village_lgd=?"); params.push(q.village.slice(0, 64)); }
  if (typeof q.category === "string" && q.category) { where.push("i.category=?"); params.push(q.category.slice(0, 32)); }
  const rows = idb().prepare(`SELECT i.id, i.category, i.department, i.status, i.village_lgd, i.desc_en, i.desc_te, i.created_at, i.updated_at FROM issue i JOIN assisted_record r ON r.issue_id=i.id
    WHERE ${where.join(" AND ")} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`).all(...params, limit) as { id: string; category: string; department: string; status: string; village_lgd: string; desc_en: string | null; desc_te: string | null; created_at: string; updated_at: string }[];
  const place = createPlaceResolver(now);
  return {
    segment: "assisted", label_en: SEGMENT_LABEL.en, label_te: SEGMENT_LABEL.te,
    note_en: "These reports were written down by two trained local volunteers, with the person present and agreeing. They are shown here on their own and are not counted with other reports.",
    note_te: "ఈ నివేదికలను శిక్షణ పొందిన ఇద్దరు స్థానిక వాలంటీర్లు, వ్యక్తి సమక్షంలో మరియు వారి అంగీకారంతో నమోదు చేశారు. వీటిని ఇతర నివేదికలతో కలిపి లెక్కించరు, ఇక్కడ విడిగా చూపుతారు.",
    items: rows.map((r) => ({
      id: r.id, channel: "assisted" as const, category: r.category, department: r.department, status: r.status, village: place(r.village_lgd).village,
      snippet: sanitizeDescription(r.desc_en ?? r.desc_te, 160), snippet_te: sanitizeDescription(r.desc_te, 160), created_at: r.created_at, updated_at: r.updated_at,
    })),
  };
}
