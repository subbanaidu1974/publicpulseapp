import type { Db, Param } from "../types";

/**
 * Media hub (S-225 to S-245) on the data layer: permitted sources, the news kept from them for a week, the live channel directory, member reports and
 * the per-day click counters. Same SQL on SQLite and MySQL. A report keeps only a keyed hash of who made it; a counter holds no person.
 * MySQL can return BIGINT as a string, so numbers are coerced here. The media hub also counts and checks video items; those two reads of
 * `vcast_videos` are here too (the video module owns every write to that table).
 */
export interface SourceRow {
  permission_by: string | null; id: string; kind: "news" | "live"; name_en: string; name_te: string | null; site_url: string; feed_url: string | null; stream_url: string | null;
  allow: "headline" | "snippet"; state: "AP" | "TG" | "BOTH"; permission_note: string | null; permission_date: string | null; contact: string | null; enabled: number;
  created_by: string; created_at: string; enabled_by: string | null; enabled_at: string | null; last_fetch_at: string | null; last_ok_at: string | null; last_error: string | null;
  health_ok: number | null; health_at: string | null;
}
export interface NewsRow { id: string; title: string; link: string; snippet: string | null; published_at: string; sid: string; name_en: string; name_te: string | null; state: string }
export interface NewNews { id: string; source_id: string; title: string; link: string; snippet: string | null; published_at: string; fetched_at: string }

const norm = (r: SourceRow | undefined): SourceRow | undefined => r && { ...r, enabled: Number(r.enabled), health_ok: r.health_ok == null ? null : Number(r.health_ok) };
const COLS = /^[a-z_]+$/;

