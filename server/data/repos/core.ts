import type { Db } from "../types";

/**
 * The request-time part of the identity core on the data layer (S-250): the session lookup behind `requireAuth`, the sliding refresh, the session
 * list and revoke calls, and the role reads behind `requireRole`. Same SQL on SQLite and MySQL.
 * Creating a session, granting or revoking a role, the audit chain and the erasure framework stay with the synchronous core until their callers move.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export interface SessionInfo { id: string; created_at: string; last_seen_at: string | null; expires_at: string; label: string | null }
export interface AuthRow { id: string; tier: string; exp: string; sid: string | null; created: string; seen: string | null }

export class CoreStore {
  constructor(private db: Db) {}

  /** The live person behind a session token hash (deleted people never match); the caller checks the expiry. */
  authRow(tokenHash: string): Promise<AuthRow | undefined> {
    return this.db.get<AuthRow>(
      `SELECT p.id AS id, p.tier AS tier, s.expires_at AS exp, s.id AS sid, s.created_at AS created, s.last_seen_at AS seen
         FROM sessions s JOIN persons p ON p.id = s.person_id
        WHERE s.token_hash = ? AND p.deleted_at IS NULL`, [tokenHash]);
  }
  /** Slides the session: marks it seen and pushes the expiry out, never pulling it in. */
  async touch(tokenHash: string, seenIso: string, expiresIso: string): Promise<void> {
    await this.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE ? END WHERE token_hash = ?", [seenIso, expiresIso, expiresIso, tokenHash]);
  }
  /** Live sessions of a person, newest first (never the token or its hash). */
  list(personId: string, nowIso: string): Promise<SessionInfo[]> {
    return this.db.all<SessionInfo>("SELECT id, created_at, last_seen_at, expires_at, label FROM sessions WHERE person_id = ? AND expires_at > ? ORDER BY created_at DESC", [personId, nowIso]);
  }
  async revokeAll(personId: string): Promise<void> { await this.db.run("DELETE FROM sessions WHERE person_id = ?", [personId]); }
  /** True when it was this person's session (one person cannot end another's). */
  async revokeOne(personId: string, sessionId: string): Promise<boolean> { return Number((await this.db.run("DELETE FROM sessions WHERE person_id = ? AND id = ?", [personId, sessionId])).changes) > 0; }

  private async volunteerFlag(personId: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM persons WHERE id = ? AND role = 'volunteer' AND deleted_at IS NULL", [personId])); }
  /** Role names of a person, each once, with the volunteer flag on the person row counted as a volunteer grant. */
  async roleNames(personId: string): Promise<string[]> {
    const rows = await this.db.all<{ role: string }>("SELECT DISTINCT role FROM roles WHERE person_id = ? ORDER BY role", [personId]);
    const out = rows.map((r) => r.role);
    if (!out.includes("volunteer") && await this.volunteerFlag(personId)) out.push("volunteer");
    return out;
  }
  /** Does a live person hold any of these roles (any scope)? */
  async holdsAny(personId: string, roles: string[]): Promise<boolean> {
    if (roles.length === 0) return false;
    const marks = roles.map(() => "?").join(",");
    const hit = await this.db.get("SELECT 1 AS x FROM roles r JOIN persons p ON p.id = r.person_id WHERE r.person_id = ? AND p.deleted_at IS NULL AND r.role IN (" + marks + ")", [personId, ...roles]);
    return !!hit || (roles.includes("volunteer") && await this.volunteerFlag(personId));
  }
}
