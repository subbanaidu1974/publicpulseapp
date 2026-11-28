import type { Db } from "../types";

/**
 * Sign-in lockout state (S-59) on the data layer: one row per (person, source) holding the wrong-PIN streak, the lock and the time of the last good
 * sign-in. Same SQL on SQLite and MySQL. `sourceKey` is already a keyed hash (the caller computes it), so no address or device is stored here.
 */
export interface PinFailRow { failed: number; locked_until: string | null; ok_at: string | null }

export class PinFailureStore {
  constructor(private db: Db) {}

  async row(personId: string, sourceKey: string): Promise<PinFailRow | undefined> {
    const r = await this.db.get<PinFailRow>("SELECT failed, locked_until, ok_at FROM pin_failures WHERE person_id = ? AND source_key = ?", [personId, sourceKey]);
    return r && { ...r, failed: Number(r.failed) };
  }
  /** A good PIN: the streak and any lock clear, and the source is remembered as one that has signed in. */
  async success(personId: string, sourceKey: string, atIso: string): Promise<void> {
    await this.db.upsert("pin_failures", { person_id: personId, source_key: sourceKey, failed: 0, locked_until: null, ok_at: atIso, updated_at: atIso }, ["person_id", "source_key"], ["failed", "locked_until", "ok_at", "updated_at"]);
  }
  /** A wrong PIN: the new streak and the lock (when it was reached). The time of an earlier good sign-in is left as it was. */
  async failure(personId: string, sourceKey: string, failed: number, lockedUntil: string | null, atIso: string): Promise<void> {
    await this.db.upsert("pin_failures", { person_id: personId, source_key: sourceKey, failed, locked_until: lockedUntil, ok_at: null, updated_at: atIso }, ["person_id", "source_key"], ["failed", "locked_until", "updated_at"]);
  }
  /** Is any source locked out of this person's sign-in right now? */
  async lockedAnywhere(personId: string, nowIso: string): Promise<boolean> { return !!(await this.db.get("SELECT 1 AS x FROM pin_failures WHERE person_id = ? AND locked_until > ?", [personId, nowIso])); }
  /** Has this source ever signed in successfully as one of these people? */
  async knownSource(sourceKey: string, personIds: string[]): Promise<boolean> {
    if (personIds.length === 0) return false;
    return !!(await this.db.get(`SELECT 1 AS x FROM pin_failures WHERE source_key = ? AND ok_at IS NOT NULL AND person_id IN (${personIds.map(() => "?").join(",")})`, [sourceKey, ...personIds]));
  }
  async clearPerson(personId: string): Promise<void> { await this.db.run("DELETE FROM pin_failures WHERE person_id = ?", [personId]); }
}
