import type { Db } from "../types";

/**
 * Households (S-21, S-22, S-61, S-149) on the data layer: the household and its head, accepted adult members and minor dependents, invites (which hold only a
 * keyed hash of the number, dropped as soon as the invite is decided or expires), the cool-down list and head transfers. Same SQL on SQLite and MySQL.
 * Multi-step changes (accepting an invite, handing over the head role, dissolving a household) are done by the caller inside `Db.tx`, using a store made from the
 * transaction handle. Times here are epoch milliseconds (BIGINT on MySQL, coerced to numbers). The one `persons` write is the PIN set when an invitee accepts
 * without having one (the PIN itself lives in identity).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
const num = (v: unknown): number => Number(v);
const nums = (r: Row | undefined, ...cols: string[]): Row | undefined => { if (!r) return r; const o = { ...r }; for (const c of cols) if (o[c] != null) o[c] = num(o[c]); return o; };
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export class HouseholdStore {
  constructor(private db: Db) {}
  private one(sql: string, p: (string | number | null)[] = []): Promise<Row | undefined> { return this.db.get<Row>(sql, p); }
  private many(sql: string, p: (string | number | null)[] = []): Promise<Row[]> { return this.db.all<Row>(sql, p); }
  private async run(sql: string, p: (string | number | null)[] = []): Promise<number> { return num((await this.db.run(sql, p)).changes); }

  // ---- housekeeping ----
  /** Expired pending invites lose their phone hash; elapsed cool-downs go; pending transfers that ran out are marked expired. */
  async expireStale(now: number): Promise<void> {
    await this.run("UPDATE hh_invite SET status='expired', phone_hash=NULL WHERE status='pending' AND expires_at <= ?", [now]);
    await this.run("DELETE FROM hh_invite_cooldown WHERE until <= ?", [now]);
    await this.run("UPDATE hh_transfer SET status='expired' WHERE status='pending' AND expires_at <= ?", [now]);
  }

  // ---- households and members ----
  async byHead(personId: string): Promise<Row | undefined> { return nums(await this.one("SELECT * FROM hh_household WHERE head_person_id = ?", [personId]), "created_at"); }
  async memberHouseholdId(personId: string): Promise<string | undefined> { return (await this.one("SELECT household_id FROM hh_member WHERE person_id = ?", [personId]))?.household_id; }
  async household(id: string): Promise<Row | undefined> { return nums(await this.one("SELECT * FROM hh_household WHERE id = ?", [id]), "created_at"); }
  async headOf(id: string): Promise<string | undefined> { return (await this.one("SELECT head_person_id FROM hh_household WHERE id = ?", [id]))?.head_person_id; }
  async insertHousehold(id: string, headPersonId: string, at: number): Promise<void> { await this.run("INSERT INTO hh_household (id, head_person_id, created_at) VALUES (?,?,?)", [id, headPersonId, at]); }
  async setHead(id: string, personId: string): Promise<void> { await this.run("UPDATE hh_household SET head_person_id = ? WHERE id = ?", [personId, id]); }
  members(householdId: string): Promise<Row[]> { return this.many("SELECT id, person_id, relation, status, year_of_birth FROM hh_member WHERE household_id = ? ORDER BY created_at", [householdId]); }
  async dependentCount(householdId: string): Promise<number> { return num((await this.one("SELECT COUNT(*) AS c FROM hh_member WHERE household_id = ? AND status = 'dependent'", [householdId]))!.c); }
  async insertAdult(m: { id: string; household_id: string; person_id: string; relation: string; consent_id: string | null; at: number }): Promise<void> {
    await this.run("INSERT INTO hh_member (id, household_id, person_id, relation, status, consent_id, created_at) VALUES (?,?,?,?,?,?,?)", [m.id, m.household_id, m.person_id, m.relation, "accepted", m.consent_id, m.at]);
  }
  /** A dependent holds no name, no phone and no person id; the table's CHECK enforces that. */
  async insertDependent(m: { id: string; household_id: string; relation: string; year_of_birth: number; consent_id: string | null; at: number }): Promise<void> {
    await this.run("INSERT INTO hh_member (id, household_id, person_id, relation, status, year_of_birth, consent_id, created_at) VALUES (?,?,NULL,?,?,?,?,?)", [m.id, m.household_id, m.relation, "dependent", m.year_of_birth, m.consent_id, m.at]);
  }
  async acceptedMemberId(householdId: string, personId: string): Promise<string | undefined> { return (await this.one("SELECT id FROM hh_member WHERE household_id=? AND person_id=? AND status='accepted'", [householdId, personId]))?.id; }
  async member(id: string, householdId: string): Promise<Row | undefined> { return this.one("SELECT * FROM hh_member WHERE id=? AND household_id=?", [id, householdId]); }
  async deleteMember(id: string): Promise<void> { await this.run("DELETE FROM hh_member WHERE id = ?", [id]); }
  async deleteMemberOf(personId: string, householdId: string): Promise<void> { await this.run("DELETE FROM hh_member WHERE person_id = ? AND household_id = ?", [personId, householdId]); }
  dependentsBornBy(year: number): Promise<{ id: string; household_id: string }[]> { return this.many("SELECT id, household_id FROM hh_member WHERE status='dependent' AND year_of_birth <= ?", [year]) as Promise<{ id: string; household_id: string }[]>; }
  /** Removes the household with its members (dependents included) and invites. Call inside a transaction. */
  async dissolve(householdId: string): Promise<void> {
    await this.run("DELETE FROM hh_member WHERE household_id = ?", [householdId]);
    await this.run("DELETE FROM hh_invite WHERE household_id = ?", [householdId]);
    await this.run("DELETE FROM hh_household WHERE id = ?", [householdId]);
  }
  /** The identity PIN, set when an invitee who had none accepts (the PIN lives in the persons table). */
  async setPin(personId: string, salt: string, hash: string): Promise<void> { await this.run("UPDATE persons SET pin_salt = ?, pin_hash = ? WHERE id = ?", [salt, hash, personId]); }

  // ---- invites and the cool-down list ----
  async invite(id: string): Promise<Row | undefined> { return nums(await this.one("SELECT * FROM hh_invite WHERE id = ?", [id]), "created_at", "expires_at"); }
  async inviteState(id: string): Promise<{ status: string; expires_at: number } | undefined> { return nums(await this.one("SELECT status, expires_at FROM hh_invite WHERE id = ?", [id]), "expires_at") as { status: string; expires_at: number } | undefined; }
  async pendingInviteFor(householdId: string, hashes: string[]): Promise<boolean> { return !!(await this.one(`SELECT 1 AS x FROM hh_invite WHERE household_id=? AND phone_hash IN (${marks(hashes.length)}) AND status='pending'`, [householdId, ...hashes])); }
  async cooldownUntil(hashes: string[], householdId: string, now: number): Promise<number | undefined> {
    const r = await this.one(`SELECT until FROM hh_invite_cooldown WHERE target_hash IN (${marks(hashes.length)}) AND (household_id=? OR household_id='*') AND until > ? ORDER BY until DESC`, [...hashes, householdId, now]);
    return r ? num(r.until) : undefined;
  }
  async pendingInviteCount(householdId: string): Promise<number> { return num((await this.one("SELECT COUNT(*) AS c FROM hh_invite WHERE household_id=? AND status='pending'", [householdId]))!.c); }
  pendingInvites(householdId: string): Promise<Row[]> { return this.many("SELECT id, relation, status, expires_at FROM hh_invite WHERE household_id = ? AND status='pending' ORDER BY created_at", [householdId]).then((r) => r.map((x) => nums(x, "expires_at")!)); }
  async insertInvite(i: { id: string; household_id: string; phone_hash: string; relation: string; at: number; expires_at: number }): Promise<void> {
    await this.run("INSERT INTO hh_invite (id, household_id, phone_hash, relation, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?)", [i.id, i.household_id, i.phone_hash, i.relation, "pending", i.at, i.expires_at]);
  }
  async deleteInvite(id: string): Promise<void> { await this.run("DELETE FROM hh_invite WHERE id = ?", [id]); }
  async markAccepted(id: string, personId: string): Promise<void> { await this.run("UPDATE hh_invite SET status='accepted', phone_hash=NULL, accepted_person_id=? WHERE id=?", [personId, id]); }
  async markDeclined(id: string): Promise<void> { await this.run("UPDATE hh_invite SET status='declined', phone_hash=NULL WHERE id=?", [id]); }
  async markReported(id: string): Promise<void> { await this.run("UPDATE hh_invite SET status='reported', phone_hash=NULL WHERE id=?", [id]); }
  /** A report protects the number from every head ('*'); a decline only from the household that asked. A repeat restarts the clock. */
  async startCooldown(targetHash: string, householdId: string, until: number, reason: string): Promise<void> {
    await this.db.upsert("hh_invite_cooldown", { target_hash: targetHash, household_id: householdId, until, reason }, ["target_hash", "household_id"], ["until", "reason"]);
  }

  // ---- head transfers ----
  async transfer(id: string): Promise<Row | undefined> { return nums(await this.one("SELECT * FROM hh_transfer WHERE id = ?", [id]), "created_at", "expires_at"); }
  async pendingTransfer(householdId: string): Promise<Row | undefined> { return nums(await this.one("SELECT id, from_person, to_person, expires_at FROM hh_transfer WHERE household_id = ? AND status = 'pending'", [householdId]), "expires_at"); }
  async insertTransfer(t: { id: string; household_id: string; from_person: string; to_person: string; at: number; expires_at: number }): Promise<void> {
    await this.run("INSERT INTO hh_transfer (id, household_id, from_person, to_person, status, created_at, expires_at) VALUES (?,?,?,?,'pending',?,?)", [t.id, t.household_id, t.from_person, t.to_person, t.at, t.expires_at]);
  }
  async setTransferStatus(id: string, status: "accepted" | "declined" | "cancelled"): Promise<void> { await this.run("UPDATE hh_transfer SET status = ? WHERE id = ?", [status, id]); }
}
