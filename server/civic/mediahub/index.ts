/**
 * Media hub (S-225, S-226, S-228, S-234, S-236): the sources behind the Media tab, daily news from permitted feeds, the live channel directory,
 * member reports, and aggregate counts. Mounted at /api/v1/civic/media. See docs/MEDIA_HUB.md.
 *
 * Nothing is shown from a source until an admin recorded WHY we may (permission note, date, contact) and a DIFFERENT admin switched it on.
 * News is headline, outlet, time and a link to the publisher; a snippet only where the source allows it; never the article. Live channels are
 * a link to the channel's own site, plus its own official stream when it gave one. We fetch nothing from a source that is switched off.
 *
 *   GET  /news?state=AP|TG        public: recent items from enabled news sources, a top-today digest, and which sources look stale
 *   GET  /live                    public: enabled live channels with their last health check
 *   POST /click                   public: {kind: "news"|"live", id} one counter per item per day, no person
 *   POST /report                  signed-in: {kind: "video"|"news"|"live", id, reason, note?}
 *   GET  /admin/sources           admin: all sources
 *   POST /admin/sources           admin: add a source (starts switched off)
 *   POST /admin/sources/:id/enable   a DIFFERENT admin: switch on (needs the permission record)
 *   POST /admin/sources/:id/disable  any admin: switch off at once; its news is hidden immediately
 *   POST /admin/sources/:id/refresh  admin: fetch a news feed now
 *   POST /admin/sources/:id/check    admin: check a live stream address now
 *   GET  /admin/reports           admin: reports, open first
 *   POST /admin/reports/:id/resolve  admin: {action: "dismiss"|"takedown"}
 *   GET  /admin/numbers           admin: aggregate counts per item (hidden under the minimum)
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { audit, getDb, getKeys, registerMigration, requireAuth, requireRole } from "../core";
import { isProductionEnv } from "../guards";
import { mediaVideoHosts } from "../../security";
import { asksPartyPreference, asksSecret, hasLink } from "../broadcast";
import { recallVideo } from "../videocast";

registerMigration("mhub_001_core", `
CREATE TABLE mhub_sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('news','live')),
  name_en TEXT NOT NULL, name_te TEXT, site_url TEXT NOT NULL, feed_url TEXT, stream_url TEXT,
  allow TEXT NOT NULL CHECK (allow IN ('headline','snippet')), state TEXT NOT NULL CHECK (state IN ('AP','TG','BOTH')),
  permission_note TEXT, permission_date TEXT, contact TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, enabled_by TEXT, enabled_at TEXT,
  last_fetch_at TEXT, last_ok_at TEXT, last_error TEXT, health_ok INTEGER, health_at TEXT
);
CREATE TABLE mhub_news (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL, snippet TEXT,
  published_at TEXT NOT NULL, fetched_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, link)
);
CREATE INDEX idx_mhub_news_pub ON mhub_news(published_at);
CREATE TABLE mhub_reports (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, item_id TEXT NOT NULL, reason TEXT NOT NULL, note TEXT,
  reporter TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT, resolved_at TEXT, resolution TEXT,
  UNIQUE (kind, item_id, reporter)
);
CREATE TABLE mhub_counts (kind TEXT NOT NULL, item_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, item_id, day));
`);

// Candidate sources (S-242): The Hindu's official state feeds, loaded SWITCHED OFF with no permission record. Nothing is shown to members until an admin records
// the written permission and a different admin switches the source on. The feed addresses were checked on 2026-11-26; the permission is the owner's to obtain.
registerMigration("mhub_002_candidates", `
ALTER TABLE mhub_sources ADD COLUMN permission_by TEXT;
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,allow,state,created_by,created_at) VALUES
 ('cand-hindu-ap','news','The Hindu: Andhra Pradesh','ది హిందూ: ఆంధ్రప్రదేశ్','https://www.thehindu.com/news/national/andhra-pradesh/','https://www.thehindu.com/news/national/andhra-pradesh/feeder/default.rss','headline','AP','system','2026-11-26T00:00:00.000Z'),
 ('cand-hindu-tg','news','The Hindu: Telangana','ది హిందూ: తెలంగాణ','https://www.thehindu.com/news/national/telangana/','https://www.thehindu.com/news/national/telangana/feeder/default.rss','headline','TG','system','2026-11-26T00:00:00.000Z');
`);

// Telugu channel and newspaper feeds (S-244): the same rule as above. Each address answered with a valid RSS feed on 2026-11-26; none has a permission record.
registerMigration("mhub_003_telugu_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,allow,state,created_by,created_at) VALUES
 ('cand-ntv','news','NTV Telugu','ఎన్టీవీ తెలుగు','https://ntvtelugu.com/','https://ntvtelugu.com/feed','headline','BOTH','system','2026-11-26T00:00:00.000Z'),
 ('cand-tv9','news','TV9 Telugu','టీవీ9 తెలుగు','https://tv9telugu.com/','https://tv9telugu.com/feed','headline','BOTH','system','2026-11-26T00:00:00.000Z'),
 ('cand-10tv','news','10TV','10టీవీ','https://10tv.in/','https://10tv.in/feed','headline','BOTH','system','2026-11-26T00:00:00.000Z'),
 ('cand-sakshi','news','Sakshi','సాక్షి','https://www.sakshi.com/','https://www.sakshi.com/rss.xml','headline','BOTH','system','2026-11-26T00:00:00.000Z');
`);

export const MIN_COUNT_SHOWN = 10;
export const NEWS_KEEP_DAYS = 7, STALE_HOURS = 6, REFRESH_MINUTES = 15;
const MAX_ITEMS_PER_FETCH = 50, MAX_FEED_BYTES = 1_000_000, FETCH_TIMEOUT_MS = 8000;
const REASONS = ["wrong", "partisan", "offensive", "broken", "other"] as const;

class Bad extends Error { constructor(public code: string, m: string) { super(m); } }
const str = (v: unknown): string => (typeof v === "string" ? v.normalize("NFKC").trim() : "");
const fail = (res: express.Response, status: number, code: string, message: string): void => { res.status(status).json({ error: code, code, message }); };
const db = () => getDb();
const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1";

interface Src { permission_by: string | null; id: string; kind: "news" | "live"; name_en: string; name_te: string | null; site_url: string; feed_url: string | null; stream_url: string | null; allow: "headline" | "snippet"; state: "AP" | "TG" | "BOTH"; permission_note: string | null; permission_date: string | null; contact: string | null; enabled: number; created_by: string; created_at: string; enabled_by: string | null; enabled_at: string | null; last_fetch_at: string | null; last_ok_at: string | null; last_error: string | null; health_ok: number | null; health_at: string | null }

/** https only (http for localhost outside production); no login in the address; not too long. */
export function checkUrl(label: string, raw: string, opts: { allowedHostsOnly?: boolean } = {}): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Bad("bad_url", `${label}: not a valid web address`); }
  const local = isLocal(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !isProductionEnv())) throw new Bad("bad_url", `${label}: must start with https://`);
  if (u.username || u.password) throw new Bad("bad_url", `${label}: must not contain a login`);
  if (raw.length > 500) throw new Bad("bad_url", `${label}: too long`);
  if (local && isProductionEnv()) throw new Bad("bad_url", `${label}: a local address is not allowed`);
  if (opts.allowedHostsOnly && !local && !mediaVideoHosts().includes(u.hostname.toLowerCase())) throw new Bad("host_not_allowed", `${label}: this host is not on the approved list for media (MEDIA_VIDEO_HOSTS)`);
  return u.toString();
}

