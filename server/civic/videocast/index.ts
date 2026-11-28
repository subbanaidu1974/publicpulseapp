/**
 * Video broadcasts (S-230, S-231 first part): an admin publishes a video or audio item that every signed-in member sees as a card in the Media tab.
 * Mounted at /api/v1/civic/videocast. See docs/VIDEO_BROADCASTS.md.
 *
 *   POST /admin               admin: propose a video (status "pending"; nobody sees it yet)
 *   GET  /admin               admin: all items with status, who made it, and play counts (hidden under the minimum)
 *   POST /admin/:id/approve   a DIFFERENT admin: makes it live (now, or at its chosen start time)
 *   POST /admin/:id/reject    admin: refuses or withdraws a pending item
 *   POST /admin/:id/recall    admin: takes a live item down, with an optional short note
 *   GET  /                    signed-in: the live items, newest first
 *   POST /:id/view            signed-in: counts one play on a live item (a counter only: no person, no list of who watched)
 *
 * The media is never stored or copied here: an item is a link to a direct file (mp4, webm, mp3 and similar) on a host the admin is allowed to use,
 * plus a credit line. Unlike a poll it never blocks the app. Nothing here targets people by party, place or any trait: every signed-in member sees every live item.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { audit, registerMigration, requireAuth, requireRole } from "../core";
import { identityDb } from "../core/asyncBridge";
import { VideoStore, type VideoRow } from "../../data/repos/videocast";
import { asksPartyPreference, asksSecret, hasLink } from "../broadcast";
import { mediaVideoHosts } from "../../security";

registerMigration("vcast_001_core", `
CREATE TABLE vcast_videos (
  id TEXT PRIMARY KEY, title_en TEXT NOT NULL, title_te TEXT, note_en TEXT, note_te TEXT,
  media_url TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('video','audio')), credit TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','live','recalled','rejected')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, publish_at TEXT,
  decided_by TEXT, decided_at TEXT, live_at TEXT, recall_note TEXT, views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_vcast_status ON vcast_videos(status, live_at);
`);
registerMigration("vcast_002_library_windows", `
ALTER TABLE vcast_videos ADD COLUMN library INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vcast_videos ADD COLUMN transcript TEXT;
CREATE TABLE vcast_windows (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, ended_by TEXT, ended_at TEXT
);
`);

export const MIN_VIEWS_SHOWN = 10; // play counts are hidden below this, like poll results
const MAX_PENDING = 20, MAX_LIVE_LISTED = 30;
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv)$/i, AUDIO_EXT = /\.(mp3|m4a|ogg|oga|opus|wav)$/i;

class Bad extends Error { constructor(public code: string, m: string) { super(m); } }
const str = (v: unknown): string => (typeof v === "string" ? v.normalize("NFKC").trim() : "");
const fail = (res: express.Response, status: number, code: string, message: string): void => { res.status(status).json({ error: code, code, message }); };
const st = (): VideoStore => new VideoStore(identityDb());

type Row = VideoRow;

/** A direct media file: https (http only for localhost outside production), no login in the address, an audio or video file name, and not too long. */
export function checkMediaUrl(raw: string): { url: string; kind: "video" | "audio" } {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Bad("bad_url", "the media address is not a valid web address"); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && process.env.NODE_ENV !== "production")) throw new Bad("bad_url", "the media address must start with https://");
  if (u.username || u.password) throw new Bad("bad_url", "the media address must not contain a login");
  if (!local && !mediaVideoHosts().includes(u.hostname.toLowerCase())) throw new Bad("host_not_allowed", "this host is not on the approved list for broadcast videos (MEDIA_VIDEO_HOSTS)");
  if (raw.length > 500) throw new Bad("bad_url", "the media address is too long");
  const kind = VIDEO_EXT.test(u.pathname) ? "video" : AUDIO_EXT.test(u.pathname) ? "audio" : null;
  if (!kind) throw new Bad("bad_url", "the address must point straight to a video or audio file (mp4, webm, mp3, m4a, ogg, wav)");
  return { url: u.toString(), kind };
}

function cleanText(label: string, v: unknown, min: number, max: number, required: boolean): string | null {
  const s = str(v);
  if (!s) { if (required) throw new Bad("bad_" + label, `${label} is required`); return null; }
  if (s.length < min || s.length > max) throw new Bad("bad_" + label, `${label}: ${min} to ${max} characters`);
  if (hasLink(s) || asksSecret(s)) throw new Bad("text_refused", `${label} contains a link or asks for a code, PIN, password or ID number`);
  if (asksPartyPreference(s)) throw new Bad("party_preference_refused", `${label} asks people to choose or vote for a party or candidate`);
  return s;
}

