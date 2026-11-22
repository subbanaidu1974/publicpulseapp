/**
 * Keyed pseudonyms: how the issues store refers to people without holding a persons.id (S-74, docs/STORES.md).
 *
 *   reporterPseudonym(issueId, personId)   HMAC under purpose "reporter-pseudonym". One value per (issue, person): the reporter, a me-too
 *                                          supporter, a sampled neighbour and an appellant of the SAME issue share it (so uniqueness and
 *                                          "is this the reporter" checks work), but nothing links two issues of one person in the issues store.
 *   mediaOwnerPseudonym(mediaId, personId) same purpose, per upload (an upload exists before its issue does).
 *   actorPseudonym(personId)               HMAC under "actor-pseudonym": stable per staff member so moderation/lexicon accountability and
 *                                          dual control (proposer != reviewer) keep working without a person id.
 *   ivrPseudonym(personId)                 matches IVR call state rows to a person for erasure.
 *
 * The identity store keeps the way back only as `issue_links`: a keyed link_key plus the object reference ENCRYPTED, so it can answer
 * "which issues am I behind" (my issues, erasure, neighbour sampling) but its values never equal anything in the issues database.
 */
import { getDb, getKeys } from "./index";

const PURPOSE = "reporter-pseudonym";

export const reporterPseudonym = (issueId: string, personId: string): string => getKeys().hmac(PURPOSE, `issue:${issueId}:${personId}`);
export const mediaOwnerPseudonym = (mediaId: string, personId: string): string => getKeys().hmac(PURPOSE, `media:${mediaId}:${personId}`);
export const actorPseudonym = (personId: string): string => getKeys().hmac("actor-pseudonym", personId);
export const ivrPseudonym = (personId: string): string => getKeys().hmac(PURPOSE, `ivr:${personId}`);

/** Values that are not pseudonyms (already-erased markers) and must be left alone when converting data. */
export const isErasedMarker = (v: string | null | undefined): boolean => !v || v === "erased" || v === "redacted" || v.startsWith("erased:") || v.startsWith("redacted:");

export type LinkKind = "issue" | "media";

/** Record (idempotently, in the IDENTITY store) that `personId` is behind an issue-store object. `village` enables neighbour sampling by village. */
export function linkPerson(personId: string, kind: LinkKind, ref: string, village?: string | null, now: Date = new Date()): void {
  const k = getKeys();
  getDb().prepare("INSERT OR IGNORE INTO issue_links (person_id, link_key, kind, ref_enc, village_lgd, ts) VALUES (?,?,?,?,?,?)")
    .run(personId, k.hmac("issue-link", `${personId}|${kind}|${ref}`), kind, k.encrypt("issue-link", JSON.stringify({ kind, ref })), village ?? null, now.toISOString());
}

function decodeRef(enc: string): { kind: LinkKind; ref: string } | null {
  try { return JSON.parse(getKeys().decrypt("issue-link", enc)) as { kind: LinkKind; ref: string }; } catch { return null; }
}

/** Issue ids a person is behind (reported, supported, sampled, appealed). Reads the identity store only. */
export function myIssueIds(personId: string): string[] {
  const rows = getDb().prepare("SELECT ref_enc FROM issue_links WHERE person_id = ? AND kind = 'issue'").all(personId) as { ref_enc: string }[];
  return rows.map((r) => decodeRef(r.ref_enc)).filter((x): x is { kind: LinkKind; ref: string } => !!x).map((x) => x.ref);
}

/** Every pseudonym the person has in the issues store: per-issue, per-upload, actor and IVR. */
export function pseudonymsOf(personId: string): string[] {
  const out = new Set<string>([actorPseudonym(personId), ivrPseudonym(personId)]);
  const rows = getDb().prepare("SELECT ref_enc FROM issue_links WHERE person_id = ?").all(personId) as { ref_enc: string }[];
  for (const r of rows) {
    const x = decodeRef(r.ref_enc);
    if (!x) continue;
    out.add(x.kind === "issue" ? reporterPseudonym(x.ref, personId) : mediaOwnerPseudonym(x.ref, personId));
  }
  return [...out];
}

/** Persons who reported in a village (for neighbour sampling), random order, from the identity store's link ledger. */
export function randomVillageReporters(village: string, limit: number): string[] {
  return (getDb().prepare("SELECT DISTINCT person_id FROM issue_links WHERE kind = 'issue' AND village_lgd = ? ORDER BY RANDOM() LIMIT ?").all(village, limit) as { person_id: string }[]).map((r) => r.person_id);
}
