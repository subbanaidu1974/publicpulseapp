/**
 * Dual-control break-glass for key recovery (S-64). Using or exporting a data key outside the normal envelope path needs:
 *   1. a request by an admin, with a written reason,
 *   2. approval by TWO OTHER admins (the requester never counts, nobody approves twice),
 *   3. then ONE use, within a short window (default 15 min). Every step and every use is audited; if the audit write fails the action is refused.
 * Two modes: `exportRecoveryBundle` (the data key re-wrapped under the recovery KEK; the clear key never leaves the process) and
 * `useKey` (a transient copy handed to a callback and zeroized afterwards).
 * Grants are held in memory on purpose: a restart cancels every open request. The audit log is the durable record.
 */
import crypto from "node:crypto";
import { audit, hasRole } from "../core";
import type { BreakGlassAccess } from "./keys";

export type BreakGlassStatus = "pending" | "approved" | "used" | "expired" | "denied";
export interface BreakGlassRequest { id: string; purpose: string; version: number; requestedBy: string; reason: string; approvals: string[]; status: BreakGlassStatus; createdAt: number; expiresAt: number; mode?: "export" | "use" }

export interface BreakGlassOpts {
  access: BreakGlassAccess;
  /** Admin check. Default: the core `admin` role. */
  isAdmin?: (personId: string) => boolean;
  /** KEK that recovery bundles are wrapped under (default env CIVIC_KMS_RECOVERY_KEY_ID). */
  recoveryKekId?: string;
  ttlMs?: number; approvalsRequired?: number; now?: () => number;
  /** Test hook: replace the audit writer. */
  auditFn?: typeof audit;
}

export class BreakGlass {
  private reqs = new Map<string, BreakGlassRequest>();
  private isAdmin: (p: string) => boolean;
  constructor(private o: BreakGlassOpts) { this.isAdmin = o.isAdmin ?? ((p) => hasRole(p, "admin")); }
  private now(): number { return this.o.now ? this.o.now() : Date.now(); }
  private required(): number { return Math.max(2, this.o.approvalsRequired ?? 2); } // never configurable below two
  private log(actor: string, action: string, r: BreakGlassRequest, extra: Record<string, unknown> = {}): void {
    (this.o.auditFn ?? audit)(actor, "keys.breakglass." + action, r.id, { purpose: r.purpose, version: r.version, status: r.status, ...extra });
  }
  private get(id: string): BreakGlassRequest {
    const r = this.reqs.get(id);
    if (!r) throw new Error("unknown break-glass request");
    if ((r.status === "pending" || r.status === "approved") && this.now() > r.expiresAt) r.status = "expired";
    return r;
  }

  request(requestedBy: string, a: { purpose: string; version: number; reason: string }): BreakGlassRequest {
    if (!this.isAdmin(requestedBy)) throw new Error("only an admin can request break-glass");
    if (!a.reason || a.reason.trim().length < 10) throw new Error("a written reason (at least 10 characters) is required");
    const r: BreakGlassRequest = { id: "bg_" + crypto.randomBytes(8).toString("hex"), purpose: a.purpose, version: a.version, requestedBy, reason: a.reason.trim().slice(0, 500), approvals: [], status: "pending", createdAt: this.now(), expiresAt: this.now() + (this.o.ttlMs ?? 15 * 60_000) };
    this.log(requestedBy, "request", r, { reason: r.reason });
    this.reqs.set(r.id, r);
    return { ...r };
  }

  approve(id: string, approver: string): { approvals: number; ready: boolean } {
    const r = this.get(id);
    if (r.status !== "pending") throw new Error(`request is ${r.status}`);
    if (!this.isAdmin(approver)) throw new Error("only an admin can approve break-glass");
    if (approver === r.requestedBy) throw new Error("the requester cannot approve their own break-glass request");
    if (r.approvals.includes(approver)) throw new Error("this admin already approved");
    this.log(approver, "approve", r, { approvals: r.approvals.length + 1 });
    r.approvals.push(approver);
    if (r.approvals.length >= this.required()) r.status = "approved";
    return { approvals: r.approvals.length, ready: r.status === "approved" };
  }

  deny(id: string, by: string): void {
    const r = this.get(id);
    if (r.status !== "pending" && r.status !== "approved") throw new Error(`request is ${r.status}`);
    if (!this.isAdmin(by)) throw new Error("only an admin can deny");
    this.log(by, "deny", r);
    r.status = "denied";
  }

  /** Consume an approved grant. Audits BEFORE acting (a failed audit aborts), marks it used even if the action throws. */
  private consume(id: string, by: string, mode: "export" | "use"): BreakGlassRequest {
    const r = this.get(id);
    if (r.status !== "approved") throw new Error(`break-glass is not usable: request is ${r.status}`);
    if (!this.isAdmin(by)) throw new Error("only an admin can use a break-glass grant");
    r.mode = mode;
    this.log(by, mode, r, { approvers: r.approvals.length });
    r.status = "used";
    return r;
  }

  /** The data key wrapped under the recovery KEK. The clear key is never returned. */
  async exportRecoveryBundle(id: string, by: string): Promise<string> {
    const kek = this.o.recoveryKekId ?? process.env.CIVIC_KMS_RECOVERY_KEY_ID;
    if (!kek) throw new Error("no recovery KEK configured (CIVIC_KMS_RECOVERY_KEY_ID)");
    const r = this.consume(id, by, "export");
    return this.o.access.wrapFor(r.purpose, r.version, kek);
  }

  /** Hand a transient copy of the key to fn and zeroize it afterwards (also when fn throws). */
  async useKey<T>(id: string, by: string, fn: (key: Buffer) => T | Promise<T>): Promise<T> {
    const r = this.consume(id, by, "use");
    const k = this.o.access.copyKey(r.purpose, r.version);
    try { return await fn(k); } finally { k.fill(0); }
  }

  status(id: string): BreakGlassStatus { return this.get(id).status; }
}
