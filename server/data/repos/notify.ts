import type { Db } from "../types";

/**
 * Government notifications (S-37, S-38, S-39) on the data layer: organisations, sender bindings, security keys, challenges, messages,
 * approvals, the kill switch, the public block log, recipient preferences, devices, the inbox and caps. Same SQL on SQLite and MySQL.
 * Rules: `?` placeholders only, ISO time strings, integers inlined into LIMIT, upserts through `Db.upsert`, numbers coerced because
 * MySQL can return BIGINT as a string. The `persons` reads here are read-only lookups on the core table.
 * No message content is ever put in audit metadata (the service does the auditing); nothing here sees a plain phone, e-mail or token.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
const num = (v: unknown): number => Number(v);
const lim = (n: number, max: number): number => Math.max(1, Math.min(max, Math.floor(n)));
const nums = (r: Row | undefined, ...cols: string[]): Row | undefined => { if (!r) return r; const o = { ...r }; for (const c of cols) if (o[c] != null) o[c] = num(o[c]); return o; };

export class NotifyStore {
  constructor(private db: Db) {}
  private one(sql: string, p: unknown[] = []): Promise<Row | undefined> { return this.db.get<Row>(sql, p as never[]); }
  private many(sql: string, p: unknown[] = []): Promise<Row[]> { return this.db.all<Row>(sql, p as never[]); }
  private async changes(sql: string, p: unknown[] = []): Promise<number> { return num((await this.db.run(sql, p as never[])).changes); }

  // ---- organisations ----
  insertOrg(o: { id: string; name: string; kind: string; letter_ref: string; email_domain: string; contact: string; requested_by: string; at: string }): Promise<unknown> {
    return this.db.run("INSERT INTO notify_orgs (id, name, kind, letter_ref, email_domain, contact, status, requested_by, created_at) VALUES (?,?,?,?,?,?, 'pending', ?, ?)", [o.id, o.name, o.kind, o.letter_ref, o.email_domain, o.contact, o.requested_by, o.at]);
  }
  org(id: string): Promise<Row | undefined> { return this.one("SELECT * FROM notify_orgs WHERE id = ?", [id]); }
  async orgExists(id: string): Promise<boolean> { return !!(await this.one("SELECT id FROM notify_orgs WHERE id = ?", [id])); }
  async decideOrg(id: string, status: "verified" | "rejected", by: string, at: string): Promise<void> { await this.db.run("UPDATE notify_orgs SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", [status, by, at, id]); }
  listOrgs(status?: string): Promise<Row[]> {
    return this.many(`SELECT id, name, kind, letter_ref, email_domain, contact, status, requested_by, created_at, decided_by, decided_at FROM notify_orgs ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`, status ? [status] : []);
  }
  publicOrgs(): Promise<Row[]> { return this.many("SELECT id, name, kind FROM notify_orgs WHERE status = 'verified' ORDER BY name"); }
  orgPublic(id: string): Promise<Row | undefined> { return this.one("SELECT id, name, kind, status FROM notify_orgs WHERE id = ?", [id]); }

  // ---- sender bindings ----
  async personExists(id: string): Promise<boolean> { return !!(await this.one("SELECT id FROM persons WHERE id = ? AND deleted_at IS NULL", [id])); }
  async senderOpen(orgId: string, personId: string): Promise<boolean> { return !!(await this.one("SELECT id FROM notify_senders WHERE org_id = ? AND person_id = ? AND status IN ('pending','active')", [orgId, personId])); }
  insertSender(s: { id: string; org_id: string; person_id: string; role: string; requested_by: string; at: string }): Promise<unknown> {
    return this.db.run("INSERT INTO notify_senders (id, org_id, person_id, role, status, requested_by, created_at) VALUES (?,?,?,?, 'pending', ?, ?)", [s.id, s.org_id, s.person_id, s.role, s.requested_by, s.at]);
  }
  sender(id: string): Promise<Row | undefined> { return this.one("SELECT * FROM notify_senders WHERE id = ?", [id]); }
  async decideSender(id: string, status: "active" | "rejected" | "revoked", by: string, at: string): Promise<void> { await this.db.run("UPDATE notify_senders SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", [status, by, at, id]); }
  async listSenders(status?: string): Promise<Row[]> {
    return (await this.many(`SELECT s.id, s.org_id, o.name AS org_name, s.person_id, s.role, s.status, s.requested_by, s.created_at, s.decided_by, s.decided_at,
      (SELECT COUNT(*) FROM notify_credentials c WHERE c.person_id = s.person_id AND c.revoked_at IS NULL) AS credentials
      FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id ${status ? "WHERE s.status = ?" : ""} ORDER BY s.created_at DESC LIMIT 200`, status ? [status] : [])).map((r) => nums(r, "credentials")!);
  }
  sendersOf(personId: string): Promise<Row[]> { return this.many("SELECT s.id, s.role, s.status, o.id AS org_id, o.name AS org_name, o.kind, o.status AS org_status FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.person_id = ? ORDER BY s.created_at", [personId]); }
  sendersWithOrgName(personId: string): Promise<Row[]> { return this.many("SELECT s.id, s.role, s.status, o.name AS org_name FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.person_id = ? ORDER BY s.created_at", [personId]); }
  anySenderStatus(personId: string): Promise<Row | undefined> { return this.one("SELECT s.status AS s, o.status AS o FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.person_id = ? LIMIT 1", [personId]); }
  activeSender(personId: string, orgId?: string): Promise<Row | undefined> {
    return this.one(`SELECT s.*, o.name AS org_name, o.kind AS org_kind, o.status AS org_status FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id
      WHERE s.person_id = ? AND s.status = 'active' ${orgId ? "AND s.org_id = ?" : ""} ORDER BY s.created_at LIMIT 1`, orgId ? [personId, orgId] : [personId]);
  }
  activeOrgIds(personId: string): Promise<string[]> { return this.many("SELECT org_id FROM notify_senders WHERE person_id = ? AND status = 'active'", [personId]).then((r) => r.map((x) => x.org_id)); }
  senderByIdOrPerson(key: string): Promise<Row | undefined> { return this.one("SELECT s.id, s.person_id, s.role, s.status, o.name AS org_name FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.id = ? OR s.person_id = ? ORDER BY s.created_at DESC LIMIT 1", [key, key]); }

  // ---- security keys and challenges ----
  async credentialsOf(personId: string): Promise<Row[]> { return (await this.many("SELECT id, spki, alg, sign_count FROM notify_credentials WHERE person_id = ? AND revoked_at IS NULL", [personId])).map((r) => nums(r, "alg", "sign_count")!); }
  credentialsListing(personId: string): Promise<Row[]> { return this.many("SELECT id, created_at, last_used_at, alg FROM notify_credentials WHERE person_id = ? AND revoked_at IS NULL", [personId]); }
  credentialsAll(personId: string): Promise<Row[]> { return this.many("SELECT id, alg, created_at, last_used_at, revoked_at FROM notify_credentials WHERE person_id = ? ORDER BY created_at", [personId]); }
  async credentialExists(id: string): Promise<boolean> { return !!(await this.one("SELECT id FROM notify_credentials WHERE id = ?", [id])); }
  insertCredential(c: { id: string; person_id: string; spki: string; alg: number; counter: number; aaguid: string | null; at: string }): Promise<unknown> {
    return this.db.run("INSERT INTO notify_credentials (id, person_id, spki, alg, sign_count, aaguid, created_at) VALUES (?,?,?,?,?,?,?)", [c.id, c.person_id, c.spki, c.alg, c.counter, c.aaguid, c.at]);
  }
  async touchCredential(id: string, counter: number, at: string): Promise<void> { await this.db.run("UPDATE notify_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?", [counter, at, id]); }
  /** True when a key was revoked now (it existed and was not revoked before). */
  revokeCredential(id: string, at: string): Promise<number> { return this.changes("UPDATE notify_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [at, id]); }
  async insertChallenge(c: { challenge: string; person_id: string; kind: string; purpose: string; message_id: string | null; msg_hash: string | null; expires_at: number }): Promise<void> {
    await this.db.run("INSERT INTO notify_challenges (challenge, person_id, kind, purpose, message_id, msg_hash, expires_at) VALUES (?,?,?,?,?,?,?)", [c.challenge, c.person_id, c.kind, c.purpose, c.message_id, c.msg_hash, c.expires_at]);
  }
  async purgeChallenges(before: number): Promise<void> { await this.db.run("DELETE FROM notify_challenges WHERE expires_at < ?", [before]); }
  async challenge(challenge: string): Promise<Row | undefined> { return nums(await this.one("SELECT * FROM notify_challenges WHERE challenge = ?", [challenge]), "expires_at", "used_at"); }
  /** True only for the one caller that used the challenge first. */
  async useChallenge(challenge: string, at: number): Promise<boolean> { return (await this.changes("UPDATE notify_challenges SET used_at = ? WHERE challenge = ? AND used_at IS NULL", [at, challenge])) > 0; }

  // ---- kill switch ----
  async killOpen(scope: string, orgId: string | null): Promise<boolean> { return !!(await this.one("SELECT id FROM notify_kill WHERE released_at IS NULL AND scope = ? AND COALESCE(org_id,'') = ?", [scope, orgId ?? ""])); }
  async insertKill(k: { id: string; scope: string; org_id: string | null; reason: string; by: string; at: string }): Promise<void> { await this.db.run("INSERT INTO notify_kill (id, scope, org_id, reason, engaged_by, engaged_at) VALUES (?,?,?,?,?,?)", [k.id, k.scope, k.org_id, k.reason, k.by, k.at]); }
  kill(id: string): Promise<Row | undefined> { return this.one("SELECT * FROM notify_kill WHERE id = ?", [id]); }
  async requestRelease(id: string, by: string, at: string): Promise<void> { await this.db.run("UPDATE notify_kill SET release_requested_by = ?, release_requested_at = ? WHERE id = ?", [by, at, id]); }
  async approveRelease(id: string, by: string, at: string): Promise<void> { await this.db.run("UPDATE notify_kill SET released_by = ?, released_at = ? WHERE id = ?", [by, at, id]); }
  listKills(): Promise<Row[]> { return this.many("SELECT * FROM notify_kill ORDER BY engaged_at DESC LIMIT 100"); }
  openKills(): Promise<Row[]> { return this.many("SELECT scope, org_id, engaged_at FROM notify_kill WHERE released_at IS NULL ORDER BY engaged_at"); }

  // ---- block log ----
  async logBlock(bucket: string, orgId: string | null, orgName: string, category: string, reason: string): Promise<void> { await this.db.run("INSERT INTO notify_block_log (bucket, org_id, org_name, category, reason) VALUES (?,?,?,?,?)", [bucket, orgId, orgName, category, reason]); }
  async blockLog(limit: number, before: number): Promise<Row[]> {
    return (await this.many(`SELECT id, bucket AS time_bucket, org_name AS sender_org, category, reason AS reason_code FROM notify_block_log WHERE id < ? ORDER BY id DESC LIMIT ${lim(limit, 500)}`, [before])).map((r) => nums(r, "id")!);
  }

  // ---- messages and approvals ----
  messageHead(id: string): Promise<Row | undefined> { return this.one("SELECT id, msg_hash, org_id, status FROM notify_messages WHERE id = ?", [id]); }
  async message(id: string): Promise<Row | undefined> { return nums(await this.one("SELECT * FROM notify_messages WHERE id = ?", [id]), "approvals_required", "key_version"); }
  async insertMessage(m: { id: string; org_id: string; created_by: string; category: string; state: string; district: string | null; target: string; title_en: string; title_te: string; text_en: string; text_te: string; template_id: string | null; slots: string | null; declaration: string | null; msg_hash: string; approvals_required: number; mcc_window: string | null; at: string }): Promise<void> {
    await this.db.run(`INSERT INTO notify_messages (id, org_id, created_by, category, state, district, target, title_en, title_te, text_en, text_te, template_id, slots, declaration, msg_hash, approvals_required, status, mcc_window, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_approval', ?, ?)`, [m.id, m.org_id, m.created_by, m.category, m.state, m.district, m.target, m.title_en, m.title_te, m.text_en, m.text_te, m.template_id, m.slots, m.declaration, m.msg_hash, m.approvals_required, m.mcc_window, m.at]);
  }
  async approvalCount(messageId: string): Promise<number> { return num((await this.one("SELECT COUNT(*) AS c FROM notify_approvals WHERE message_id = ?", [messageId]))!.c); }
  async approvalExists(messageId: string, personId: string): Promise<boolean> { return !!(await this.one("SELECT message_id FROM notify_approvals WHERE message_id = ? AND person_id = ?", [messageId, personId])); }
  async insertApproval(messageId: string, personId: string, at: string, credentialId: string): Promise<void> { await this.db.run("INSERT INTO notify_approvals (message_id, person_id, at, credential_id) VALUES (?,?,?,?)", [messageId, personId, at, credentialId]); }
  approverIds(messageId: string): Promise<string[]> { return this.many("SELECT person_id FROM notify_approvals WHERE message_id = ?", [messageId]).then((r) => r.map((x) => x.person_id)); }
  async setApproved(id: string, at: string): Promise<void> { await this.db.run("UPDATE notify_messages SET status = 'approved', approved_at = ? WHERE id = ?", [at, id]); }
  async cancelMessage(id: string): Promise<void> { await this.db.run("UPDATE notify_messages SET status = 'cancelled' WHERE id = ?", [id]); }
  async blockMessage(id: string, reason: string): Promise<void> { await this.db.run("UPDATE notify_messages SET status = 'blocked', blocked_reason = ? WHERE id = ?", [reason, id]); }
  async messagesForOrgs(orgIds: string[]): Promise<Row[]> {
    if (!orgIds.length) return [];
    return (await this.many(`SELECT * FROM notify_messages WHERE org_id IN (${orgIds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 100`, orgIds)).map((r) => nums(r, "approvals_required", "key_version")!);
  }
  async sentSince(orgId: string, sinceIso: string): Promise<number> { return num((await this.one("SELECT COUNT(*) AS c FROM notify_messages WHERE org_id = ? AND status IN ('sending','sent') AND category <> 'emergency' AND sent_at >= ?", [orgId, sinceIso]))!.c); }
  /** Moves an approved message to sending; false when someone else already did. */
  async claimSending(id: string, f: { sent_at: string; expires_at: string; signature: string; key_id: string; key_version: number; signed_payload: string }): Promise<boolean> {
    return (await this.changes("UPDATE notify_messages SET status = 'sending', sent_at = ?, expires_at = ?, signature = ?, key_id = ?, key_version = ?, signed_payload = ? WHERE id = ? AND status = 'approved'", [f.sent_at, f.expires_at, f.signature, f.key_id, f.key_version, f.signed_payload, id])) > 0;
  }
  async markSent(id: string, stats: string): Promise<void> { await this.db.run("UPDATE notify_messages SET status = 'sent', stats = ? WHERE id = ?", [stats, id]); }
  sentMessages(orgId: string): Promise<Row[]> { return this.many("SELECT id, category, title_en, title_te, text_en, text_te, sent_at, signature, key_id, declaration, mcc_window FROM notify_messages WHERE org_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 200", [orgId]); }

  // ---- audience and lookups on the persons table (read only) ----
  residents(): Promise<string[]> { return this.many("SELECT id FROM persons WHERE deleted_at IS NULL AND residence_unit IS NOT NULL AND residence_unit <> ''").then((r) => r.map((x) => x.id)); }
  async residentsIn(units: string[]): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < units.length; i += 400) {
      const chunk = units.slice(i, i + 400);
      out.push(...(await this.many(`SELECT id FROM persons WHERE deleted_at IS NULL AND residence_unit IN (${chunk.map(() => "?").join(",")})`, chunk)).map((r) => r.id));
    }
    return out;
  }
  personsByLabel(escapedLowerLike: string): Promise<Row[]> { return this.many("SELECT * FROM persons WHERE deleted_at IS NULL AND label IS NOT NULL AND lower(label) LIKE ? ESCAPE '!' ORDER BY created_at LIMIT 10", [escapedLowerLike]); }
  emailEnc(personId: string): Promise<string | null> { return this.one("SELECT email_enc FROM persons WHERE id = ? AND deleted_at IS NULL", [personId]).then((r) => r?.email_enc ?? null); }
  phoneRow(personId: string): Promise<{ phone_enc: string | null; phone_purged_at: string | null } | undefined> { return this.one("SELECT phone_enc, phone_purged_at FROM persons WHERE id = ? AND deleted_at IS NULL", [personId]) as Promise<{ phone_enc: string | null; phone_purged_at: string | null } | undefined>; }

  // ---- recipient preferences ----
  async personPrefs(id: string): Promise<Row | undefined> { return nums(await this.one("SELECT quiet_start, quiet_end, antiphish_enc, language, sms_ok, email_ok, push_blocked FROM notify_person WHERE person_id = ?", [id]), "sms_ok", "email_ok", "push_blocked"); }
  async categoryPrefs(personId: string): Promise<Map<string, boolean>> { return new Map((await this.many("SELECT category, opted_in FROM notify_prefs WHERE person_id = ?", [personId])).map((r) => [r.category, !!num(r.opted_in)])); }
  async ensurePerson(personId: string, at: string): Promise<void> { await this.db.upsert("notify_person", { person_id: personId, language: "te", updated_at: at }, ["person_id"], "none"); }
  async setCategory(personId: string, category: string, optedIn: boolean, at: string): Promise<void> { await this.db.upsert("notify_prefs", { person_id: personId, category, opted_in: optedIn ? 1 : 0, updated_at: at }, ["person_id", "category"], ["opted_in", "updated_at"]); }
  async setQuiet(personId: string, start: string, end: string): Promise<void> { await this.db.run("UPDATE notify_person SET quiet_start = ?, quiet_end = ? WHERE person_id = ?", [start, end, personId]); }
  async setLanguage(personId: string, lang: string): Promise<void> { await this.db.run("UPDATE notify_person SET language = ? WHERE person_id = ?", [lang, personId]); }
  async setFlag(personId: string, flag: "sms_ok" | "email_ok" | "push_blocked", on: boolean): Promise<void> { await this.db.run(`UPDATE notify_person SET ${flag} = ? WHERE person_id = ?`, [on ? 1 : 0, personId]); }
  async touchPerson(personId: string, at: string): Promise<void> { await this.db.run("UPDATE notify_person SET updated_at = ? WHERE person_id = ?", [at, personId]); }
  async setAntiphish(personId: string, enc: string, at: string): Promise<void> { await this.db.run("UPDATE notify_person SET antiphish_enc = ?, updated_at = ? WHERE person_id = ?", [enc, at, personId]); }

  // ---- devices ----
  async saveDevice(d: { token_hash: string; person_id: string; token_enc: string; platform: string; at: string }): Promise<void> {
    await this.db.upsert("notify_devices", { token_hash: d.token_hash, person_id: d.person_id, token_enc: d.token_enc, platform: d.platform, created_at: d.at }, ["token_hash"], ["person_id", "token_enc", "platform", "created_at"]);
  }
  devices(personId: string): Promise<Row[]> { return this.many("SELECT token_hash, platform, created_at FROM notify_devices WHERE person_id = ? ORDER BY created_at", [personId]); }
  async removeDevices(personId: string): Promise<void> { await this.db.run("DELETE FROM notify_devices WHERE person_id = ?", [personId]); }
  deviceTokensEnc(personId: string): Promise<string[]> { return this.many("SELECT token_enc FROM notify_devices WHERE person_id = ?", [personId]).then((r) => r.map((x) => x.token_enc)); }

  // ---- inbox ----
  async capCount(personId: string, category: string, sinceIso: string): Promise<number> { return num((await this.one("SELECT COUNT(*) AS c FROM notify_inbox WHERE person_id = ? AND category = ? AND created_at >= ?", [personId, category, sinceIso]))!.c); }
  async insertDeferred(i: { id: string; person_id: string; message_id: string; category: string; deliver_after: string; at: string }): Promise<void> {
    await this.db.run("INSERT INTO notify_inbox (id, person_id, message_id, category, status, deliver_after, created_at) VALUES (?,?,?,?, 'deferred', ?, ?)", [i.id, i.person_id, i.message_id, i.category, i.deliver_after, i.at]);
  }
  async insertDelivered(i: { id: string; person_id: string; message_id: string; category: string; at: string }): Promise<void> {
    await this.db.run("INSERT INTO notify_inbox (id, person_id, message_id, category, status, created_at, delivered_at) VALUES (?,?,?,?, 'delivered', ?, ?)", [i.id, i.person_id, i.message_id, i.category, i.at, i.at]);
  }
  async setChannels(id: string, push: string, sms: string | null, email: string | null): Promise<void> { await this.db.run("UPDATE notify_inbox SET push_status = ?, sms_status = ?, email_status = ? WHERE id = ?", [push, sms, email, id]); }
  deferredDue(nowIso: string): Promise<Row[]> {
    return this.many(`SELECT i.id, i.person_id, i.message_id, m.org_id, m.category, m.title_en, m.title_te, m.text_en, m.text_te, m.signature, m.key_id, m.sent_at, m.expires_at, o.name AS org_name
      FROM notify_inbox i JOIN notify_messages m ON m.id = i.message_id JOIN notify_orgs o ON o.id = m.org_id WHERE i.status = 'deferred' AND i.deliver_after <= ? LIMIT 500`, [nowIso]);
  }
  async expireInbox(id: string): Promise<void> { await this.db.run("UPDATE notify_inbox SET status = 'expired' WHERE id = ?", [id]); }
  async deliverDeferred(id: string, at: string): Promise<void> { await this.db.run("UPDATE notify_inbox SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'deferred'", [at, id]); }
  inbox(personId: string, limit: number): Promise<Row[]> {
    return this.many(`SELECT i.id, i.message_id, i.category, i.delivered_at, i.read_at, i.push_status, i.sms_status, i.email_status, m.title_en, m.title_te, m.text_en, m.text_te, m.signature, m.key_id, m.sent_at, m.signed_payload, o.id AS org_id, o.name AS org_name
      FROM notify_inbox i JOIN notify_messages m ON m.id = i.message_id JOIN notify_orgs o ON o.id = m.org_id
      WHERE i.person_id = ? AND i.status = 'delivered' ORDER BY i.delivered_at DESC LIMIT ${lim(limit, 200)}`, [personId]);
  }
  async markRead(personId: string, inboxId: string, at: string): Promise<boolean> { return (await this.changes("UPDATE notify_inbox SET read_at = COALESCE(read_at, ?) WHERE id = ? AND person_id = ? AND status = 'delivered'", [at, inboxId, personId])) > 0; }
}
