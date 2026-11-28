import type { Db } from "../types";

/**
 * Admin second factor and the dual-control role-request queue (S-140, S-143) on the data layer. Same SQL on SQLite and MySQL.
 * The authenticator secret is stored encrypted and recovery codes only as keyed hashes (the caller does both; nothing here sees a secret or a code in
 * the clear). The roles themselves belong to the core: granting or revoking one stays with the core, and the approval that does so keeps its own
 * synchronous transaction until the core moves (see routes.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
const num = (v: unknown): number => Number(v);

export interface NewRoleRequest { id: string; action: "grant" | "revoke"; person_id: string; role: string; jurisdiction: string; department: string; reason: string; requested_by: string; at: string; expires_at: string }

export class AdminStore {
  constructor(private db: Db) {}

  // ---- second factor ----
  async mfaRow(personId: string): Promise<{ secret_enc: string; confirmed: number; last_counter: number } | undefined> {
    const r = await this.db.get<{ secret_enc: string; confirmed: number; last_counter: number }>("SELECT secret_enc, confirmed, last_counter FROM admin_mfa WHERE person_id = ?", [personId]);
    return r && { ...r, confirmed: num(r.confirmed), last_counter: num(r.last_counter) };
  }
  async recoveryLeft(personId: string): Promise<number> { return num((await this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM admin_mfa_recovery WHERE person_id = ? AND used_at IS NULL", [personId]))!.c); }
  /** Starts (or restarts) enrolment: the secret and a fresh set of recovery hashes replace any earlier unconfirmed ones, together. */
  async startEnrolment(personId: string, secretEnc: string, at: string, recoveryHashes: string[]): Promise<void> {
    await this.db.tx(async (t) => {
      await t.upsert("admin_mfa", { person_id: personId, secret_enc: secretEnc, confirmed: 0, created_at: at, last_counter: 0 }, ["person_id"]);
      await t.run("DELETE FROM admin_mfa_recovery WHERE person_id = ?", [personId]);
      for (const h of recoveryHashes) await t.run("INSERT INTO admin_mfa_recovery (person_id, code_hash) VALUES (?,?)", [personId, h]);
    });
  }
  async confirm(personId: string, counter: number): Promise<void> { await this.db.run("UPDATE admin_mfa SET confirmed = 1, last_counter = ? WHERE person_id = ?", [counter, personId]); }
  /** Moves the last-used time step forward; true only when it really moved, so one code cannot be accepted twice even by two requests at once. */
  async advanceCounter(personId: string, counter: number): Promise<boolean> { return num((await this.db.run("UPDATE admin_mfa SET last_counter = ? WHERE person_id = ? AND last_counter < ?", [counter, personId, counter])).changes) > 0; }
  /** True when this recovery code existed and had not been used (so it works once). */
  async useRecovery(personId: string, hash: string, at: string): Promise<boolean> { return num((await this.db.run("UPDATE admin_mfa_recovery SET used_at = ? WHERE person_id = ? AND code_hash = ? AND used_at IS NULL", [at, personId, hash])).changes) > 0; }

  // ---- role requests (dual control) ----
  async personExists(id: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM persons WHERE id = ? AND deleted_at IS NULL", [id])); }
  async expire(nowIso: string): Promise<void> { await this.db.run("UPDATE role_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [nowIso]); }
  async identicalPending(action: string, personId: string, role: string, jurisdiction: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM role_requests WHERE status = 'pending' AND action = ? AND person_id = ? AND role = ? AND jurisdiction = ?", [action, personId, role, jurisdiction])); }
  async insertRequest(r: NewRoleRequest): Promise<void> {
    await this.db.run("INSERT INTO role_requests (id, action, person_id, role, jurisdiction, department, reason, requested_by, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)", [r.id, r.action, r.person_id, r.role, r.jurisdiction, r.department, r.reason, r.requested_by, r.at, r.expires_at]);
  }
  request(id: string): Promise<Row | undefined> { return this.db.get<Row>("SELECT * FROM role_requests WHERE id = ?", [id]); }
  requests(status: string): Promise<Row[]> { return this.db.all<Row>("SELECT * FROM role_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200", [status]); }
  async reject(id: string, by: string, at: string): Promise<void> { await this.db.run("UPDATE role_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", [by, at, id]); }
  /** Role holders with the person row they belong to, newest first (read only; the roles table is the core's). */
  roleHolders(personId: string, role: string): Promise<Row[]> {
    const where = ["p.deleted_at IS NULL"], args: string[] = [];
    if (personId) { where.push("r.person_id = ?"); args.push(personId); }
    if (role) { where.push("r.role = ?"); args.push(role); }
    return this.db.all<Row>(`SELECT r.person_id, r.role, r.jurisdiction, r.department, r.granted_by, r.granted_at FROM roles r JOIN persons p ON p.id = r.person_id WHERE ${where.join(" AND ")} ORDER BY r.granted_at DESC LIMIT 200`, args);
  }
}
