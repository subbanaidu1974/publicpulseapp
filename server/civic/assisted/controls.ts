/**
 * Assisted participation controls added after the first build (S-49): lifting a suspension, area (village, mandal, district) holds, deletion for a person
 * who lost the receipt (two-person approval), and warnings. Every action is audited. Dual-control rows share the table `assisted_switch_request`
 * (see ./store.ts, ./switch.ts); `target` names the pair, record or area.
 */
import { randomUUID } from "node:crypto";
import { audit, auditPrivilegedRead, getStore, hasRole, runInStore } from "../core";
import { actorPseudonym } from "../core/pseudonyms";
import { getUnit } from "../geo/service";
import { HttpError, clock, inUnit } from "../issues/service";
import { createPlaceResolver, sanitizeDescription } from "../issues/public";
import * as cfg from "./config";
import { eraseRecord, isAdmin, isMember, pairById, pairStats, roleReaches } from "./service";

const idb = () => getStore("issues");
const iso = (d: Date) => d.toISOString();
const err = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) => new HttpError(status, message, { code, ...extra });
const reasonOf = (v: unknown): string => {
  const r = typeof v === "string" ? v.trim() : "";
  if (r.length < 5 || r.length > 300) throw err(400, "a reason of 5 to 300 characters is required", "reason_required");
  return r;
};
const coordinatorOrAdmin = (actor: string, village: string) => isAdmin(actor) || roleReaches(actor, "assist_coordinator", village);
const staffInScope = (actor: string, village: string) => isAdmin(actor) || roleReaches(actor, "assist_coordinator", village) || roleReaches(actor, "assist_reviewer", village);
const expireAll = (now: Date) => idb().prepare("UPDATE assisted_switch_request SET status='expired' WHERE status='pending' AND expires_at<=?").run(iso(now));

// ---------- (a) lifting a pair's suspension ----------
function reinstateCore(pairId: string, now: Date) {
  idb().prepare("UPDATE assist_pair SET status='active', suspended_reason=NULL, suspended_by=NULL, suspended_at=NULL, reinstated_at=? WHERE id=?").run(iso(now), pairId);
}

/** A coordinator in scope (or an admin) lifts a MANUAL suspension. An automatic one needs two admins: requestPairReinstate, then a different admin approves (switch.ts). */
export function reinstatePair(actor: string, pairId: string, reasonIn: unknown, now = clock.now()) {
  const pair = pairById(pairId);
  if (!pair) throw err(404, "pair not found", "not_found");
  if (!coordinatorOrAdmin(actor, pair.village_lgd)) throw err(403, "not allowed for this pair", "outside_scope");
  const reason = reasonOf(reasonIn);
  if (pair.status === "active") return { id: pair.id, status: "active", already: true };
  if (pair.suspended_by === "auto") throw err(409, "an automatic suspension needs two admins to lift (dual control)", "auto_suspended_needs_dual_control");
  if (pair.member_a === "erased" || pair.member_b === "erased") throw err(409, "a member's account was erased: form a new pair", "member_erased");
  runInStore("issues", () => { reinstateCore(pair.id, now); audit(actor, "assisted.pair.reinstate", `pair:${pair.id}`, { reason, manual: true }); });
  return { id: pair.id, status: "active" };
}

/** An admin (with TOTP, checked by the route) files the request to lift an AUTOMATIC suspension; a different admin approves it through /switch/requests/:id/approve. */
export function requestPairReinstate(admin: string, pairId: string, reasonIn: unknown, now = clock.now()) {
  const pair = pairById(pairId);
  if (!pair) throw err(404, "pair not found", "not_found");
  const reason = reasonOf(reasonIn);
  if (pair.status === "active") throw err(409, "the pair is not suspended", "already_in_state");
  if (pair.member_a === "erased" || pair.member_b === "erased") throw err(409, "a member's account was erased: form a new pair", "member_erased");
  expireAll(now);
  if (idb().prepare("SELECT 1 x FROM assisted_switch_request WHERE status='pending' AND action='pair_reinstate' AND target=?").get(pair.id)) throw err(409, "an identical request is already waiting for approval", "duplicate");
  const id = randomUUID();
  runInStore("issues", () => {
    idb().prepare("INSERT INTO assisted_switch_request (id,action,reason,requested_by,status,created_at,expires_at,target) VALUES (?,'pair_reinstate',?,?, 'pending', ?,?,?)")
      .run(id, reason, actorPseudonym(admin), iso(now), iso(new Date(now.getTime() + 72 * 3600_000)), pair.id);
    audit(admin, "assisted.pair.reinstate_request", `pair:${pair.id}`, { request: id });
  });
  return { id, status: "pending", pair_id: pair.id };
}
/** Effect of an approved pair_reinstate request (called by switch.ts inside its transaction). */
export function applyPairReinstatement(pairId: string, now: Date) {
  const pair = pairById(pairId);
  if (!pair || pair.status === "active") return;
  if (pair.member_a === "erased" || pair.member_b === "erased") throw err(409, "a member's account was erased: form a new pair", "member_erased");
  reinstateCore(pairId, now);
}

