/**
 * Representative replies (S-145): storage and the public read side. Lives in the issues store, so the author is only a keyed actor
 * pseudonym (never a person id). A reply is a thread of immutable versions: a revision appends a row, nothing is edited in place.
 * Public display = the newest version that is visible; earlier visible versions are listed as history. Held and removed versions are
 * never shown publicly (the author and moderators can read them).
 * This file imports nothing from ../issues so the public issue page can use it without an import cycle.
 */
import { getStore, registerMigration, registerStoreErasureHook } from "../core";
import { schemeById } from "./schemes";

registerMigration("representatives_001_reply", `
CREATE TABLE IF NOT EXISTS rep_reply (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  author_id TEXT,
  constituency TEXT NOT NULL,
  body TEXT NOT NULL,
  scheme_tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  hold_reasons TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (issue_id, version)
);
CREATE INDEX IF NOT EXISTS rep_reply_status ON rep_reply(status, created_at);
CREATE TABLE IF NOT EXISTS grievance_link (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  system TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (issue_id, system)
);
`, "issues");

export type ReplyStatus = "visible" | "held" | "removed";
export interface ReplyRow {
  id: string; issue_id: string; version: number; author_id: string | null; constituency: string; body: string; scheme_tags: string; status: ReplyStatus;
  hold_reasons: string; note: string | null; decided_by: string | null; decided_at: string | null; created_at: string;
}
const db = () => getStore("issues");
const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

// Account erasure: the reply stays (it is an official public record) but loses the pseudonymous author link; decisions lose the moderator link.
registerStoreErasureHook("issues", "issues.rep_reply", (subjects) => {
  for (let i = 0; i < subjects.length; i += 500) {
    const c = subjects.slice(i, i + 500);
    db().prepare(`UPDATE rep_reply SET author_id = NULL WHERE author_id IN (${inList(c.length)})`).run(...c);
    db().prepare(`UPDATE rep_reply SET decided_by = NULL WHERE decided_by IN (${inList(c.length)})`).run(...c);
    db().prepare(`UPDATE grievance_link SET requested_by = NULL WHERE requested_by IN (${inList(c.length)})`).run(...c);
  }
});

export const repliesOf = (issueId: string): ReplyRow[] => db().prepare("SELECT * FROM rep_reply WHERE issue_id = ? ORDER BY version").all(issueId) as unknown as ReplyRow[];

export interface OfficialReplyView {
  label: "representative_reply";
  constituency: string;
  text: string;
  scheme_tags: { id: string; label_en: string; label_te: string }[];
  version: number;
  posted_at: string;
  updated_at: string;
  edited: boolean;
  history: { version: number; text: string; at: string }[];
}

/** The public view of an issue's representative reply, or null. `clean` is applied to every text (the public sanitiser, passed in to avoid an import cycle). */
export function officialReplyFor(issueId: string, clean: (t: string) => string | null = (t) => t): OfficialReplyView | null {
  const visible = repliesOf(issueId).filter((r) => r.status === "visible");
  if (!visible.length) return null;
  const cur = visible[visible.length - 1], first = visible[0];
  const tags = (JSON.parse(cur.scheme_tags) as string[]).map((id) => schemeById(id)).filter((s): s is NonNullable<typeof s> => !!s).map((s) => ({ id: s.id, label_en: s.label_en, label_te: s.label_te }));
  return {
    label: "representative_reply", constituency: cur.constituency, text: clean(cur.body) ?? "", scheme_tags: tags, version: cur.version,
    posted_at: first.created_at, updated_at: cur.created_at, edited: visible.length > 1,
    history: visible.slice(0, -1).map((r) => ({ version: r.version, text: clean(r.body) ?? "", at: r.created_at })),
  };
}
