import { ApiError } from "./client";
import { useApi } from "./useApi";

/** Typed client + hooks for the people endpoints (server/people-api.ts). All shapes are fixed per page type (MCC neutrality). */

export interface PartyRef { code: string; name: string; nameTe: string | null; color: string }
export interface PhotoOut { src: string; author: string; licence: string; licenceUrl: string | null; source: string; attributionRequired: boolean }
export interface MemberNote { kind: string; status: "confirmed" | "reported"; date: string; note: string; sources: string[] }
export interface MemberRow {
  state: "AP" | "TG"; type: "assembly" | "ls"; acNo: number; acName: string; district: string | null;
  member: { name: string; party: PartyRef; initials: string; basis: "election" | "overlay"; electionYear: number; since: string | null } | null;
  vacant: boolean; photo: PhotoOut | null; notes: MemberNote[];
}
export interface MemberDetail extends MemberRow { electionYear: number; blackout: boolean; notice: { en: string; te: string } | null }
export interface MembersResponse { state: string; type: string; electionYear: number; members: MemberRow[]; blackout: boolean; notice: { en: string; te: string } | null }

export interface OfficeHolder {
  id: string; state: "AP" | "TG"; role: string; person: string; party: string; start: string;
  sources: string[]; wikidata: string | null; asOf: string; confidence: string;
}
export interface OfficeHoldersResponse { officeHolders: OfficeHolder[]; blackout: boolean; notice: { en: string; te: string } | null; asOf: string }

export interface PartyMedia {
  code: string; kind: "flag" | "symbol"; path: string; sha256: string; author: string; licence: string; licenceUrl: string | null; source: string;
  use: "decorative" | "identification-only"; restrictions: string | null; verified: string;
}
export interface PartyProfile {
  code: string; name: { en: string; te: string | null }; color: string; website: string | null;
  wikidata: { qid: string; url: string } | null;
  founded: { year: number; confidence: string; event: string | null } | null;
  flag: PartyMedia | null; symbol: PartyMedia | null;
  elections: { state: "AP" | "TG"; type: "assembly" | "ls"; year: number; contested: number; seatsWon: number; totalSeats: number; voteSharePct: number | null;
    alliances: { name: string; kind: "pre-poll" | "post-hoc"; confidence: string; kindLabel: string; sources: string[] }[] }[];
  leaders: OfficeHolder[]; sources: { name: string; url: string }[]; registryAsOf: string; officeHoldersAsOf: string;
  blackout: boolean; notice: { en: string; te: string } | null;
}
export interface PartyListItem { code: string; name: string; nameTe: string | null; color: string }

export interface ContestantRecord {
  id: string; state: "AP" | "TG"; type: "assembly" | "ls"; year: number; acNo: number; acName: string; district: string | null;
  position: number; votes: number; voteSharePct: number | null; marginVotes: number | null; won: boolean;
}
export interface ContestantProfile {
  id: string; name: string; initials: string; party: PartyRef; record: ContestantRecord;
  attributes: { sex: "M" | "F" | "O" | null; age: number | null; incumbent: boolean | null };
  otherElections: ContestantRecord[];
  links: { label: string; url: string; verified: string | null }[];
  source: { provenance: string | null; attribution: string };
}
export interface ContestantHit { id: string; name: string; party: PartyRef; state: "AP" | "TG"; type: "assembly" | "ls"; year: number; acNo: number; acName: string; position: number }
export interface PeopleStatus { blackout: boolean; notice: { en: string; te: string }; slaDays: number }

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch("/api/v1" + path);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((body as { error?: string }).error ?? "error", r.status, (body as { code?: string }).code ?? "");
  return body as T;
}

export const peopleApi = {
  status: () => getJson<PeopleStatus>("/people/status"),
  parties: () => getJson<{ parties: PartyListItem[] }>("/parties"),
  party: (code: string) => getJson<PartyProfile>(`/parties/${encodeURIComponent(code)}`),
  officeHolders: (state?: string) => getJson<OfficeHoldersResponse>("/office-holders" + (state ? `?state=${state}` : "")),
  members: (state: string, type: string) => getJson<MembersResponse>(`/members/${state}?type=${type}`),
  member: (state: string, type: string, acNo: number) => getJson<MemberDetail>(`/members/${state}/${type}/${acNo}`),
  contestant: (id: string) => getJson<ContestantProfile>(`/contestants/${encodeURIComponent(id)}`),
  search: (q: string, state?: string, type?: string) =>
    getJson<{ results: ContestantHit[] }>(`/contestants?q=${encodeURIComponent(q)}${state ? `&state=${state}` : ""}${type ? `&type=${type}` : ""}`),
  report: async (body: Record<string, unknown>) => {
    const r = await fetch("/api/v1/people/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError((j as { error?: string }).error ?? "error", r.status, (j as { code?: string }).code ?? "");
    return j as { ok: boolean; id?: string; slaDays?: number; dueBy?: string; hiddenPendingReview?: boolean };
  },
};

/** Current member of one seat (name, party, optional licensed photo, notes with citations). Use in the constituency profile. */
export function useMembers(state: string, type: "assembly" | "ls", acNo: number | null) {
  return useApi<MemberDetail | null>(() => (acNo === null ? Promise.resolve(null) : peopleApi.member(state, type, acNo)), [state, type, acNo]);
}
export const useParty = (code: string) => useApi(() => peopleApi.party(code), [code]);
export const useContestant = (id: string) => useApi(() => peopleApi.contestant(id), [id]);
export const useOfficeHolders = (state?: string) => useApi(() => peopleApi.officeHolders(state), [state]);
export const useMemberRoster = (state: string, type: string) => useApi(() => peopleApi.members(state, type), [state, type]);
export const usePartyList = () => useApi(() => peopleApi.parties(), []);