// ---------- (b) area hold ----------
/** True when a village is inside an area (village, mandal or district) whose latest hold request is a suspension. */
export function villageHeld(village: string): boolean {
  const rows = idb().prepare("SELECT action, target FROM assisted_switch_request WHERE status='approved' AND action IN ('village_suspend','village_resume') ORDER BY decided_at, rowid").all() as { action: string; target: string }[];
  const latest = new Map<string, string>();
  for (const r of rows) latest.set(r.target, r.action);
  for (const [target, action] of latest) if (action === "village_suspend" && (target === village || inUnit(village, target))) return true;
  return false;
}
/** Stop (or resume) recording for a village, mandal or district. Immediate and audited: stopping needs no second person. */
export function setAreaHold(actor: string, unitLgd: string, hold: boolean, reasonIn: unknown, now = clock.now()) {
  const unit = typeof unitLgd === "string" ? getUnit(unitLgd, now) : null;
  if (!unit || !["village", "mandal", "district"].includes(unit.level)) throw err(400, "a village, mandal or district code is required", "invalid_unit");
  if (!(isAdmin(actor) || roleReaches(actor, "assist_coordinator", unit.lgd) || roleReaches(actor, "assist_reviewer", unit.lgd))) throw err(403, "not allowed for this area", "outside_scope");
  const reason = reasonOf(reasonIn);
  const id = randomUUID(), t = iso(now), me = actorPseudonym(actor);
  runInStore("issues", () => {
    idb().prepare("INSERT INTO assisted_switch_request (id,action,reason,requested_by,status,created_at,expires_at,decided_by,decided_at,target) VALUES (?,?,?,?,'approved',?,?,?,?,?)")
      .run(id, hold ? "village_suspend" : "village_resume", reason, me, t, t, me, t, unit.lgd);
    audit(actor, hold ? "assisted.village.suspend" : "assisted.village.resume", `unit:${unit.lgd}`, { reason });
  });
  return { unit: unit.lgd, held: hold };
}
export function listAreaHolds(actor: string) {
  if (!isAdmin(actor) && !hasRole(actor, "assist_coordinator") && !hasRole(actor, "assist_reviewer")) throw err(403, "coordinator or reviewer role required", "role_required");
  const rows = idb().prepare("SELECT action, target, reason, decided_at FROM assisted_switch_request WHERE status='approved' AND action IN ('village_suspend','village_resume') ORDER BY decided_at, rowid").all() as { action: string; target: string; reason: string; decided_at: string }[];
  const latest = new Map<string, { reason: string; at: string; action: string }>();
  for (const r of rows) latest.set(r.target, { reason: r.reason, at: r.decided_at, action: r.action });
  return { holds: [...latest].filter(([, v]) => v.action === "village_suspend").map(([unit, v]) => ({ unit, reason: v.reason, since: v.at }))
    .filter((h) => isAdmin(actor) || roleReaches(actor, "assist_coordinator", h.unit) || roleReaches(actor, "assist_reviewer", h.unit)) };
}

