import type { Db } from "../types";

/**
 * Photo submissions (S-200) on the data layer. Same SQL on SQLite and MySQL: `?` placeholders, text columns, ISO time strings, no engine
 * functions. The contact is stored encrypted by the caller; nothing here sees the plain value.
 */
export interface PhotoSubmissionRow {
  id: string; created_at: string; state: string; ac_no: number; year: number; candidate: string; claimed_name: string; relationship: string; holder: string;
  contact_enc: string; file: string; mime: string; bytes: number; sha256: string; status: "pending" | "approved" | "rejected";
  decided_at: string | null; decided_by: string | null; note: string | null;
}
export type NewPhotoSubmission = Omit<PhotoSubmissionRow, "status" | "decided_at" | "decided_by" | "note">;

export class PhotoSubmissions {
  constructor(private db: Db) {}
  async insert(r: NewPhotoSubmission): Promise<void> {
    await this.db.run(`INSERT INTO photo_submissions (id, created_at, state, ac_no, year, candidate, claimed_name, relationship, holder, contact_enc, file, mime, bytes, sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [r.id, r.created_at, r.state, r.ac_no, r.year, r.candidate, r.claimed_name, r.relationship, r.holder, r.contact_enc, r.file, r.mime, r.bytes, r.sha256]);
  }
  /** Approved submissions, newest decision first. */
  approved(): Promise<PhotoSubmissionRow[]> { return this.db.all<PhotoSubmissionRow>("SELECT * FROM photo_submissions WHERE status = 'approved' ORDER BY decided_at DESC"); }
  async approvedFile(id: string): Promise<string | null> { return (await this.db.get<{ file: string }>("SELECT file FROM photo_submissions WHERE id = ? AND status = 'approved'", [id]))?.file ?? null; }
  list(status: string | null, limit = 200): Promise<PhotoSubmissionRow[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    return status ? this.db.all<PhotoSubmissionRow>(`SELECT * FROM photo_submissions WHERE status = ? ORDER BY created_at DESC LIMIT ${n}`, [status])
      : this.db.all<PhotoSubmissionRow>(`SELECT * FROM photo_submissions ORDER BY created_at DESC LIMIT ${n}`);
  }
  fileAndMime(id: string): Promise<{ file: string; mime: string } | undefined> { return this.db.get<{ file: string; mime: string }>("SELECT file, mime FROM photo_submissions WHERE id = ?", [id]); }
  /** True when the submission exists (an unchanged re-decision still counts, on both engines). */
  async decide(id: string, status: "approved" | "rejected", by: string, note: string | null, at: string): Promise<boolean> {
    return (await this.db.run("UPDATE photo_submissions SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?", [status, at, by, note, id])).changes > 0;
  }
}
