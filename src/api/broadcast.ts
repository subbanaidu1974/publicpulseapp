import { call } from "./civic";

/** Broadcast polls (S-185). Kept out of civic.ts so the lite civic bundle (tests/civic/channels.size.test.ts) does not carry it. */
export interface PollOption { label_en: string; label_te: string | null; prefer_not: boolean }
export interface PollQuestion { kind: "single" | "multi" | "scale5"; text_en: string; text_te: string | null; max_select: number; options: PollOption[] }
export interface Poll { id: string; title_en: string; title_te: string | null; intro_en: string | null; intro_te: string | null; opened_at: string; closes_at: string | null; questions: PollQuestion[]; note_en: string; note_te: string }
export interface PollSummary { id: string; title_en: string; status: string; opened_at: string; closes_at: string | null; closed_at: string | null; responses: number }
export interface PollResults extends Poll { status: string; responses: number; min_results: number; suppressed: boolean; results: { text_en: string; options: { label_en: string; prefer_not: boolean; n: number | null }[] }[] }
export const broadcastApi = {
  pending: () => call<{ poll: Poll | null }>("/broadcast/pending", { fresh: true }),
  answer: (id: string, answers: number[][]) => call<{ ok: true }>(`/broadcast/${encodeURIComponent(id)}/answer`, { method: "POST", body: { answers } }),
  adminList: () => call<{ polls: PollSummary[]; registered_users: number }>("/broadcast/admin", { fresh: true }),
  adminCreate: (body: Record<string, unknown>) => call<Poll>("/broadcast/admin", { method: "POST", body }),
  adminResults: (id: string) => call<PollResults>(`/broadcast/admin/${encodeURIComponent(id)}/results`, { fresh: true }),
  adminClose: (id: string) => call<{ ok: true }>(`/broadcast/admin/${encodeURIComponent(id)}/close`, { method: "POST" }),
};
