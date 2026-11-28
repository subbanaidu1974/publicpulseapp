import type { Db } from "../types";

/**
 * People correction/takedown requests and takedown flags (S-113) on the data layer. Same SQL on SQLite and MySQL; the upsert goes through
 * `Db.upsert` (ON CONFLICT is SQLite-only syntax). Contacts arrive already encrypted; nothing here sees the plain value.
 */
export interface PeopleRequestRow {
  id: string; created_at: string; kind: "correction" | "takedown" | "other"; page: string; target_kind: string | null; target_key: string | null; reason: string;
  contact_enc: string | null; status: "open" | "resolved" | "rejected"; sla_days: number; sla_due: string; resolved_at: string | null; resolution: string | null;
}
export interface TakedownRow { id: number; target_kind: string; target_key: string; request_id: string | null; active: number; state: "pending-review" | "confirmed"; created_at: string; updated_at: string }
export interface NewPeopleRequest { id: string; created_at: string; kind: string; page: string; target_kind: string | null; target_key: string | null; reason: string; contact_enc: string | null; sla_days: number; sla_due: string }

export class PeopleRequests {
  constructor(private db: Db) {}

  async insertRequest(r: NewPeopleRequest): Promise<void> {
    await this.db.run(`INSERT INTO people_requests (id, created_at, kind, page, target_kind, target_key, reason, contact_enc, sla_days, sla_due) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.created_at, r.kind, r.page, r.target_kind, r.target_key, r.reason, r.contact_enc, r.sla_days, r.sla_due]);
  }
  getRequest(id: string): Promise<PeopleRequestRow | undefined> { return this.db.get<PeopleRequestRow>("SELECT * FROM people_requests WHERE id = ?", [id]); }
  listRequests(status?: string): Promise<PeopleRequestRow[]> {
    return status ? this.db.all<PeopleRequestRow>("SELECT * FROM people_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200", [status])
      : this.db.all<PeopleRequestRow>("SELECT * FROM people_requests ORDER BY created_at DESC LIMIT 200");
  }
  async closeRequest(id: string, status: "resolved" | "rejected", at: string, resolution: string | null): Promise<void> {
    await this.db.run("UPDATE people_requests SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?", [status, at, resolution, id]);
  }

  /** A photo takedown request hides the photo at once, pending review. An existing flag keeps its state (a confirmed one stays confirmed). */
  async hidePendingReview(targetKey: string, requestId: string, at: string): Promise<void> {
    await this.db.upsert("people_takedowns", { target_kind: "photo", target_key: targetKey, request_id: requestId, active: 1, state: "pending-review", created_at: at, updated_at: at },
      ["target_kind", "target_key"], ["active", "request_id", "updated_at"]);
  }
  /** An admin confirms (or creates) the takedown for a request. */
  async confirmForRequest(kind: string, key: string, requestId: string, at: string): Promise<void> {
    await this.db.upsert("people_takedowns", { target_kind: kind, target_key: key, request_id: requestId, active: 1, state: "confirmed", created_at: at, updated_at: at },
      ["target_kind", "target_key"], ["active", "state", "request_id", "updated_at"]);
  }
  async lift(kind: string, key: string, at: string): Promise<void> {
    await this.db.run("UPDATE people_takedowns SET active = 0, updated_at = ? WHERE target_kind = ? AND target_key = ?", [at, kind, key]);
  }
  async setTakedown(kind: string, key: string, active: boolean, at: string): Promise<void> {
    await this.db.upsert("people_takedowns", { target_kind: kind, target_key: key, active: active ? 1 : 0, state: "confirmed", created_at: at, updated_at: at },
      ["target_kind", "target_key"], ["active", "state", "updated_at"]);
  }
  listTakedowns(): Promise<TakedownRow[]> { return this.db.all<TakedownRow>("SELECT * FROM people_takedowns ORDER BY updated_at DESC LIMIT 200"); }
  /** Keys of the active takedowns as "kind|key", read on every call (no cache) so a flag is effective at once. */
  async hiddenKeys(): Promise<Set<string>> {
    return new Set((await this.db.all<{ target_kind: string; target_key: string }>("SELECT target_kind, target_key FROM people_takedowns WHERE active = 1")).map((r) => `${r.target_kind}|${r.target_key}`));
  }
}
