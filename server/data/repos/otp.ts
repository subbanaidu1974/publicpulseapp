import type { Db } from "../types";

/**
 * One-time codes for sign-up, recovery and volunteer enrolment (S-161) on the data layer. Same SQL on SQLite and MySQL.
 * A code is only ever stored as a keyed hash; the caller computes it, and also lists the phone hashes under every active key version (newest first),
 * so a code written before a key rotation is still found and a new one is always written under the newest.
 */
export interface OtpRow { phone_hash: string; code_hash: string; expires_at: string; attempts: number }
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export class OtpStore {
  constructor(private db: Db) {}

  /** The row for (phone, purpose) under any of the candidate hashes, the newest key version first. */
  async row(candidates: string[], purpose: string): Promise<OtpRow | undefined> {
    const rows = await this.db.all<OtpRow>(`SELECT phone_hash, code_hash, expires_at, attempts FROM otps WHERE phone_hash IN (${marks(candidates.length)}) AND purpose = ?`, [...candidates, purpose]);
    return rows.map((r) => ({ ...r, attempts: Number(r.attempts) })).sort((a, b) => candidates.indexOf(a.phone_hash) - candidates.indexOf(b.phone_hash))[0];
  }
  /** Writes a fresh code under the newest hash and drops any older-version row, together; a code already there is replaced and its tries reset. */
  async store(candidates: string[], purpose: string, codeHash: string, expiresIso: string): Promise<void> {
    await this.db.tx(async (t) => {
      if (candidates.length > 1) await t.run(`DELETE FROM otps WHERE phone_hash IN (${marks(candidates.length - 1)}) AND purpose = ?`, [...candidates.slice(1), purpose]);
      await t.upsert("otps", { phone_hash: candidates[0], purpose, code_hash: codeHash, expires_at: expiresIso, attempts: 0 }, ["phone_hash", "purpose"]);
    });
  }
  async discard(candidates: string[], purpose: string): Promise<void> { await this.db.run(`DELETE FROM otps WHERE phone_hash IN (${marks(candidates.length)}) AND purpose = ?`, [...candidates, purpose]); }
  async wrongTry(phoneHash: string, purpose: string): Promise<void> { await this.db.run("UPDATE otps SET attempts = attempts + 1 WHERE phone_hash = ? AND purpose = ?", [phoneHash, purpose]); }
  /** True only for the one caller that removed the row, so a code cannot be used twice even by two requests at once. */
  async spend(phoneHash: string, purpose: string): Promise<boolean> { return Number((await this.db.run("DELETE FROM otps WHERE phone_hash = ? AND purpose = ?", [phoneHash, purpose])).changes) > 0; }
}
