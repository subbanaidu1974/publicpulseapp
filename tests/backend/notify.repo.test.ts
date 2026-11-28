import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { identitySqliteObjects } from "../../scripts/identity-schema-lib";
import { MysqlDb, migrate, parseMysqlUrl, SqliteDb, type Db } from "../../server/data";
import { NotifyStore } from "../../server/data/repos/notify";
import { identityMysqlMigrations } from "../../server/data/schema/identity";

/** Fifth identity module on the data layer (S-250): government notifications. Runs on SQLite and, when MYSQL_TEST_URL is set, MySQL 8.4. */
const T = "2026-11-28T10:00:00.000Z";
const at = (n: number): string => `2026-11-28T10:00:${String(n).padStart(2, "0")}.000Z`;

async function person(db: Db, id: string, o: { unit?: string | null; label?: string | null; email?: string | null; deleted?: boolean } = {}): Promise<void> {
  await db.run("INSERT INTO persons (id, label, residence_unit, email_enc, phone_enc, created_at, eligible_from, deleted_at) VALUES (?,?,?,?,?,?,?,?)", [id, o.label ?? null, o.unit ?? null, o.email ?? null, "ph:" + id, T, T, o.deleted ? T : null]);
}
async function org(s: NotifyStore, id: string, name = "Revenue Department"): Promise<void> {
  await s.insertOrg({ id, name, kind: "department", letter_ref: "GO/1", email_domain: "ap.gov.in", contact: "pio@ap.gov.in", requested_by: "admin-a", at: T });
}
async function message(s: NotifyStore, id: string, orgId: string, o: { category?: string; at?: string } = {}): Promise<void> {
  await s.insertMessage({ id, org_id: orgId, created_by: "p1", category: o.category ?? "service", state: "AP", district: null, target: "{}", title_en: "Camp", title_te: "శిబిరం 🙂", text_en: "Health camp", text_te: "ఆరోగ్య శిబిరం", template_id: null, slots: null, declaration: null, msg_hash: "h" + id, approvals_required: 1, mcc_window: null, at: o.at ?? T });
}