function text(label: string, v: unknown, min: number, max: number, required: boolean): string | null {
  const s = str(v);
  if (!s) { if (required) throw new Bad("bad_" + label, `${label} is required`); return null; }
  if (s.length < min || s.length > max) throw new Bad("bad_" + label, `${label}: ${min} to ${max} characters`);
  if (asksSecret(s)) throw new Bad("text_refused", `${label} asks for a code, PIN, password or ID number`);
  return s;
}

const srcPublic = (s: Src) => ({ id: s.id, kind: s.kind, name_en: s.name_en, name_te: s.name_te, site_url: s.site_url, state: s.state });

/** A YouTube video id from a watch or short link on youtube.com / youtu.be, else null. Used only to offer YouTube's own embed player; nothing is downloaded. */
export function youtubeId(link: string): string | null {
  try {
    const u = new URL(link);
    const h = u.hostname.toLowerCase();
    const id = h === "youtu.be" ? u.pathname.slice(1) : (h === "www.youtube.com" || h === "youtube.com" || h === "m.youtube.com") ? (u.pathname === "/watch" ? (u.searchParams.get("v") ?? "") : u.pathname.startsWith("/shorts/") ? u.pathname.slice(8) : "") : "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
/** YouTube publishes an official public feed for every channel. We build its address from the channel id so an admin cannot point it anywhere else. */
export const youtubeFeedUrl = (channelId: string): string => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

export function addSource(adminId: string, body: Record<string, unknown>, now: Date = new Date()): Src {
  const kind = body.kind === "live" ? "live" : body.kind === "news" ? "news" : null;
  if (!kind) throw new Bad("bad_kind", "kind must be news or live");
  const name_en = text("name", body.name_en, 2, 80, true)!, name_te = text("name_te", body.name_te, 1, 120, false);
  const yt = str(body.youtube_channel_id);
  if (yt && (kind !== "news" || !/^UC[A-Za-z0-9_-]{22}$/.test(yt))) throw new Bad("bad_youtube", "a YouTube channel id starts with UC and is 24 characters, and is only for a news source");
  const site_url = checkUrl("site address", str(body.site_url) || (yt ? `https://www.youtube.com/channel/${yt}` : ""));
  const feed_url = kind === "news" ? (yt ? youtubeFeedUrl(yt) : checkUrl("feed address", str(body.feed_url))) : null;
  const stream_url = kind === "live" && str(body.stream_url) ? (youtubeId(str(body.stream_url)) ? checkUrl("stream address", str(body.stream_url)) : checkUrl("stream address", str(body.stream_url), { allowedHostsOnly: true })) : null;
  const allow = body.allow === "snippet" ? "snippet" : "headline";
  const state = body.state === "AP" || body.state === "TG" ? body.state : "BOTH";
  const id = crypto.randomUUID();
  db().prepare("INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,stream_url,allow,state,created_by,created_at,permission_note,permission_date,contact) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, kind, name_en, name_te, site_url, feed_url, stream_url, allow, state, adminId, now.toISOString(), text("permission_note", body.permission_note, 10, 500, false), str(body.permission_date) || null, text("contact", body.contact, 5, 160, false));
  audit(adminId, "media.source.add", "mhub-source:" + id, { kind });
  return getSource(id);
}

/**
 * Paste-a-link (S-239): one YouTube video from a channel that gave us permission. It is stored as its own news source with no feed, so it needs the same
 * permission record and a different admin to switch it on, and it can be switched off or taken down like any source. The title is typed by the admin
 * (we do not fetch the page); the video is shown for 7 days like other news. Nothing is downloaded.
 */
export function addVideoLink(adminId: string, body: Record<string, unknown>, now: Date = new Date()): Src {
  const link = str(body.link);
  const vid = youtubeId(link);
  if (!vid) throw new Bad("bad_youtube", "paste a YouTube video link (youtube.com/watch?v=..., youtu.be/... or youtube.com/shorts/...)");
  const title = text("title", body.title, 3, 200, true)!;
  const watch = `https://www.youtube.com/watch?v=${vid}`;
  const s = addSource(adminId, { kind: "news", name_en: body.channel_name, name_te: body.channel_name_te, site_url: watch, feed_url: watch, allow: "headline", state: body.state, permission_note: body.permission_note, permission_date: body.permission_date, contact: body.contact }, now);
  db().prepare("UPDATE mhub_sources SET feed_url = NULL, last_ok_at = ? WHERE id = ?").run(now.toISOString(), s.id);
  db().prepare("INSERT INTO mhub_news (id,source_id,title,link,snippet,published_at,fetched_at) VALUES (?,?,?,?,NULL,?,?)").run(crypto.randomUUID(), s.id, title, watch, now.toISOString(), now.toISOString());
  audit(adminId, "media.video-link.add", "mhub-source:" + s.id, { video: vid });
  return getSource(s.id);
}

export function getSource(id: string): Src {
  const s = db().prepare("SELECT * FROM mhub_sources WHERE id = ?").get(id) as unknown as Src | undefined;
  if (!s) throw new Bad("not_found", "no such source");
  return s;
}

/** Records the permission for a source that was added without one (for example a candidate loaded switched off). The admin who records it cannot also switch it on. */
export function recordPermission(adminId: string, id: string, body: Record<string, unknown>, now: Date = new Date()): Src {
  const s = getSource(id);
  if (s.enabled) throw new Bad("already_on", "switch the source off before changing its permission record");
  const note = text("permission_note", body.permission_note, 10, 500, true)!, contact = text("contact", body.contact, 5, 160, true)!;
  const d = new Date(str(body.permission_date));
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 86_400_000) throw new Bad("bad_date", "the permission date must be a real date, not in the future");
  db().prepare("UPDATE mhub_sources SET permission_note = ?, permission_date = ?, contact = ?, permission_by = ? WHERE id = ?").run(note, str(body.permission_date), contact, adminId, id);
  audit(adminId, "media.source.permission", "mhub-source:" + id);
  return getSource(id);
}

/** Switching on needs the permission record AND a different admin than the one who added it or recorded the permission. */
export function enableSource(adminId: string, id: string, now: Date = new Date()): Src {
  const s = getSource(id);
  if (s.created_by === adminId || s.permission_by === adminId) throw new Bad("same_person", "a different admin must switch a source on");
  const date = s.permission_date ? new Date(s.permission_date) : null;
  if (!s.permission_note || !s.contact || !date || Number.isNaN(date.getTime()) || date.getTime() > now.getTime() + 86_400_000)
    throw new Bad("permission_missing", "record the permission first: a note saying why we may show it, the date it was given, and a contact at the source");
  db().prepare("UPDATE mhub_sources SET enabled = 1, enabled_by = ?, enabled_at = ? WHERE id = ?").run(adminId, now.toISOString(), id);
  audit(adminId, "media.source.enable", "mhub-source:" + id);
  return getSource(id);
}

export function disableSource(adminId: string, id: string): Src {
  getSource(id);
  db().prepare("UPDATE mhub_sources SET enabled = 0 WHERE id = ?").run(id);
  audit(adminId, "media.source.disable", "mhub-source:" + id);
  return getSource(id);
}

/* ---------------- feeds ---------------- */

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
const decode = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENT[m] ?? m).replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
const plain = (s: string): string => decode(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const tag = (block: string, name: string): string | null => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block); return m ? m[1] : null; };

