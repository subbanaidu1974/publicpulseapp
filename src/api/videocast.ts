import { call } from "./civic";

/** Video broadcasts (S-230). Kept out of civic.ts so the lite civic bundle does not carry it. */
export interface VideoItem { id: string; title_en: string; title_te: string | null; note_en: string | null; note_te: string | null; media_url: string; kind: "video" | "audio"; credit: string; live_at: string | null; library: boolean; transcript: string | null }
export interface Correction { id: string; title_en: string; title_te: string | null; note: string | null; withdrawn_at: string }
export interface AdminVideo extends VideoItem { status: "pending" | "live" | "scheduled" | "recalled" | "rejected"; mine: boolean; publish_at: string | null; recall_note: string | null; views: number | null; views_hidden_below: number }
export const videocastApi = {
  list: () => call<{ items: VideoItem[]; corrections: Correction[] }>("/videocast", { fresh: true }),
  view: (id: string) => call<{ ok: true }>(`/videocast/${encodeURIComponent(id)}/view`, { method: "POST" }),
  adminList: () => call<{ items: AdminVideo[]; registered_users: number }>("/videocast/admin", { fresh: true }),
  adminCreate: (body: Record<string, unknown>) => call<VideoItem>("/videocast/admin", { method: "POST", body }),
  adminApprove: (id: string) => call<{ ok: true }>(`/videocast/admin/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  adminReject: (id: string) => call<{ ok: true }>(`/videocast/admin/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  adminRecall: (id: string, note?: string) => call<{ ok: true }>(`/videocast/admin/${encodeURIComponent(id)}/recall`, { method: "POST", body: { note } }),
};

/** Videos this device has already opened. Kept only in this browser (never sent anywhere), so "new" badges need no per-person record on the server. */
const SEEN_KEY = "pp-video-seen";
export const seenIds = (): string[] => { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-200) : []; } catch { return []; } };
export const markSeen = (ids: string[]): void => {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...seenIds(), ...ids])].slice(-200))); window.dispatchEvent(new Event("pp-video-seen")); } catch { /* ignore */ }
};

/** "Do not alert me about new videos": kept only in this browser. It hides the badge and the jump to From us; the videos stay in From us. */
const MUTE_KEY = "pp-video-mute";
export const videosMuted = (): boolean => { try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; } };
export const setVideosMuted = (m: boolean): void => { try { if (m) localStorage.setItem(MUTE_KEY, "1"); else localStorage.removeItem(MUTE_KEY); window.dispatchEvent(new Event("pp-video-seen")); } catch { /* ignore */ } };
