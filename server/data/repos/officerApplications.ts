import type { Db } from "../types";

/**
 * Officer applications (S-141) on the data layer. Same SQL on SQLite and MySQL. Name and e-mail arrive encrypted and the e-mail code only as a
 * keyed hash; nothing here sees either in the clear. The two `role_requests` statements are the dual-control request an application follows
 * (that table belongs to the admin module, not yet ported, and is only read or closed here).
 */
export type ApplicationStatus = "submitted" | "awaiting_second_admin" | "approved" | "rejected" | "withdrawn" | "expired";
export interface ApplicationRow {
  id: string; person_id: string; details_enc: string; email_domain: string; department: string; designation: string; jurisdiction: string; letter_ref: string;
  domain_check: string; status: ApplicationStatus; letter_checked: number; role_request_id: string | null; reviewed_by: string | null; reviewed_at: string | null;
  review_note: string | null; created_at: string; updated_at: string;
  email_code_hash: string | null; email_code_expires: string | null; email_code_tries: number; email_sends: number; email_sent_at: string | null; email_confirmed_at: string | null;
}
export interface NewApplication { id: string; person_id: string; details_enc: string; email_domain: string; department: string; designation: string; jurisdiction: string; letter_ref: string; at: string }
export interface RoleRequestState { status: string; decided_by: string | null; expires_at: string }

/** MySQL can return BIGINT columns as strings; callers compare numbers. */
const norm = (r: ApplicationRow | undefined): ApplicationRow | undefined =>
  r && { ...r, letter_checked: Number(r.letter_checked), email_code_tries: Number(r.email_code_tries), email_sends: Number(r.email_sends) };

export class OfficerApplications {
  constructor(private db: Db) {}

  async get(id: string): Promise<ApplicationRow | undefined> { return norm(await this.db.get<ApplicationRow>("SELECT * FROM officer_application WHERE id = ?", [id])); }
  async forPerson(personId: string): Promise<ApplicationRow[]> {
    return (await this.db.all<ApplicationRow>("SELECT * FROM officer_application WHERE person_id = ? ORDER BY created_at DESC LIMIT 20", [personId])).map((r) => norm(r)!);
  }
  async byStatus(status: string): Promise<ApplicationRow[]> {
    return (await this.db.all<ApplicationRow>("SELECT * FROM officer_application WHERE status = ? ORDER BY created_at ASC LIMIT 200", [status])).map((r) => norm(r)!);
  }
  /** Applications still waiting on the second admin, for one person or all (the caller brings them in line with their role request). */
  async awaiting(personId?: string): Promise<ApplicationRow[]> {
    const rows = personId ? await this.db.all<ApplicationRow>("SELECT * FROM officer_application WHERE person_id = ? AND status = 'awaiting_second_admin'", [personId])
      : await this.db.all<ApplicationRow>("SELECT * FROM officer_application WHERE status = 'awaiting_second_admin'");
    return rows.map((r) => norm(r)!);
  }
  async hasOpen(personId: string): Promise<boolean> {
    return !!(await this.db.get<{ id: string }>("SELECT id FROM officer_application WHERE person_id = ? AND status IN ('submitted','awaiting_second_admin') LIMIT 1", [personId]));
  }
  async insert(a: NewApplication): Promise<void> {
    await this.db.run(`INSERT INTO officer_application (id, person_id, details_enc, email_domain, department, designation, jurisdiction, letter_ref, domain_check, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?, 'pass', 'submitted', ?, ?)`, [a.id, a.person_id, a.details_enc, a.email_domain, a.department, a.designation, a.jurisdiction, a.letter_ref, a.at, a.at]);
  }
  async setStatus(id: string, status: ApplicationStatus, at: string): Promise<void> {
    await this.db.run("UPDATE officer_application SET status = ?, updated_at = ? WHERE id = ?", [status, at, id]);
  }
  /** Stores a new confirmation code (hash and expiry only), resets the wrong-try count and counts the send. */
  async saveEmailCode(id: string, hash: string, expires: string, at: string): Promise<void> {
    await this.db.run("UPDATE officer_application SET email_code_hash = ?, email_code_expires = ?, email_code_tries = 0, email_sends = email_sends + 1, email_sent_at = ?, updated_at = ? WHERE id = ?", [hash, expires, at, at, id]);
  }
  /** The mail could not be sent: the code is void and the resend wait does not apply. */
  async voidEmailCode(id: string): Promise<void> {
    await this.db.run("UPDATE officer_application SET email_code_hash = NULL, email_code_expires = NULL, email_sent_at = NULL WHERE id = ?", [id]);
  }
  async wrongCode(id: string, tries: number, burn: boolean): Promise<void> {
    if (burn) await this.db.run("UPDATE officer_application SET email_code_hash = NULL, email_code_expires = NULL, email_code_tries = ? WHERE id = ?", [tries, id]);
    else await this.db.run("UPDATE officer_application SET email_code_tries = ? WHERE id = ?", [tries, id]);
  }
  async confirmEmail(id: string, at: string): Promise<void> {
    await this.db.run("UPDATE officer_application SET email_confirmed_at = ?, email_code_hash = NULL, email_code_expires = NULL, updated_at = ? WHERE id = ?", [at, at, id]);
  }
  async markVerified(id: string, roleRequestId: string, by: string, at: string, note: string | null): Promise<void> {
    await this.db.run("UPDATE officer_application SET status = 'awaiting_second_admin', letter_checked = 1, role_request_id = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?", [roleRequestId, by, at, note, at, id]);
  }
  async markRejected(id: string, by: string, at: string, note: string): Promise<void> {
    await this.db.run("UPDATE officer_application SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?", [by, at, note, at, id]);
  }

  roleRequest(id: string): Promise<RoleRequestState | undefined> { return this.db.get<RoleRequestState>("SELECT status, decided_by, expires_at FROM role_requests WHERE id = ?", [id]); }
  /** Closes a still-pending role request as rejected; a request already decided is left alone. */
  async rejectRoleRequest(id: string, by: string, at: string): Promise<void> {
    await this.db.run("UPDATE role_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [by, at, id]);
  }
}