const mine = (r: Row, me: string) => r.created_by === me;
const status = (r: Row, now: string) => (r.status === "live" && r.live_at && r.live_at > now ? "scheduled" : r.status);
const member = (r: Row) => ({ library: r.library === 1, transcript: r.transcript, id: r.id, title_en: r.title_en, title_te: r.title_te, note_en: r.note_en, note_te: r.note_te, media_url: r.media_url, kind: r.kind, credit: r.credit, live_at: r.live_at });

export async function createVideo(adminId: string, body: Record<string, unknown>, now: Date = new Date()): Promise<Row> {
  const title_en = cleanText("title", body.title_en, 5, 120, true)!, title_te = cleanText("title_te", body.title_te, 3, 160, false);
  const note_en = cleanText("note", body.note_en, 3, 400, false), note_te = cleanText("note_te", body.note_te, 3, 600, false);
  const credit = cleanText("credit", body.credit, 3, 160, true)!;
  const transcript = cleanText("transcript", body.transcript, 20, 4000, false);
  const library = body.library === true ? 1 : 0;
  const { url, kind } = checkMediaUrl(str(body.media_url));
  if (body.confirm_neutral !== true || body.confirm_rights !== true) throw new Bad("confirm_required", "tick both boxes: the video does not promote a party or candidate, and we have the right to show it");
  let publish_at: string | null = null;
  if (body.publish_at !== undefined && body.publish_at !== null && body.publish_at !== "") {
    const t = new Date(String(body.publish_at));
    if (Number.isNaN(t.getTime()) || t.getTime() > now.getTime() + 30 * 86_400_000) throw new Bad("bad_publish_at", "the start time must be a valid time within the next 30 days");
    if (t.getTime() > now.getTime()) publish_at = t.toISOString();
  }
  if ((await st().pendingCount()) >= MAX_PENDING) throw new Bad("too_many_pending", `at most ${MAX_PENDING} items can wait for approval; decide some first`);
  const id = crypto.randomUUID();
  await st().insert({ id, title_en, title_te, note_en, note_te, media_url: url, kind, credit, created_by: adminId, at: now.toISOString(), publish_at, library, transcript });
  audit(adminId, "videocast.propose", "vcast:" + id, { kind });
  return await get(id);
}

async function get(id: string): Promise<Row> {
  const r = await st().get(id);
  if (!r) throw new Bad("not_found", "no such item");
  return r;
}

/** Silence windows (S-231): while a window is active, nothing goes live. A start time that falls inside one (or inside several that touch) is moved to the end of the last. */
export interface SilenceWindow { id: string; label: string; starts_at: string; ends_at: string; created_by: string; ended: boolean }
export async function activeWindows(): Promise<SilenceWindow[]> {
  return (await st().activeWindows()).map((w) => ({ ...w, ended: false }));
}
export async function afterSilence(iso: string): Promise<string> {
  let t = iso;
  for (let i = 0; i < 20; i++) {
    const w = (await activeWindows()).find((x) => x.starts_at <= t && t < x.ends_at);
    if (!w) return t;
    t = w.ends_at;
  }
  return t;
}
export async function addWindow(adminId: string, body: Record<string, unknown>, now: Date = new Date()): Promise<SilenceWindow> {
  const label = cleanText("label", body.label, 3, 120, true)!;
  const a = new Date(String(body.starts_at)), b = new Date(String(body.ends_at));
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new Bad("bad_window", "start and end must be valid times");
  if (b.getTime() <= a.getTime() || b.getTime() - a.getTime() > 14 * 86_400_000) throw new Bad("bad_window", "the end must be after the start and within 14 days of it");
  if (b.getTime() < now.getTime()) throw new Bad("bad_window", "the window is already over");
  if (a.getTime() > now.getTime() + 365 * 86_400_000) throw new Bad("bad_window", "the start must be within a year");
  const id = crypto.randomUUID();
  await st().insertWindow({ id, label, starts_at: a.toISOString(), ends_at: b.toISOString(), created_by: adminId, at: now.toISOString() });
  // Anything already live, or approved for a time inside the window, is held until it ends. Nothing is recalled: it simply stops being listed.
  await st().holdUntil(a.toISOString(), b.toISOString());
  audit(adminId, "videocast.window.add", "vcast-window:" + id, { starts_at: a.toISOString(), ends_at: b.toISOString() });
  return { id, label, starts_at: a.toISOString(), ends_at: b.toISOString(), created_by: adminId, ended: false };
}
/** Ending a window early needs a different admin than the one who made it, so one person cannot lift a hold alone. */
export async function endWindow(adminId: string, id: string, now: Date = new Date()): Promise<void> {
  const w = await st().openWindow(id);
  if (!w) throw new Bad("not_found", "no such active window");
  if (w.ends_at > now.toISOString() && w.created_by === adminId) throw new Bad("same_person", "a different admin must end a window that is still running");
  await st().endWindow(id, adminId, now.toISOString());
  // Videos held until this window's end are released now, unless another running window still covers this moment.
  await st().release(w.ends_at, now.toISOString(), await afterSilence(now.toISOString()));
  audit(adminId, "videocast.window.end", "vcast-window:" + id);
}

