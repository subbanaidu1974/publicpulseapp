import { call } from "./civic";

/** Media hub (S-225 to S-236): news, live channels, reports and admin screens. Kept out of civic.ts so the lite civic bundle does not carry it. */
export interface NewsItem { id: string; title: string; link: string; snippet: string | null; published_at: string; outlet_en: string; outlet_te: string | null; source_id: string; youtube: string | null }
export interface NewsPayload { items: NewsItem[]; digest: NewsItem[]; sources: { id: string; name_en: string; name_te: string | null; stale: boolean }[] }
export interface LiveChannel { id: string; name_en: string; name_te: string | null; site_url: string; stream_url: string | null; health_ok: boolean | null; health_at: string | null }
export interface AdminSource {
  id: string; kind: "news" | "live"; name_en: string; name_te: string | null; site_url: string; feed_url: string | null; stream_url: string | null; allow: "headline" | "snippet"; state: "AP" | "TG" | "BOTH";
  permission_note: string | null; permission_date: string | null; contact: string | null; enabled: boolean; mine: boolean; last_fetch_at: string | null; last_ok_at: string | null; last_error: string | null; health_ok: number | null; health_at: string | null;
}
export interface Report { id: string; kind: string; item_id: string; reason: string; note: string | null; created_at: string; status: string; resolution: string | null }
export interface NumberRow { kind: string; item_id: string; name: string; total: number | null; last_day: string | null }
export interface SilenceWindow { id: string; label: string; starts_at: string; ends_at: string; created_by: string }

export const mediaApi = {
  news: (state?: string) => call<NewsPayload>(`/media/news${state ? `?state=${encodeURIComponent(state)}` : ""}`, { fresh: true, auth: false }),
  live: () => call<{ channels: LiveChannel[] }>("/media/live", { fresh: true, auth: false }),
  click: (kind: "news" | "live", id: string) => call<{ ok: true }>("/media/click", { method: "POST", body: { kind, id }, auth: false }),
  report: (body: { kind: "video" | "news" | "live"; id: string; reason: string; note?: string }) => call<{ ok: true }>("/media/report", { method: "POST", body }),
  adminSources: () => call<{ sources: AdminSource[]; hosts: string[] }>("/media/admin/sources", { fresh: true }),
  demoVideos: () => call<{ videos: { id: string; title: string; media_url: string; credit: string }[] }>("/media/demo-videos", { fresh: true }),
  adminAddVideoLink: (body: Record<string, unknown>) => call<{ id: string }>("/media/admin/videos", { method: "POST", body }),
  adminAddSource: (body: Record<string, unknown>) => call<{ id: string }>("/media/admin/sources", { method: "POST", body }),
  adminPermission: (id: string, body: { permission_note: string; permission_date: string; contact: string }) => call<{ ok: true }>(`/media/admin/sources/${encodeURIComponent(id)}/permission`, { method: "POST", body }),
  adminEnable: (id: string) => call<{ ok: true }>(`/media/admin/sources/${encodeURIComponent(id)}/enable`, { method: "POST" }),
  adminDisable: (id: string) => call<{ ok: true }>(`/media/admin/sources/${encodeURIComponent(id)}/disable`, { method: "POST" }),
  adminRefresh: (id: string) => call<{ added: number }>(`/media/admin/sources/${encodeURIComponent(id)}/refresh`, { method: "POST" }),
  adminCheck: (id: string) => call<{ ok: boolean }>(`/media/admin/sources/${encodeURIComponent(id)}/check`, { method: "POST" }),
  adminReports: () => call<{ reports: Report[] }>("/media/admin/reports", { fresh: true }),
  adminResolve: (id: string, action: "dismiss" | "takedown") => call<{ ok: true }>(`/media/admin/reports/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { action } }),
  adminNumbers: () => call<{ min_shown: number; items: NumberRow[] }>("/media/admin/numbers", { fresh: true }),
  windows: () => call<{ windows: SilenceWindow[] }>("/videocast/admin/windows", { fresh: true }),
  addWindow: (body: Record<string, unknown>) => call<SilenceWindow>("/videocast/admin/windows", { method: "POST", body }),
  endWindow: (id: string) => call<{ ok: true }>(`/videocast/admin/windows/${encodeURIComponent(id)}/end`, { method: "POST" }),
};