// ---------- (d) a person who lost the receipt ----------
/** Records of a pair (id, category, time, a short snippet) so the coordinator can identify the one the person points to, in the person's presence. Audited read. */
export function pairRecords(actor: string, pairId: string) {
  const pair = pairById(pairId);
  if (!pair) throw err(404, "pair not found", "not_found");
  if (!coordinatorOrAdmin(actor, pair.village_lgd)) throw err(403, "not allowed for this pair", "outside_scope");
  auditPrivilegedRead(actor, `assisted:pair_records:${pairId}`, "coordinator identifies a record for a lost-receipt deletion");
  const rows = idb().prepare("SELECT r.issue_id, r.created_at, r.deleted_at, i.category, i.desc_en, i.desc_te FROM assisted_record r JOIN issue i ON i.id=r.issue_id WHERE r.pair_id=? ORDER BY r.created_at DESC LIMIT 100")
    .all(pairId) as { issue_id: string; created_at: string; deleted_at: string | null; category: string; desc_en: string | null; desc_te: string | null }[];
  return { records: rows.map((r) => ({ record_id: r.issue_id, created_at: r.created_at, deleted: !!r.deleted_at, category: r.category, snippet: sanitizeDescription(r.desc_en ?? r.desc_te, 80) })) };
}

interface ReqRow { id: string; action: string; reason: string; requested_by: string; status: string; created_at: string; expires_at: string; target: string | null }
const recordOf = (id: string | null) => idb().prepare("SELECT issue_id, pair_id, village_lgd, deleted_at FROM assisted_record WHERE issue_id=?").get(String(id)) as { issue_id: string; pair_id: string; village_lgd: string; deleted_at: string | null } | undefined;

/** A coordinator or reviewer in scope asks for a record to be deleted because the person lost the receipt. Nothing is deleted until a DIFFERENT person in scope approves. */
export function requestDeletion(actor: string, recordId: unknown, reasonIn: unknown, now = clock.now()) {
  const rec = recordOf(String(recordId));
  if (!rec) throw err(404, "record not found", "not_found");
  if (!(roleReaches(actor, "assist_coordinator", rec.village_lgd) || roleReaches(actor, "assist_reviewer", rec.village_lgd))) throw err(403, "not allowed for this village", "outside_scope");
  const pair = pairById(rec.pair_id);
  if (pair && isMember(pair, actor)) throw err(403, "a pair member cannot request deletion of their own record", "own_record");
  if (rec.deleted_at) throw err(409, "already deleted", "already_deleted");
  const reason = reasonOf(reasonIn);
  expireAll(now);
  if (idb().prepare("SELECT 1 x FROM assisted_switch_request WHERE status='pending' AND action='record_delete' AND target=?").get(rec.issue_id)) throw err(409, "a request for this record is already waiting", "duplicate");
  const id = randomUUID();
  runInStore("issues", () => {
    idb().prepare("INSERT INTO assisted_switch_request (id,action,reason,requested_by,status,created_at,expires_at,target) VALUES (?,'record_delete',?,?, 'pending', ?,?,?)")
      .run(id, reason, actorPseudonym(actor), iso(now), iso(new Date(now.getTime() + 72 * 3600_000)), rec.issue_id);
    audit(actor, "assisted.delete_request", `issue:${rec.issue_id}`, { request: id, pair: rec.pair_id });
  });
  return { id, status: "pending", record_id: rec.issue_id };
}
export function listDeletionRequests(actor: string, now = clock.now()) {
  expireAll(now);
  const rows = idb().prepare("SELECT * FROM assisted_switch_request WHERE action='record_delete' AND status='pending' ORDER BY created_at LIMIT 200").all() as unknown as ReqRow[];
  const out = [];
  for (const r of rows) {
    const rec = recordOf(r.target);
    if (!rec || !staffInScope(actor, rec.village_lgd)) continue;
    out.push({ id: r.id, record_id: r.target, reason: r.reason, created_at: r.created_at, expires_at: r.expires_at, mine: r.requested_by === actorPseudonym(actor) });
  }
  return { requests: out };
}
export function decideDeletion(actor: string, id: string, approve: boolean, now = clock.now()) {
  expireAll(now);
  const r = idb().prepare("SELECT * FROM assisted_switch_request WHERE id=? AND action='record_delete'").get(id) as unknown as ReqRow | undefined;
  if (!r) throw err(404, "request not found", "not_found");
  if (r.status === "expired") throw err(410, "request expired", "request_expired");
  if (r.status !== "pending") throw err(409, `request already ${r.status}`, "already_decided");
  const rec = recordOf(r.target);
  if (!rec) throw err(404, "record not found", "not_found");
  if (!staffInScope(actor, rec.village_lgd)) throw err(403, "not allowed for this village", "outside_scope");
  const pair = pairById(rec.pair_id);
  if (pair && isMember(pair, actor)) throw err(403, "a pair member cannot decide on their own record", "own_record");
  if (approve && r.requested_by === actorPseudonym(actor)) { audit(actor, "assisted.delete_request.self_approval_refused", `request:${id}`, {}); throw err(403, "a different person must approve this request", "dual_control"); }
  runInStore("issues", () => {
    idb().prepare("UPDATE assisted_switch_request SET status=?, decided_by=?, decided_at=? WHERE id=?").run(approve ? "approved" : "rejected", actorPseudonym(actor), iso(now), id);
    if (approve && !rec.deleted_at) eraseRecord(rec.issue_id, rec.pair_id, actor, "approved_request", now);
    audit(actor, approve ? "assisted.delete_request.approve" : "assisted.delete_request.reject", `issue:${rec.issue_id}`, { request: id });
  });
  return { id, status: approve ? "approved" : "rejected", deleted: approve };
}