/** Items withdrawn in the last 7 days that members had been able to see, so a person who saw one learns it was withdrawn and why. */
export async function correctionsFor(now: Date = new Date()) {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await st().corrections(since);
  return rows.map((r) => ({ id: r.id, title_en: r.title_en, title_te: r.title_te, note: r.recall_note, withdrawn_at: r.decided_at }));
}

export async function approveVideo(adminId: string, id: string, now: Date = new Date()): Promise<Row> {
  const r = await get(id);
  if (r.status !== "pending") throw new Bad("not_pending", "only an item waiting for approval can be approved");
  if (r.created_by === adminId) throw new Bad("same_person", "a different admin must approve it");
  const live = await afterSilence(r.publish_at && r.publish_at > now.toISOString() ? r.publish_at : now.toISOString());
  await st().approve(id, adminId, now.toISOString(), live);
  audit(adminId, "videocast.approve", "vcast:" + id, { live_at: live });
  return await get(id);
}

export async function rejectVideo(adminId: string, id: string, now: Date = new Date()): Promise<Row> {
  const r = await get(id);
  if (r.status !== "pending") throw new Bad("not_pending", "only an item waiting for approval can be refused");
  await st().reject(id, adminId, now.toISOString());
  audit(adminId, "videocast.reject", "vcast:" + id);
  return await get(id);
}

export async function recallVideo(adminId: string, id: string, note: unknown, now: Date = new Date()): Promise<Row> {
  const r = await get(id);
  if (r.status !== "live") throw new Bad("not_live", "only a live item can be recalled");
  const n = cleanText("note", note, 3, 200, false);
  await st().recall(id, adminId, now.toISOString(), n);
  audit(adminId, "videocast.recall", "vcast:" + id);
  return await get(id);
}

export async function liveFor(now: Date = new Date()) {
  return (await st().live(now.toISOString(), MAX_LIVE_LISTED)).map(member);
}

export async function countView(id: string, now: Date = new Date()): Promise<void> {
  if (!(await st().countView(id, now.toISOString()))) throw new Bad("not_found", "no live item with that id");
}

export const videocastRouter = Router();
videocastRouter.use(express.json({ limit: "16kb" }));
const wrap = (fn: (req: express.Request, res: express.Response) => void | Promise<void>) => async (req: express.Request, res: express.Response): Promise<void> => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof Bad) fail(res, e.code === "not_found" ? 404 : ["same_person", "not_pending", "not_live", "too_many_pending"].includes(e.code) ? 409 : 400, e.code, e.message);
    else { console.error(e); fail(res, 500, "error", "server error"); }
  }
};
const adminOnly = [requireAuth, requireRole("admin")];

videocastRouter.post("/admin", ...adminOnly, wrap(async (req, res) => { const r = await createVideo(req.person!.id, req.body ?? {}); res.status(201).json({ ...member(r), status: r.status, mine: true }); }));
videocastRouter.get("/admin", ...adminOnly, wrap(async (req, res) => {
  const now = new Date().toISOString();
  const rows = await st().listAdmin();
  res.json({ items: rows.map((r) => ({ ...member(r), status: status(r, now), mine: mine(r, req.person!.id), publish_at: r.publish_at, recall_note: r.recall_note, views: r.views >= MIN_VIEWS_SHOWN ? r.views : null, views_hidden_below: MIN_VIEWS_SHOWN })), registered_users: await st().registeredUsers() });
}));
videocastRouter.post("/admin/:id/approve", ...adminOnly, wrap(async (req, res) => { const r = await approveVideo(req.person!.id, String(req.params.id)); res.json({ ok: true, status: r.status, live_at: r.live_at }); }));
videocastRouter.post("/admin/:id/reject", ...adminOnly, wrap(async (req, res) => { await rejectVideo(req.person!.id, String(req.params.id)); res.json({ ok: true }); }));
videocastRouter.post("/admin/:id/recall", ...adminOnly, wrap(async (req, res) => { await recallVideo(req.person!.id, String(req.params.id), req.body?.note); res.json({ ok: true }); }));
videocastRouter.get("/admin/windows", ...adminOnly, wrap(async (_req, res) => { res.json({ windows: await activeWindows() }); }));
videocastRouter.post("/admin/windows", ...adminOnly, wrap(async (req, res) => { res.status(201).json(await addWindow(req.person!.id, req.body ?? {})); }));
videocastRouter.post("/admin/windows/:id/end", ...adminOnly, wrap(async (req, res) => { await endWindow(req.person!.id, String(req.params.id)); res.json({ ok: true }); }));
videocastRouter.get("/", requireAuth, wrap(async (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ items: await liveFor(), corrections: await correctionsFor() }); }));
videocastRouter.post("/:id/view", requireAuth, wrap(async (req, res) => { await countView(String(req.params.id)); res.json({ ok: true }); }));