export interface FeedItem { title: string; link: string; published: string; snippet: string | null }
/** A small RSS 2.0 / Atom reader. Items without a title, a usable link or a date are skipped; the article body is never kept. */
export function parseFeed(xml: string, now: Date = new Date()): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  for (const b of blocks.slice(0, 200)) {
    const title = plain(tag(b, "title") ?? "").slice(0, 200);
    let link = plain(tag(b, "link") ?? "");
    if (!link) { const m = /<link[^>]*\shref=["']([^"']+)["']/i.exec(b); link = m ? decode(m[1]) : ""; }
    const when = plain(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date") ?? "");
    const d = new Date(when);
    const snippet = plain(tag(b, "description") ?? tag(b, "summary") ?? "").slice(0, 240) || null;
    if (title.length < 3 || !link) continue;
    try { const u = new URL(link); if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname) && !isProductionEnv())) continue; link = u.toString(); } catch { continue; }
    const published = Number.isNaN(d.getTime()) ? now : d;
    if (published.getTime() > now.getTime() + 86_400_000) continue; // a date far in the future is a broken feed, not news
    out.push({ title, link, published: published.toISOString(), snippet });
  }
  return out;
}

export type Fetcher = (url: string, init: { method?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
const realFetch: Fetcher = (url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>;

export async function refreshSource(id: string, fetcher: Fetcher = realFetch, now: Date = new Date()): Promise<{ added: number }> {
  const s = getSource(id);
  if (s.kind !== "news" || !s.feed_url) throw new Bad("not_news", "this source has no news feed");
  if (!s.enabled) throw new Bad("not_enabled", "this source is switched off, so nothing is fetched from it");
  db().prepare("UPDATE mhub_sources SET last_fetch_at = ? WHERE id = ?").run(now.toISOString(), id);
  try {
    const r = await fetcher(s.feed_url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`the source answered ${r.status}`);
    const body = await r.text();
    if (body.length > MAX_FEED_BYTES) throw new Error("the feed is larger than 1 MB");
    const items = parseFeed(body, now).slice(0, MAX_ITEMS_PER_FETCH);
    let added = 0;
    for (const it of items) {
      const res = db().prepare("INSERT OR IGNORE INTO mhub_news (id,source_id,title,link,snippet,published_at,fetched_at) VALUES (?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), id, it.title, it.link, s.allow === "snippet" ? it.snippet : null, it.published, now.toISOString());
      added += Number(res.changes);
    }
    db().prepare("UPDATE mhub_sources SET last_ok_at = ?, last_error = NULL WHERE id = ?").run(now.toISOString(), id);
    db().prepare("DELETE FROM mhub_news WHERE published_at < ?").run(new Date(now.getTime() - NEWS_KEEP_DAYS * 86_400_000).toISOString());
    return { added };
  } catch (e) {
    db().prepare("UPDATE mhub_sources SET last_error = ? WHERE id = ?").run(String((e as Error).message).slice(0, 200), id);
    throw new Bad("fetch_failed", `could not read the feed: ${(e as Error).message}`);
  }
}

/** Refreshes every enabled news source not fetched in the last REFRESH_MINUTES. Used by the news route (without waiting) and by tests. */
export async function refreshDue(fetcher: Fetcher = realFetch, now: Date = new Date()): Promise<void> {
  const due = db().prepare("SELECT id FROM mhub_sources WHERE kind = 'news' AND feed_url IS NOT NULL AND enabled = 1 AND (last_fetch_at IS NULL OR last_fetch_at < ?)").all(new Date(now.getTime() - REFRESH_MINUTES * 60_000).toISOString()) as { id: string }[];
  for (const d of due) await refreshSource(d.id, fetcher, now).catch(() => undefined);
}

export function newsFor(state: string | undefined, now: Date = new Date()) {
  const since = new Date(now.getTime() - NEWS_KEEP_DAYS * 86_400_000).toISOString();
  const st = state === "AP" || state === "TG" ? state : null;
  const rows = db().prepare(`SELECT n.id, n.title, n.link, n.snippet, n.published_at, s.id AS sid, s.name_en, s.name_te, s.state FROM mhub_news n JOIN mhub_sources s ON s.id = n.source_id
    WHERE s.enabled = 1 AND n.hidden = 0 AND n.published_at >= ? ${st ? "AND (s.state = ? OR s.state = 'BOTH')" : ""} ORDER BY n.published_at DESC LIMIT 100`).all(...(st ? [since, st] : [since])) as unknown as { id: string; title: string; link: string; snippet: string | null; published_at: string; sid: string; name_en: string; name_te: string | null; state: string }[];
  const items = rows.map((r) => ({ id: r.id, title: r.title, link: r.link, snippet: r.snippet, published_at: r.published_at, outlet_en: r.name_en, outlet_te: r.name_te, source_id: r.sid, youtube: youtubeId(r.link) }));
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const digest = items.filter((i) => i.published_at >= dayAgo).slice(0, 5);
  const srcs = db().prepare("SELECT * FROM mhub_sources WHERE kind = 'news' AND enabled = 1").all() as unknown as Src[];
  const staleBefore = new Date(now.getTime() - STALE_HOURS * 3_600_000).toISOString();
  return { items, digest, sources: srcs.map((s) => ({ ...srcPublic(s), stale: !!s.feed_url && (!s.last_ok_at || s.last_ok_at < staleBefore) })), label: "publisher" };
}

/* ---------------- live channels ---------------- */

export async function checkStream(id: string, fetcher: Fetcher = realFetch, now: Date = new Date()): Promise<boolean> {
  const s = getSource(id);
  if (s.kind !== "live" || !s.stream_url) throw new Bad("no_stream", "this channel has no stream address to check");
  if (youtubeId(s.stream_url)) throw new Bad("youtube_unchecked", "a YouTube stream plays in YouTube's own player; we cannot check it from here");
  let ok = false;
  try { const r = await fetcher(s.stream_url, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); ok = r.ok; } catch { ok = false; }
  db().prepare("UPDATE mhub_sources SET health_ok = ?, health_at = ? WHERE id = ?").run(ok ? 1 : 0, now.toISOString(), id);
  return ok;
}
export const liveChannels = () => (db().prepare("SELECT * FROM mhub_sources WHERE kind = 'live' AND enabled = 1 ORDER BY name_en").all() as unknown as Src[])
  .map((s) => ({ ...srcPublic(s), stream_url: s.stream_url, health_ok: s.health_ok === null ? null : s.health_ok === 1, health_at: s.health_at }));

/* ---------------- counts, reports ---------------- */

export function countClick(kind: string, id: string, now: Date = new Date()): void {
  if (kind !== "news" && kind !== "live") throw new Bad("bad_kind", "kind must be news or live");
  const ok = kind === "news"
    ? db().prepare("SELECT 1 FROM mhub_news n JOIN mhub_sources s ON s.id = n.source_id WHERE n.id = ? AND s.enabled = 1 AND n.hidden = 0").get(id)
    : db().prepare("SELECT 1 FROM mhub_sources WHERE id = ? AND kind = 'live' AND enabled = 1").get(id);
  if (!ok) throw new Bad("not_found", "no such item");
  db().prepare("INSERT INTO mhub_counts (kind,item_id,day,n) VALUES (?,?,?,1) ON CONFLICT (kind,item_id,day) DO UPDATE SET n = n + 1").run(kind, id, now.toISOString().slice(0, 10));
}

export function reportItem(personId: string, body: Record<string, unknown>, now: Date = new Date()): void {
  const kind = str(body.kind), item = str(body.id), reason = str(body.reason);
  if (!["video", "news", "live"].includes(kind)) throw new Bad("bad_kind", "kind must be video, news or live");
  if (!(REASONS as readonly string[]).includes(reason)) throw new Bad("bad_reason", "choose a reason from the list");
  const note = str(body.note);
  if (note && (note.length > 200 || hasLink(note) || asksSecret(note) || asksPartyPreference(note))) throw new Bad("bad_note", "the note is at most 200 characters, with no link, no code or ID number and no party choice");
  const exists = kind === "video" ? db().prepare("SELECT 1 FROM vcast_videos WHERE id = ?").get(item) : kind === "news" ? db().prepare("SELECT 1 FROM mhub_news WHERE id = ?").get(item) : db().prepare("SELECT 1 FROM mhub_sources WHERE id = ? AND kind = 'live'").get(item);
  if (!exists) throw new Bad("not_found", "no such item");
  const reporter = getKeys().hmac("media-report", `${kind}:${item}:${personId}`); // one report per person per item, and no person id in the table
  const r = db().prepare("INSERT OR IGNORE INTO mhub_reports (id,kind,item_id,reason,note,reporter,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), kind, item, reason, note || null, reporter, now.toISOString());
  if (Number(r.changes) === 0) throw new Bad("already_reported", "you have already reported this item");
}

export function resolveReport(adminId: string, id: string, action: unknown, now: Date = new Date()): void {
  const r = db().prepare("SELECT * FROM mhub_reports WHERE id = ? AND status = 'open'").get(id) as unknown as { kind: string; item_id: string } | undefined;
  if (!r) throw new Bad("not_found", "no open report with that id");
  if (action !== "dismiss" && action !== "takedown") throw new Bad("bad_action", "action must be dismiss or takedown");
  if (action === "takedown") {
    if (r.kind === "video") { try { recallVideo(adminId, r.item_id, "Withdrawn after a member report"); } catch (e) { if ((e as { code?: string }).code !== "not_live") throw e; } }
    else if (r.kind === "news") db().prepare("UPDATE mhub_news SET hidden = 1 WHERE id = ?").run(r.item_id);
    else db().prepare("UPDATE mhub_sources SET enabled = 0 WHERE id = ?").run(r.item_id);
  }
  // every open report on the same item is closed together
  db().prepare("UPDATE mhub_reports SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE kind = ? AND item_id = ? AND status = 'open'").run(adminId, now.toISOString(), String(action), r.kind, r.item_id);
  audit(adminId, "media.report." + String(action), `mhub-${r.kind}:${r.item_id}`);
}

export function numbers() {
  const rows = db().prepare("SELECT kind, item_id, SUM(n) AS total, MAX(day) AS last_day FROM mhub_counts GROUP BY kind, item_id").all() as unknown as { kind: string; item_id: string; total: number; last_day: string }[];
  const name = (kind: string, id: string): string => (kind === "news"
    ? (db().prepare("SELECT title FROM mhub_news WHERE id = ?").get(id) as { title: string } | undefined)?.title
    : (db().prepare("SELECT name_en FROM mhub_sources WHERE id = ?").get(id) as { name_en: string } | undefined)?.name_en) ?? id;
  const videos = db().prepare("SELECT id, title_en, views FROM vcast_videos WHERE status IN ('live','recalled')").all() as unknown as { id: string; title_en: string; views: number }[];
  return {
    min_shown: MIN_COUNT_SHOWN,
    items: [
      ...rows.map((r) => ({ kind: r.kind === "news" ? "news link opens" : "live channel opens", item_id: r.item_id, name: name(r.kind, r.item_id), total: r.total >= MIN_COUNT_SHOWN ? r.total : null, last_day: r.last_day })),
      ...videos.map((v) => ({ kind: "video plays", item_id: v.id, name: v.title_en, total: v.views >= MIN_COUNT_SHOWN ? v.views : null, last_day: null })),
    ],
  };
}

/* ---------------- routes ---------------- */

export const mediaRouter = Router();
mediaRouter.use(express.json({ limit: "16kb" }));
const wrap = (fn: (req: express.Request, res: express.Response) => void | Promise<void>) => (req: express.Request, res: express.Response): void => {
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (e instanceof Bad) fail(res, e.code === "not_found" ? 404 : ["same_person", "not_enabled", "already_reported"].includes(e.code) ? 409 : e.code === "fetch_failed" ? 502 : 400, e.code, e.message);
    else { console.error(e); fail(res, 500, "error", "server error"); }
  });
};
const adminOnly = [requireAuth, requireRole("admin")];

mediaRouter.get("/news", wrap((req, res) => {
  res.set("Cache-Control", "no-store");
  void refreshDue().catch(() => undefined); // never makes the reader wait
  res.json(newsFor(typeof req.query.state === "string" ? req.query.state : undefined));
}));
mediaRouter.get("/live", wrap((_req, res) => { res.set("Cache-Control", "no-store"); res.json({ channels: liveChannels() }); }));
mediaRouter.post("/click", wrap((req, res) => { countClick(str(req.body?.kind), str(req.body?.id)); res.json({ ok: true }); }));
mediaRouter.post("/report", requireAuth, wrap((req, res) => { reportItem(req.person!.id, req.body ?? {}); res.status(201).json({ ok: true }); }));

mediaRouter.get("/admin/sources", ...adminOnly, wrap((req, res) => {
  const rows = db().prepare("SELECT * FROM mhub_sources ORDER BY created_at DESC").all() as unknown as Src[];
  res.json({ sources: rows.map((s) => ({ ...s, enabled: s.enabled === 1, mine: s.created_by === req.person!.id || s.permission_by === req.person!.id, created_by: undefined, enabled_by: undefined, permission_by: undefined })), min_shown: MIN_COUNT_SHOWN, hosts: mediaVideoHosts() });
}));
mediaRouter.post("/admin/videos", ...adminOnly, wrap((req, res) => { const s = addVideoLink(req.person!.id, req.body ?? {}); res.status(201).json({ id: s.id }); }));
mediaRouter.post("/admin/sources", ...adminOnly, wrap((req, res) => { const s = addSource(req.person!.id, req.body ?? {}); res.status(201).json({ id: s.id }); }));
mediaRouter.post("/admin/sources/:id/permission", ...adminOnly, wrap((req, res) => { recordPermission(req.person!.id, String(req.params.id), req.body ?? {}); res.json({ ok: true }); }));
mediaRouter.post("/admin/sources/:id/enable", ...adminOnly, wrap((req, res) => { enableSource(req.person!.id, String(req.params.id)); res.json({ ok: true }); }));
mediaRouter.post("/admin/sources/:id/disable", ...adminOnly, wrap((req, res) => { disableSource(req.person!.id, String(req.params.id)); res.json({ ok: true }); }));
mediaRouter.post("/admin/sources/:id/refresh", ...adminOnly, wrap(async (req, res) => { res.json(await refreshSource(String(req.params.id))); }));
mediaRouter.post("/admin/sources/:id/check", ...adminOnly, wrap(async (req, res) => { res.json({ ok: await checkStream(String(req.params.id)) }); }));
mediaRouter.get("/admin/reports", ...adminOnly, wrap((_req, res) => {
  const rows = db().prepare("SELECT id, kind, item_id, reason, note, created_at, status, resolution FROM mhub_reports ORDER BY (status = 'open') DESC, created_at DESC LIMIT 100").all();
  res.json({ reports: rows });
}));
mediaRouter.post("/admin/reports/:id/resolve", ...adminOnly, wrap((req, res) => { resolveReport(req.person!.id, String(req.params.id), req.body?.action); res.json({ ok: true }); }));
mediaRouter.get("/admin/numbers", ...adminOnly, wrap((_req, res) => { res.json(numbers()); }));