function suite(label: string, make: () => Promise<{ db: Db; done: () => Promise<void> }>): void {
  describe(`notify repository on ${label} @E2E-256`, { timeout: 60_000 }, () => {
    it("organisations: file, decide, list newest first, the public list is verified only and Telugu text is intact", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await org(s, "o1", "రెవెన్యూ శాఖ 🙂"); await s.insertOrg({ id: "o2", name: "Health", kind: "department", letter_ref: "GO/2", email_domain: "ap.gov.in", contact: "c", requested_by: "admin-a", at: "2026-11-28T11:00:00.000Z" });
        expect(await s.orgExists("o1")).toBe(true);
        expect(await s.orgExists("zz")).toBe(false);
        expect((await s.listOrgs()).map((o) => o.id)).toEqual(["o2", "o1"]);
        await s.decideOrg("o1", "verified", "admin-b", T);
        expect(await s.org("o1")).toMatchObject({ status: "verified", decided_by: "admin-b", name: "రెవెన్యూ శాఖ 🙂" });
        expect((await s.listOrgs("pending")).map((o) => o.id)).toEqual(["o2"]);
        expect(await s.publicOrgs()).toEqual([{ id: "o1", name: "రెవెన్యూ శాఖ 🙂", kind: "department" }]);
        await expect(org(s, "o1")).rejects.toMatchObject({ kind: "unique" });
      } finally { await done(); }
    });
    it("senders: one open binding per person and organisation, decide, list with key counts as numbers, active lookup", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await person(db, "p1"); await org(s, "o1");
        expect(await s.personExists("p1")).toBe(true);
        expect(await s.personExists("nope")).toBe(false);
        await s.insertSender({ id: "s1", org_id: "o1", person_id: "p1", role: "department_sender", requested_by: "admin-a", at: T });
        expect(await s.senderOpen("o1", "p1")).toBe(true);
        expect(await s.activeSender("p1")).toBeUndefined();
        await s.decideSender("s1", "active", "admin-b", T);
        expect(await s.activeSender("p1")).toMatchObject({ id: "s1", org_name: "Revenue Department", org_kind: "department" });
        expect(await s.activeSender("p1", "other")).toBeUndefined();
        expect(await s.activeOrgIds("p1")).toEqual(["o1"]);
        expect(await s.senderByIdOrPerson("p1")).toMatchObject({ id: "s1", org_name: "Revenue Department" });
        await s.insertCredential({ id: "k1", person_id: "p1", spki: "spki", alg: -7, counter: 0, aaguid: null, at: T });
        const list = await s.listSenders("active");
        expect(list).toHaveLength(1);
        expect(list[0].credentials).toBe(1);
        expect(typeof list[0].credentials).toBe("number");
        await s.decideSender("s1", "revoked", "admin-b", T);
        expect(await s.senderOpen("o1", "p1")).toBe(false);
        expect((await s.anySenderStatus("p1"))).toMatchObject({ s: "revoked" });
      } finally { await done(); }
    });
    it("security keys: a counter that moves, a key revoked once only, and a challenge usable by one caller only", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await s.insertCredential({ id: "k1", person_id: "p1", spki: "spki", alg: -8, counter: 0, aaguid: "aa", at: T });
        expect(await s.credentialExists("k1")).toBe(true);
        await s.touchCredential("k1", 7, at(5));
        const c = (await s.credentialsOf("p1"))[0];
        expect(c).toMatchObject({ id: "k1", alg: -8, sign_count: 7 });
        expect([typeof c.alg, typeof c.sign_count]).toEqual(["number", "number"]);
        expect(await s.revokeCredential("k1", T)).toBe(1);
        expect(await s.revokeCredential("k1", T)).toBe(0);
        expect(await s.credentialsOf("p1")).toEqual([]);
        expect((await s.credentialsAll("p1"))[0].revoked_at).toBe(T);
        await expect(s.insertCredential({ id: "k1", person_id: "p1", spki: "x", alg: -7, counter: 0, aaguid: null, at: T })).rejects.toMatchObject({ kind: "unique" });

        await s.insertChallenge({ challenge: "c1", person_id: "p1", kind: "assert", purpose: "send", message_id: "m1", msg_hash: "h", expires_at: 1_000 });
        await s.insertChallenge({ challenge: "c2", person_id: "p1", kind: "assert", purpose: "send", message_id: null, msg_hash: null, expires_at: 9_000 });
        expect(await s.challenge("c1")).toMatchObject({ expires_at: 1000, purpose: "send", message_id: "m1" });
        expect(typeof (await s.challenge("c1"))!.expires_at).toBe("number");
        expect(await s.useChallenge("c1", 500)).toBe(true);
        expect(await s.useChallenge("c1", 600)).toBe(false);
        await s.purgeChallenges(5_000);
        expect(await s.challenge("c1")).toBeUndefined();
        expect(await s.challenge("c2")).toBeDefined();
      } finally { await done(); }
    });
    it("kill switch: one open per scope and organisation, a release request, a release closes it; the block log pages by id as numbers", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await s.insertKill({ id: "k1", scope: "org", org_id: "o1", reason: "hijack", by: "admin-a", at: T });
        await s.insertKill({ id: "k2", scope: "all", org_id: null, reason: "global", by: "admin-a", at: at(5) });
        expect(await s.killOpen("org", "o1")).toBe(true);
        expect(await s.killOpen("org", "o2")).toBe(false);
        expect(await s.killOpen("all", null)).toBe(true);
        expect((await s.openKills()).map((k) => k.scope)).toEqual(["org", "all"]);
        await s.requestRelease("k1", "admin-a", at(6));
        expect(await s.kill("k1")).toMatchObject({ release_requested_by: "admin-a", released_at: null });
        await s.approveRelease("k1", "admin-b", at(7));
        expect(await s.killOpen("org", "o1")).toBe(false);
        expect((await s.listKills()).map((k) => k.id)).toEqual(["k2", "k1"]);

        for (let i = 0; i < 5; i++) await s.logBlock("2026-11-28T10", "o1", "Revenue", "service", "kill_switch_" + i);
        const all = await s.blockLog(3, 1_000_000);
        expect(all.map((r) => r.reason_code)).toEqual(["kill_switch_4", "kill_switch_3", "kill_switch_2"]);
        expect(typeof all[0].id).toBe("number");
        expect((await s.blockLog(10, all[2].id)).map((r) => r.reason_code)).toEqual(["kill_switch_1", "kill_switch_0"]);
      } finally { await done(); }
    });
    it("messages: approvals counted and unique, the claim to send is won once, the daily count leaves emergencies out", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await org(s, "o1");
        await message(s, "m1", "o1"); await message(s, "m2", "o1", { category: "emergency" });
        expect(await s.message("m1")).toMatchObject({ status: "pending_approval", approvals_required: 1, title_te: "శిబిరం 🙂" });
        expect(typeof (await s.message("m1"))!.approvals_required).toBe("number");
        expect(await s.messageHead("m1")).toMatchObject({ msg_hash: "hm1", org_id: "o1" });
        expect(await s.approvalCount("m1")).toBe(0);
        await s.insertApproval("m1", "p2", T, "k1");
        expect([await s.approvalCount("m1"), await s.approvalExists("m1", "p2"), await s.approvalExists("m1", "p3")]).toEqual([1, true, false]);
        await expect(s.insertApproval("m1", "p2", T, "k1")).rejects.toMatchObject({ kind: "unique" });
        expect(await s.approverIds("m1")).toEqual(["p2"]);
        await s.setApproved("m1", T);
        const f = { sent_at: at(10), expires_at: "2026-11-29T10:00:00.000Z", signature: "sig", key_id: "kid", key_version: 2, signed_payload: "{}" };
        expect(await s.claimSending("m1", f)).toBe(true);
        expect(await s.claimSending("m1", f)).toBe(false);
        expect(await s.message("m1")).toMatchObject({ status: "sending", key_version: 2, signature: "sig" });
        await s.markSent("m1", '{"push":1}');
        await s.setApproved("m2", T); await s.claimSending("m2", { ...f, sent_at: at(11) }); await s.markSent("m2", "{}");
        expect(await s.sentSince("o1", T)).toBe(1);
        expect((await s.sentMessages("o1")).map((m) => m.id)).toEqual(["m2", "m1"]);
        expect((await s.messagesForOrgs(["o1", "zz"])).map((m) => m.id).sort()).toEqual(["m1", "m2"]);
        expect(await s.messagesForOrgs([])).toEqual([]);
        await message(s, "m3", "o1"); await s.cancelMessage("m3");
        await message(s, "m4", "o1"); await s.blockMessage("m4", "mcc_not_precleared");
        expect(await s.message("m3")).toMatchObject({ status: "cancelled" });
        expect(await s.message("m4")).toMatchObject({ status: "blocked", blocked_reason: "mcc_not_precleared" });
      } finally { await done(); }
    });
    it("audience: residents with a unit, by unit in chunks, lookups by label with the escape, deleted people left out", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await person(db, "p1", { unit: "U1", label: "Ravi Kumar", email: "enc-mail" }); await person(db, "p2", { unit: "U2", label: "100%_Real" });
        await person(db, "p3", { unit: null }); await person(db, "p4", { unit: "U1", deleted: true });
        expect((await s.residents()).sort()).toEqual(["p1", "p2"]);
        expect((await s.residentsIn(["U1"]))).toEqual(["p1"]);
        const many = Array.from({ length: 900 }, (_, i) => "X" + i);
        expect((await s.residentsIn([...many, "U2"]))).toEqual(["p2"]);
        expect((await s.personsByLabel("%ravi%")).map((r) => r.id)).toEqual(["p1"]);
        expect((await s.personsByLabel("%100!%!_real%")).map((r) => r.id)).toEqual(["p2"]);
        expect((await s.personsByLabel("%100x%")).length).toBe(0);
        expect(await s.emailEnc("p1")).toBe("enc-mail");
        expect(await s.emailEnc("p2")).toBeNull();
        expect(await s.emailEnc("p4")).toBeNull();
        expect(await s.phoneRow("p1")).toMatchObject({ phone_enc: "ph:p1", phone_purged_at: null });
        expect(await s.phoneRow("p4")).toBeUndefined();
      } finally { await done(); }
    });
    it("preferences: a person row made once, categories saved and changed, flags and quiet hours set, numbers as numbers", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        expect(await s.personPrefs("p1")).toBeUndefined();
        await s.ensurePerson("p1", T); await s.ensurePerson("p1", at(9));
        expect(await s.personPrefs("p1")).toMatchObject({ language: "te", sms_ok: 0, email_ok: 0, push_blocked: 0, antiphish_enc: null });
        await s.setCategory("p1", "service", true, T); await s.setCategory("p1", "service", false, at(5)); await s.setCategory("p1", "scheme", true, T);
        expect([...(await s.categoryPrefs("p1"))].sort()).toEqual([["scheme", true], ["service", false]]);
        await s.setQuiet("p1", "21:00", "07:00"); await s.setLanguage("p1", "en");
        await s.setFlag("p1", "sms_ok", true); await s.setFlag("p1", "email_ok", true); await s.setFlag("p1", "push_blocked", true);
        await s.setAntiphish("p1", "enc-word", at(7));
        const p = (await s.personPrefs("p1"))!;
        expect(p).toMatchObject({ quiet_start: "21:00", quiet_end: "07:00", language: "en", sms_ok: 1, email_ok: 1, push_blocked: 1, antiphish_enc: "enc-word" });
        expect(typeof p.sms_ok).toBe("number");
        await s.touchPerson("p1", at(8));
      } finally { await done(); }
    });
    it("devices: the same token moves to its latest owner, listing is oldest first, removal clears a person's devices", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await s.saveDevice({ token_hash: "t1", person_id: "p1", token_enc: "e1", platform: "android", at: T });
        await s.saveDevice({ token_hash: "t2", person_id: "p1", token_enc: "e2", platform: "web", at: at(5) });
        await s.saveDevice({ token_hash: "t1", person_id: "p2", token_enc: "e1b", platform: "ios", at: at(9) });
        expect((await s.devices("p1")).map((d) => d.token_hash)).toEqual(["t2"]);
        expect(await s.deviceTokensEnc("p2")).toEqual(["e1b"]);
        await s.removeDevices("p1");
        expect(await s.devices("p1")).toEqual([]);
        expect((await s.devices("p2"))[0]).toMatchObject({ platform: "ios" });
      } finally { await done(); }
    });
    it("inbox: caps counted from a time, a deferred one released when due, expiry, listing newest first with the sender, marked read once", async () => {
      const { db, done } = await make();
      try {
        const s = new NotifyStore(db);
        await org(s, "o1"); await message(s, "m1", "o1"); await message(s, "m2", "o1");
        await s.markSent("m1", "{}"); await s.markSent("m2", "{}");
        await s.insertDelivered({ id: "i1", person_id: "p1", message_id: "m1", category: "service", at: T });
        await s.insertDeferred({ id: "i2", person_id: "p1", message_id: "m2", category: "service", deliver_after: at(30), at: at(1) });
        expect(await s.capCount("p1", "service", T)).toBe(2);
        expect(await s.capCount("p1", "service", at(1))).toBe(1);
        expect(await s.capCount("p1", "scheme", T)).toBe(0);
        expect(await s.deferredDue(at(29))).toEqual([]);
        const due = await s.deferredDue(at(31));
        expect(due).toHaveLength(1);
        expect(due[0]).toMatchObject({ id: "i2", message_id: "m2", org_name: "Revenue Department", title_te: "శిబిరం 🙂" });
        await s.deliverDeferred("i2", at(31)); await s.deliverDeferred("i2", at(40));
        expect(await s.deferredDue(at(50))).toEqual([]);
        await s.insertDeferred({ id: "i3", person_id: "p1", message_id: "m2", category: "service", deliver_after: at(1), at: at(2) });
        await s.expireInbox("i3");
        await s.setChannels("i1", "sent", null, "failed");
        const rows = await s.inbox("p1", 10);
        expect(rows.map((r) => r.id)).toEqual(["i2", "i1"]);
        expect(rows[1]).toMatchObject({ push_status: "sent", sms_status: null, email_status: "failed", org_name: "Revenue Department" });
        expect(await s.markRead("p1", "i1", at(45))).toBe(true);
        expect(await s.markRead("p1", "i1", at(46))).toBe(true);
        expect((await s.inbox("p1", 10)).find((r) => r.id === "i1")!.read_at).toBe(at(45));
        expect(await s.markRead("p2", "i1", at(47))).toBe(false);
        expect(await s.markRead("p1", "i3", at(47))).toBe(false);
        expect(await s.inbox("p1", 1)).toHaveLength(1);
      } finally { await done(); }
    });
  });
}

suite("sqlite", async () => {
  const db = SqliteDb.open(":memory:");
  const o = identitySqliteObjects().filter((x) => x.tbl_name.startsWith("notify_") || x.tbl_name === "persons");
  for (const x of [...o.filter((y) => y.type === "table"), ...o.filter((y) => y.type === "index")]) await db.exec(x.sql);
  return { db, done: () => db.close() };
});

const URL_ = process.env.MYSQL_TEST_URL;
if (URL_) {
  suite("mysql", async () => {
    const name = "pp_nt_" + crypto.randomBytes(5).toString("hex");
    const u = parseMysqlUrl(URL_);
    const root = await mysql.createConnection({ host: u.host, port: u.port, user: u.user, password: u.password });
    await root.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const db = new MysqlDb({ ...parseMysqlUrl(URL_, name), poolSize: 4 });
    await migrate(db, identityMysqlMigrations());
    return { db, done: async () => { await db.close(); await root.query(`DROP DATABASE ${name}`); await root.end(); } };
  });
}