// ---------- (c) warnings (they never act on their own; auto-suspension has its own threshold) ----------
export interface AssistedAlert { kind: "unconfirmed_rate" | "assisted_share"; unit: { lgd: string; name_en: string; name_te: string | null } | null; pair_id?: string; rate: number; sample: number; detail: Record<string, number> }

export function alerts(actor: string, now = clock.now()): { alerts: AssistedAlert[]; thresholds: Record<string, number> } {
  if (!isAdmin(actor) && !hasRole(actor, "assist_coordinator") && !hasRole(actor, "assist_reviewer")) throw err(403, "coordinator or reviewer role required", "role_required");
  const place = createPlaceResolver(now);
  const out: AssistedAlert[] = [];
  for (const p of idb().prepare("SELECT id, village_lgd FROM assist_pair").all() as { id: string; village_lgd: string }[]) {
    if (!staffInScope(actor, p.village_lgd)) continue;
    const s = pairStats(p.id);
    if (s.checked >= cfg.alertMinChecked() && s.not_confirmed / s.checked > cfg.alertUnconfirmedRate())
      out.push({ kind: "unconfirmed_rate", pair_id: p.id, unit: place(p.village_lgd).village, rate: Math.round((s.not_confirmed / s.checked) * 1000) / 1000, sample: s.checked, detail: { not_confirmed: s.not_confirmed, checked: s.checked } });
  }
  const since = iso(new Date(now.getTime() - cfg.alertShareDays() * 86_400_000));
  const rows = idb().prepare("SELECT village_lgd, channel, COUNT(*) c FROM issue WHERE created_at>=? AND moderation<>'taken_down' GROUP BY village_lgd, channel").all(since) as { village_lgd: string; channel: string; c: number }[];
  const byUnit = new Map<string, { unit: AssistedAlert["unit"]; assisted: number; total: number }>();
  for (const r of rows) {
    if (!staffInScope(actor, r.village_lgd)) continue;
    const pl = place(r.village_lgd);
    for (const u of [pl.village, pl.mandal]) {
      if (!u) continue;
      const e = byUnit.get(u.lgd) ?? { unit: u, assisted: 0, total: 0 };
      e.total += r.c; if (r.channel === "assisted") e.assisted += r.c; byUnit.set(u.lgd, e);
    }
  }
  for (const e of byUnit.values()) {
    if (e.assisted > 0 && e.total >= cfg.alertShareMinIssues() && e.assisted / e.total > cfg.alertShare())
      out.push({ kind: "assisted_share", unit: e.unit, rate: Math.round((e.assisted / e.total) * 1000) / 1000, sample: e.total, detail: { assisted: e.assisted, total: e.total } });
  }
  return { alerts: out, thresholds: { unconfirmed_rate: cfg.alertUnconfirmedRate(), min_checked: cfg.alertMinChecked(), assisted_share: cfg.alertShare(), days: cfg.alertShareDays(), min_issues: cfg.alertShareMinIssues() } };
}