export class MediaHubStore {
  constructor(private db: Db) {}
  private async changes(sql: string, p: Param[] = []): Promise<number> { return Number((await this.db.run(sql, p)).changes); }
  /** Plain INSERT that reports whether the row was new. (upsert "none" cannot say: MySQL counts the no-op update of a duplicate as a hit.) */
  private async insertIfNew(table: string, row: Record<string, Param>): Promise<boolean> {
    const cols = Object.keys(row);
    if (!cols.every((c) => COLS.test(c))) throw new Error("bad column");
    try { await this.db.run(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c])); return true; } catch (e) { if ((e as { kind?: string }).kind === "unique") return false; throw e; }
  }

  // ---- sources ----
  async insertSource(row: Record<string, Param>): Promise<void> {
    const cols = Object.keys(row);
    if (!cols.every((c) => COLS.test(c))) throw new Error("bad column");
    await this.db.run(`INSERT INTO mhub_sources (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
  }
  async source(id: string): Promise<SourceRow | undefined> { return norm(await this.db.get<SourceRow>("SELECT * FROM mhub_sources WHERE id = ?", [id])); }
  async sourceExists(id: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM mhub_sources WHERE id = ?", [id])); }
  async allSources(): Promise<SourceRow[]> { return (await this.db.all<SourceRow>("SELECT * FROM mhub_sources ORDER BY created_at DESC")).map((r) => norm(r)!); }
  async enabledNewsSources(): Promise<SourceRow[]> { return (await this.db.all<SourceRow>("SELECT * FROM mhub_sources WHERE kind = 'news' AND enabled = 1")).map((r) => norm(r)!); }
  async enabledLive(): Promise<SourceRow[]> { return (await this.db.all<SourceRow>("SELECT * FROM mhub_sources WHERE kind = 'live' AND enabled = 1 ORDER BY name_en")).map((r) => norm(r)!); }
  async dueIds(beforeIso: string): Promise<string[]> { return (await this.db.all<{ id: string }>("SELECT id FROM mhub_sources WHERE kind = 'news' AND feed_url IS NOT NULL AND enabled = 1 AND (last_fetch_at IS NULL OR last_fetch_at < ?)", [beforeIso])).map((r) => r.id); }
  async setPermission(id: string, note: string, date: string, contact: string, by: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET permission_note = ?, permission_date = ?, contact = ?, permission_by = ? WHERE id = ?", [note, date, contact, by, id]); }
  async enable(id: string, by: string, at: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET enabled = 1, enabled_by = ?, enabled_at = ? WHERE id = ?", [by, at, id]); }
  async disable(id: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET enabled = 0 WHERE id = ?", [id]); }
  async clearFeed(id: string, at: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET feed_url = NULL, last_ok_at = ? WHERE id = ?", [at, id]); }
  async markFetch(id: string, at: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET last_fetch_at = ? WHERE id = ?", [at, id]); }
  async markOk(id: string, at: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET last_ok_at = ?, last_error = NULL WHERE id = ?", [at, id]); }
  async markError(id: string, message: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET last_error = ? WHERE id = ?", [message, id]); }
  async setHealth(id: string, ok: boolean, at: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET health_ok = ?, health_at = ? WHERE id = ?", [ok ? 1 : 0, at, id]); }

  // ---- news ----
  async insertNews(n: NewNews): Promise<void> { await this.db.run("INSERT INTO mhub_news (id,source_id,title,link,snippet,published_at,fetched_at) VALUES (?,?,?,?,?,?,?)", [n.id, n.source_id, n.title, n.link, n.snippet, n.published_at, n.fetched_at]); }
  /** True when the item was new (a repeat of the same link from the same source is ignored). */
  async addNewsIfNew(n: NewNews): Promise<boolean> { return this.insertIfNew("mhub_news", { ...n }); }
  /** The same story again: its time and title are refreshed (the demo items keep fresh times). */
  async refreshNews(n: NewNews): Promise<void> { await this.db.upsert("mhub_news", { ...n }, ["source_id", "link"], ["published_at", "title"]); }
  async deleteNewsBefore(iso: string): Promise<void> { await this.db.run("DELETE FROM mhub_news WHERE published_at < ?", [iso]); }
  async newsRows(sinceIso: string, state: "AP" | "TG" | null, videos: boolean, limit: number): Promise<NewsRow[]> {
    const lim = Math.max(1, Math.floor(limit));
    return this.db.all<NewsRow>(`SELECT n.id, n.title, n.link, n.snippet, n.published_at, s.id AS sid, s.name_en, s.name_te, s.state FROM mhub_news n JOIN mhub_sources s ON s.id = n.source_id
      WHERE s.enabled = 1 AND n.hidden = 0 AND n.published_at >= ? ${state ? "AND (s.state = ? OR s.state = 'BOTH')" : ""} AND n.link ${videos ? "LIKE" : "NOT LIKE"} 'https://www.youtube.com/watch%'
      ORDER BY n.published_at DESC LIMIT ${lim}`, state ? [sinceIso, state] : [sinceIso]);
  }
  async hideNews(id: string): Promise<void> { await this.db.run("UPDATE mhub_news SET hidden = 1 WHERE id = ?", [id]); }
  async newsTitle(id: string): Promise<string | undefined> { return (await this.db.get<{ title: string }>("SELECT title FROM mhub_news WHERE id = ?", [id]))?.title; }
  async sourceName(id: string): Promise<string | undefined> { return (await this.db.get<{ name_en: string }>("SELECT name_en FROM mhub_sources WHERE id = ?", [id]))?.name_en; }

  // ---- counters and reports ----
  async newsClickable(id: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM mhub_news n JOIN mhub_sources s ON s.id = n.source_id WHERE n.id = ? AND s.enabled = 1 AND n.hidden = 0", [id])); }
  async liveClickable(id: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM mhub_sources WHERE id = ? AND kind = 'live' AND enabled = 1", [id])); }
  /** One more click for the item on the day; the row is made on the first click (a race between two first clicks still counts both). */
  async bump(kind: string, id: string, day: string): Promise<void> {
    const up = "UPDATE mhub_counts SET n = n + 1 WHERE kind = ? AND item_id = ? AND day = ?";
    if ((await this.changes(up, [kind, id, day])) > 0) return;
    if (await this.insertIfNew("mhub_counts", { kind, item_id: id, day, n: 1 })) return;
    await this.db.run(up, [kind, id, day]);
  }
  async counts(): Promise<{ kind: string; item_id: string; total: number; last_day: string }[]> {
    return (await this.db.all<{ kind: string; item_id: string; total: number; last_day: string }>("SELECT kind, item_id, SUM(n) AS total, MAX(day) AS last_day FROM mhub_counts GROUP BY kind, item_id")).map((r) => ({ ...r, total: Number(r.total) }));
  }
  async videoExists(id: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM vcast_videos WHERE id = ?", [id])); }
  async newsExists(id: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM mhub_news WHERE id = ?", [id])); }
  async liveExists(id: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM mhub_sources WHERE id = ? AND kind = 'live'", [id])); }
  async countedVideos(): Promise<{ id: string; title_en: string; views: number }[]> { return (await this.db.all<{ id: string; title_en: string; views: number }>("SELECT id, title_en, views FROM vcast_videos WHERE status IN ('live','recalled')")).map((r) => ({ ...r, views: Number(r.views) })); }
  /** True when this person's report on the item was new (one report per person per item). */
  async addReport(r: { id: string; kind: string; item_id: string; reason: string; note: string | null; reporter: string; at: string }): Promise<boolean> {
    return this.insertIfNew("mhub_reports", { id: r.id, kind: r.kind, item_id: r.item_id, reason: r.reason, note: r.note, reporter: r.reporter, created_at: r.at });
  }
  openReport(id: string): Promise<{ kind: string; item_id: string } | undefined> { return this.db.get("SELECT kind, item_id FROM mhub_reports WHERE id = ? AND status = 'open'", [id]); }
  async closeReports(kind: string, itemId: string, by: string, at: string, resolution: string): Promise<void> { await this.db.run("UPDATE mhub_reports SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE kind = ? AND item_id = ? AND status = 'open'", [by, at, resolution, kind, itemId]); }
  reports(): Promise<Record<string, unknown>[]> { return this.db.all("SELECT id, kind, item_id, reason, note, created_at, status, resolution FROM mhub_reports ORDER BY (status = 'open') DESC, created_at DESC LIMIT 100"); }

  // ---- development preview ----
  async previewOn(at: string, note: string, date: string): Promise<void> { await this.db.run("UPDATE mhub_sources SET enabled = 1, enabled_by = 'preview-setting', enabled_at = ?, permission_note = ?, permission_date = ?, contact = 'preview@example.invalid' WHERE id LIKE 'cand-%' AND enabled = 0 AND permission_note IS NULL", [at, note, date]); }
  async previewOff(): Promise<void> { await this.db.run("UPDATE mhub_sources SET enabled = 0, enabled_by = NULL, enabled_at = NULL, permission_note = NULL, permission_date = NULL, contact = NULL WHERE enabled_by = 'preview-setting'"); }
}
