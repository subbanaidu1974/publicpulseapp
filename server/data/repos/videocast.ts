import type { Db } from "../types";

/**
 * Video broadcasts (S-230, S-231) on the data layer: the items, their approval state, play counters and the silence windows. Same SQL on SQLite and
 * MySQL. A counter holds no person and no list of who watched. MySQL can return BIGINT as a string, so numbers are coerced here.
 */
export interface VideoRow {
  library: number; transcript: string | null; id: string; title_en: string; title_te: string | null; note_en: string | null; note_te: string | null; media_url: string; kind: string; credit: string;
  status: string; created_by: string; created_at: string; publish_at: string | null; decided_by: string | null; decided_at: string | null; live_at: string | null; recall_note: string | null; views: number;
}
export interface NewVideo { id: string; title_en: string; title_te: string | null; note_en: string | null; note_te: string | null; media_url: string; kind: string; credit: string; created_by: string; at: string; publish_at: string | null; library: number; transcript: string | null }
export interface WindowRow { id: string; label: string; starts_at: string; ends_at: string; created_by: string }

const norm = (r: VideoRow | undefined): VideoRow | undefined => r && { ...r, library: Number(r.library), views: Number(r.views) };

export class VideoStore {
  constructor(private db: Db) {}

  async pendingCount(): Promise<number> { return Number((await this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM vcast_videos WHERE status = 'pending'"))!.c); }
  async insert(v: NewVideo): Promise<void> {
    await this.db.run("INSERT INTO vcast_videos (id,title_en,title_te,note_en,note_te,media_url,kind,credit,status,created_by,created_at,publish_at,library,transcript) VALUES (?,?,?,?,?,?,?,?, 'pending', ?,?,?,?,?)",
      [v.id, v.title_en, v.title_te, v.note_en, v.note_te, v.media_url, v.kind, v.credit, v.created_by, v.at, v.publish_at, v.library, v.transcript]);
  }
  async get(id: string): Promise<VideoRow | undefined> { return norm(await this.db.get<VideoRow>("SELECT * FROM vcast_videos WHERE id = ?", [id])); }
  async listAdmin(): Promise<VideoRow[]> { return (await this.db.all<VideoRow>("SELECT * FROM vcast_videos ORDER BY created_at DESC LIMIT 100")).map((r) => norm(r)!); }
  async registeredUsers(): Promise<number> { return Number((await this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM persons WHERE deleted_at IS NULL"))!.c); }

  async approve(id: string, by: string, at: string, liveAt: string): Promise<void> { await this.db.run("UPDATE vcast_videos SET status = 'live', decided_by = ?, decided_at = ?, live_at = ? WHERE id = ? AND status = 'pending'", [by, at, liveAt, id]); }
  async reject(id: string, by: string, at: string): Promise<void> { await this.db.run("UPDATE vcast_videos SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [by, at, id]); }
  async recall(id: string, by: string, at: string, note: string | null): Promise<void> { await this.db.run("UPDATE vcast_videos SET status = 'recalled', decided_by = ?, decided_at = ?, recall_note = ? WHERE id = ? AND status = 'live'", [by, at, note, id]); }

  async live(nowIso: string, limit: number): Promise<VideoRow[]> {
    return (await this.db.all<VideoRow>(`SELECT * FROM vcast_videos WHERE status = 'live' AND live_at <= ? ORDER BY live_at DESC, id LIMIT ${Math.max(1, Math.floor(limit))}`, [nowIso])).map((r) => norm(r)!);
  }
  /** True when a live, already-listed item was found and its counter moved. */
  async countView(id: string, nowIso: string): Promise<boolean> { return Number((await this.db.run("UPDATE vcast_videos SET views = views + 1 WHERE id = ? AND status = 'live' AND live_at <= ?", [id, nowIso])).changes) > 0; }
  corrections(sinceIso: string): Promise<{ id: string; title_en: string; title_te: string | null; recall_note: string | null; decided_at: string }[]> {
    return this.db.all("SELECT id, title_en, title_te, recall_note, decided_at FROM vcast_videos WHERE status = 'recalled' AND live_at IS NOT NULL AND live_at <= decided_at AND decided_at >= ? ORDER BY decided_at DESC LIMIT 10", [sinceIso]);
  }

  activeWindows(): Promise<WindowRow[]> { return this.db.all<WindowRow>("SELECT id, label, starts_at, ends_at, created_by FROM vcast_windows WHERE ended_at IS NULL ORDER BY starts_at"); }
  async insertWindow(w: WindowRow & { at: string }): Promise<void> { await this.db.run("INSERT INTO vcast_windows (id,label,starts_at,ends_at,created_by,created_at) VALUES (?,?,?,?,?,?)", [w.id, w.label, w.starts_at, w.ends_at, w.created_by, w.at]); }
  /** Anything live, with a start time inside the window, is held until the window ends. */
  async holdUntil(startsAt: string, endsAt: string): Promise<void> { await this.db.run("UPDATE vcast_videos SET live_at = ? WHERE status = 'live' AND live_at >= ? AND live_at < ?", [endsAt, startsAt, endsAt]); }
  openWindow(id: string): Promise<{ created_by: string; ends_at: string } | undefined> { return this.db.get("SELECT created_by, ends_at FROM vcast_windows WHERE id = ? AND ended_at IS NULL", [id]); }
  async endWindow(id: string, by: string, at: string): Promise<void> { await this.db.run("UPDATE vcast_windows SET ended_by = ?, ended_at = ? WHERE id = ?", [by, at, id]); }
  async release(heldUntil: string, nowIso: string, newLiveAt: string): Promise<void> { await this.db.run("UPDATE vcast_videos SET live_at = ? WHERE status = 'live' AND live_at = ? AND live_at > ?", [newLiveAt, heldUntil, nowIso]); }
}
