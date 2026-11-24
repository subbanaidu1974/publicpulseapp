/**
 * Kill switch for assisted participation, under the same dual control as role changes (server/civic/admin): an admin with a TOTP code files a
 * request to disable (or to lift a disable); a DIFFERENT admin with their own TOTP code approves it; requests lapse after 72 hours; every step is
 * audited. The latest approved request decides the state (see ./config.ts killSwitchEngaged).
 */
import { randomUUID } from "node:crypto";
import { audit, getStore, runInStore } from "../core";
import { actorPseudonym } from "../core/pseudonyms";
import { HttpError } from "../issues/service";
import { assistedState, killSwitchEngaged } from "./config";
import { alerts, applyPairReinstatement } from "./controls";
import "./store";

const idb = () => getStore("issues");
const TTL_MS = 72 * 3600_000;
const err = (status: number, message: string, code: string) => new HttpError(status, message, { code });

interface Row { target?: string | null; id: string; action: string; reason: string; requested_by: string; status: string; created_at: string; expires_at: string; decided_by: string | null; decided_at: string | null }
const expire = (now: Date) => idb().prepare("UPDATE assisted_switch_request SET status='expired' WHERE status='pending' AND expires_at<=?").run(now.toISOString());
const view = (r: Row, me?: string) => ({ id: r.id, action: r.action, target: r.target ?? null, reason: r.reason, status: r.status, created_at: r.created_at, expires_at: r.expires_at, decided_at: r.decided_at, mine: me ? r.requested_by === actorPseudonym(me) : undefined });

export function switchStatus(now = new Date(), admin?: string) {
  expire(now);
  const s = assistedState(now);
  const rows = idb().prepare("SELECT * FROM assisted_switch_request WHERE action IN ('disable','enable','pair_reinstate') ORDER BY created_at DESC LIMIT 50").all() as unknown as Row[];
  return { enabled: s.on, reason: s.reason, sunset_date: s.sunset, kill_switch_engaged: killSwitchEngaged(), requests: rows, alerts: s.on || s.killed ? alertsFor(admin) : [] };
}
const alertsFor = (admin?: string) => (admin ? alerts(admin).alerts : []);
export const switchView = (status: ReturnType<typeof switchStatus>, me: string) => ({ ...status, requests: status.requests.map((r) => view(r, me)) });

export function requestSwitch(admin: string, actionIn: unknown, reasonIn: unknown, now = new Date()) {
  const action = String(actionIn);
  if (action !== "disable" && action !== "enable") throw err(400, "action must be disable or enable", "invalid_action");
  const reason = typeof reasonIn === "string" ? reasonIn.trim() : "";
  if (reason.length < 5 || reason.length > 300) throw err(400, "a reason of 5 to 300 characters is required", "reason_required");
  expire(now);
  const killed = killSwitchEngaged();
  if (action === "disable" && killed) throw err(409, "the kill switch is already engaged", "already_in_state");
  if (action === "enable" && !killed) throw err(409, "the kill switch is not engaged", "already_in_state");
  if (idb().prepare("SELECT 1 x FROM assisted_switch_request WHERE status='pending' AND action=?").get(action)) throw err(409, "an identical request is already waiting for approval", "duplicate");
  const id = randomUUID();
  runInStore("issues", () => {
    idb().prepare("INSERT INTO assisted_switch_request (id,action,reason,requested_by,status,created_at,expires_at) VALUES (?,?,?,?, 'pending', ?, ?)")
      .run(id, action, reason, actorPseudonym(admin), now.toISOString(), new Date(now.getTime() + TTL_MS).toISOString());
    audit(admin, "assisted.switch.request", `request:${id}`, { action });
  });
  return { id, status: "pending", action, expires_at: new Date(now.getTime() + TTL_MS).toISOString() };
}

export function decideSwitch(admin: string, id: string, approve: boolean, now = new Date()) {
  expire(now);
  const r = idb().prepare("SELECT * FROM assisted_switch_request WHERE id=? AND action IN ('disable','enable','pair_reinstate')").get(id) as unknown as Row | undefined;
  if (!r) throw err(404, "request not found", "not_found");
  if (r.status === "expired") throw err(410, "request expired", "request_expired");
  if (r.status !== "pending") throw err(409, `request already ${r.status}`, "already_decided");
  if (approve && r.requested_by === actorPseudonym(admin)) {
    audit(admin, "assisted.switch.self_approval_refused", `request:${id}`, {});
    throw err(403, "a different admin must approve this request", "dual_control");
  }
  runInStore("issues", () => {
    idb().prepare("UPDATE assisted_switch_request SET status=?, decided_by=?, decided_at=? WHERE id=?").run(approve ? "approved" : "rejected", actorPseudonym(admin), now.toISOString(), id);
    if (approve && r.action === "pair_reinstate" && r.target) applyPairReinstatement(r.target, now);
    audit(admin, approve ? "assisted.switch.approve" : "assisted.switch.reject", `request:${id}`, { action: r.action, ...(r.target ? { target: r.target } : {}) });
  });
  return { id, status: approve ? "approved" : "rejected", enabled: assistedState(now).on };
}
