/**
 * Grievance-system adapter CONTRACT (S-145). No real government system is integrated here: this file defines what an adapter must do,
 * a registry to install one, and an in-memory mock used by tests and demos. A real adapter (a state grievance portal) is written
 * against this contract after the owning department agrees terms; the platform holds no credentials for any such system.
 *
 * Rules every adapter must keep:
 *  1. submit() is idempotent per `idempotencyKey`: the same key returns the same receipt, never a second ticket.
 *  2. The ticket carries only what the public issue page already shows (category, department, village code, public text). No reporter
 *     identity, phone number, pseudonym or exact GPS point is ever passed. validateTicket() enforces the shape.
 *  3. Errors are thrown (never swallowed); the caller turns them into 502 grievance_system_error and stores nothing.
 *  4. status() is read-only and safe to call repeatedly.
 *  5. Calls time out inside the adapter (the caller does not set one) and must not block the event loop.
 */
export const GRIEVANCE_CONTRACT = 1 as const;

export type GrievanceStatus = "received" | "in_progress" | "closed" | "rejected";

export interface GrievanceTicket {
  issue_id: string;
  category: string;
  department: string;
  village_lgd: string;
  constituency_lgd: string;
  text_en: string | null;
  text_te: string | null;
  scheme_tags: string[];
}
export interface GrievanceReceipt { reference: string; status: GrievanceStatus }

export interface GrievanceSystemAdapter {
  readonly contract: typeof GRIEVANCE_CONTRACT;
  /** Short stable name, stored with the link (for example "mock", "cm-grievance"). */
  readonly name: string;
  submit(ticket: GrievanceTicket, opts: { idempotencyKey: string }): Promise<GrievanceReceipt>;
  status(reference: string): Promise<GrievanceReceipt>;
}

const ALLOWED_KEYS: (keyof GrievanceTicket)[] = ["issue_id", "category", "department", "village_lgd", "constituency_lgd", "text_en", "text_te", "scheme_tags"];
/** Throws when a ticket carries a field outside the contract (so a coding slip cannot leak an identifier to an external system). */
export function validateTicket(t: Record<string, unknown>): GrievanceTicket {
  const extra = Object.keys(t).filter((k) => !(ALLOWED_KEYS as string[]).includes(k));
  if (extra.length) throw new Error("grievance ticket has fields outside the contract: " + extra.join(","));
  for (const k of ["issue_id", "category", "department", "village_lgd", "constituency_lgd"] as const) if (typeof t[k] !== "string" || !t[k]) throw new Error("grievance ticket is missing " + k);
  return t as unknown as GrievanceTicket;
}

let adapter: GrievanceSystemAdapter | null = null;
export const getGrievanceAdapter = (): GrievanceSystemAdapter | null => adapter;
export function setGrievanceAdapter(a: GrievanceSystemAdapter | null): void {
  if (a && a.contract !== GRIEVANCE_CONTRACT) throw new Error("unsupported grievance adapter contract");
  adapter = a;
}

/** In-memory adapter for tests and demos. Nothing leaves the process. */
export class MockGrievanceAdapter implements GrievanceSystemAdapter {
  readonly contract = GRIEVANCE_CONTRACT;
  readonly name = "mock";
  readonly tickets = new Map<string, { ticket: GrievanceTicket; receipt: GrievanceReceipt }>();
  private byKey = new Map<string, string>();
  private n = 0;
  failNext = false;
  async submit(ticket: GrievanceTicket, opts: { idempotencyKey: string }): Promise<GrievanceReceipt> {
    if (this.failNext) { this.failNext = false; throw new Error("mock grievance system unavailable"); }
    const t = validateTicket({ ...ticket });
    const known = this.byKey.get(opts.idempotencyKey);
    if (known) return { ...this.tickets.get(known)!.receipt };
    const reference = `MOCK-${String(++this.n).padStart(4, "0")}`;
    const receipt: GrievanceReceipt = { reference, status: "received" };
    this.tickets.set(reference, { ticket: t, receipt });
    this.byKey.set(opts.idempotencyKey, reference);
    return { ...receipt };
  }
  async status(reference: string): Promise<GrievanceReceipt> {
    const e = this.tickets.get(reference);
    if (!e) throw new Error("unknown grievance reference");
    return { ...e.receipt };
  }
  /** Test helper: move a ticket along, as the external system would. */
  advance(reference: string, status: GrievanceStatus): void {
    const e = this.tickets.get(reference);
    if (e) e.receipt = { reference, status };
  }
}
