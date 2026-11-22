import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "node:crypto";
import { createSession, getDb, migrate, resetDbForTests, smsOutbox, getStore } from "../../server/civic/core";
import { identityRouter } from "../../server/civic/identity/routes";
import { eraseDependentsAt18, householdRouter, INVITE_TTL_MS } from "../../server/civic/households/routes";
import { attest, grantVolunteer, phoneHash, verifyPin } from "../../server/civic/identity/service";
import { expirePendingEnrolments, getEnrolmentContext, sampleEnrolmentsForRecheck } from "../../server/civic/identity/enrolment";

let server: Server;
let base: string;

function person(phone?: string): { id: string; token: string } {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, phone_hash, created_at, eligible_from) VALUES (?,?,?,?)").run(id, phone ? phoneHash(`+91${phone}`) : null, now, now);
  return { id, token: createSession(id) };
}

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api/v1/civic/households${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  resetDbForTests();
  migrate();
  const app = express();
  app.use("/api/v1/civic/households", householdRouter);
  app.use("/api/v1/civic/identity", identityRouter);
  await new Promise<void>((res) => { server = app.listen(0, "127.0.0.1", () => res()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); resetDbForTests(); });
beforeEach(() => { smsOutbox.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

const PHONE = "9876543210";

describe("households: adult invite (S-21)", () => {
  it("@E2E-30 invitee gets the notice first, stores only a hash, accepts with own PIN; head never sees answers", async () => {
    const head = person(); const spouse = person(PHONE);
    expect((await call(null, "GET", "/mine")).status).toBe(401);
    expect((await call(head.token, "POST", "/")).status).toBe(201);
    const inv = await call(head.token, "POST", "/members/invite", { phone: PHONE, relation: "spouse" });
    expect(inv.status).toBe(201);
    const inviteId = inv.body.inviteId as string;

    // Notice (Telugu + English) was sent by SMS before anything else about the invitee exists.
    expect(smsOutbox).toHaveLength(1);
    expect(smsOutbox[0].to).toBe(`+91${PHONE}`);
    expect(smsOutbox[0].text).toContain(inviteId);
    expect(smsOutbox[0].text).toContain("DRAFT");
    expect(smsOutbox[0].text).toMatch(/[ఀ-౿]/);

    // Pending state: no member row, no plaintext number anywhere in the household tables, only a hash.
    const db = getDb();
    expect(db.prepare("SELECT COUNT(*) AS c FROM hh_member WHERE status='accepted'").get()).toEqual({ c: 0 });
    const dump = JSON.stringify([db.prepare("SELECT * FROM hh_invite").all(), db.prepare("SELECT * FROM hh_member").all(), db.prepare("SELECT * FROM hh_household").all()]);
    expect(dump).not.toContain(PHONE);
    expect((db.prepare("SELECT phone_hash FROM hh_invite WHERE id=?").get(inviteId) as { phone_hash: string }).phone_hash).toMatch(/\S{16,}/);

    // The notice is readable before signing in.
    const notice = await call(null, "GET", `/invites/${inviteId}/notice`);
    expect(notice.status).toBe(200);
    expect(notice.body.notice.text.te).toBeTruthy();

    // Bad PINs refused; accept with own PIN records consent.
    expect((await call(spouse.token, "POST", "/invites/accept", { inviteId, pin: "12" })).status).toBe(400);
    expect((await call(spouse.token, "POST", "/invites/accept", { inviteId, pin: "4821" })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS c FROM consents WHERE person_id=? AND purpose='household_invite'").get(spouse.id)).toEqual({ c: 1 });
    expect((db.prepare("SELECT phone_hash FROM hh_invite WHERE id=?").get(inviteId) as { phone_hash: string | null }).phone_hash).toBeNull();
    const pin = db.prepare("SELECT pin_salt, pin_hash FROM persons WHERE id=?").get(spouse.id) as { pin_salt: string; pin_hash: string };
    expect(pin.pin_hash).not.toContain("4821");
    expect(verifyPin("4821", pin.pin_salt, pin.pin_hash)).toBe(true); // stored once, in identity
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='hh_pin'").get()).toBeUndefined();
    expect((await call(spouse.token, "POST", "/invites/accept", { inviteId, pin: "4821" })).status).toBe(409); // single use

    // Head roster: members and statuses only. No answers, no phone, no pin fields.
    const roster = await call(head.token, "GET", "/mine");
    expect(roster.body.members).toHaveLength(2);
    const text = JSON.stringify(roster.body);
    expect(text).not.toMatch(/answer|response|phone|pin/i);
    expect(text).not.toContain(PHONE);
  });

  it("@E2E-30 invite expires at 72h and can no longer be accepted", async () => {
    const head = person(); const late = person("9123456780");
    await call(head.token, "POST", "/");
    const inv = await call(head.token, "POST", "/members/invite", { phone: "9123456780", relation: "parent" });
    const inviteId = inv.body.inviteId as string;
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + INVITE_TTL_MS + 60_000);
    const r = await call(late.token, "POST", "/invites/accept", { inviteId, pin: "7391" });
    expect(r.status).toBe(410);
    expect((getDb().prepare("SELECT phone_hash, status FROM hh_invite WHERE id=?").get(inviteId) as any)).toEqual({ phone_hash: null, status: "expired" });
    const mine = await call(head.token, "GET", "/mine");
    expect(mine.body.invites).toHaveLength(0);
  });

  it("@E2E-30 invitee can decline, or report 'I did not agree', which removes any membership", async () => {
    const head = person(); const a = person("9000000001"); const b = person("9000000002");
    await call(head.token, "POST", "/");
    const i1 = (await call(head.token, "POST", "/members/invite", { phone: "9000000001", relation: "sibling" })).body.inviteId;
    expect((await call(a.token, "POST", "/invites/decline", { inviteId: i1 })).status).toBe(200);
    expect((await call(a.token, "POST", "/invites/accept", { inviteId: i1, pin: "7391" })).status).toBe(409);

    const i2 = (await call(head.token, "POST", "/members/invite", { phone: "9000000002", relation: "spouse" })).body.inviteId;
    await call(b.token, "POST", "/invites/accept", { inviteId: i2, pin: "7397" });
    expect((await call(head.token, "GET", "/mine")).body.members).toHaveLength(2);
    // Someone else cannot report on b's behalf.
    expect((await call(a.token, "POST", "/invites/report-not-agreed", { inviteId: i2 })).status).toBe(403);
    expect((await call(b.token, "POST", "/invites/report-not-agreed", { inviteId: i2 })).status).toBe(200);
    expect((await call(head.token, "GET", "/mine")).body.members).toHaveLength(1);
    expect(getStore("audit").prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action='household_invite_reported_not_agreed'").get()).toEqual({ c: 1 });
  });

  it("head role transfers to an adult member only; members cannot invite", async () => {
    const head = person(); const m = person("9000000003"); const outsider = person();
    await call(head.token, "POST", "/");
    const id = (await call(head.token, "POST", "/members/invite", { phone: "9000000003", relation: "spouse" })).body.inviteId;
    await call(m.token, "POST", "/invites/accept", { inviteId: id, pin: "7398" });
    expect((await call(m.token, "POST", "/members/invite", { phone: "9000000004", relation: "other" })).status).toBe(403);
    expect((await call(head.token, "POST", "/transfer-head", { toPersonId: outsider.id })).status).toBe(400);
    const tr = await call(head.token, "POST", "/transfer-head", { toPersonId: m.id });
    expect(tr.status).toBe(202); // pending until the recipient confirms (E2E-164)
    expect((await call(head.token, "GET", "/mine")).body.isHead).toBe(true);
    expect((await call(m.token, "POST", "/transfer-head/accept", { transferId: tr.body.transferId })).status).toBe(200);
    const asNew = await call(m.token, "GET", "/mine");
    expect(asNew.body.isHead).toBe(true);
    expect((await call(head.token, "GET", "/mine")).body.isHead).toBe(false);
  });
});

describe("households: minor dependents (S-22)", () => {
  it("@E2E-31 consent recorded; only year of birth and relation stored; refuses adults; no account", async () => {
    const head = person();
    await call(head.token, "POST", "/");
    const yr = new Date().getFullYear();
    expect((await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 30, parentalConsentVersion: "v1" })).status).toBe(400);
    expect((await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 18, parentalConsentVersion: "v1" })).status).toBe(400);
    expect((await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 8, parentalConsentVersion: "v99" })).status).toBe(400);
    const ok = await call(head.token, "POST", "/dependents", { relation: "daughter", yearOfBirth: yr - 8, parentalConsentVersion: "v1", name: "Asha" });
    expect(ok.status).toBe(201);

    const db = getDb();
    expect(db.prepare("SELECT COUNT(*) AS c FROM consents WHERE person_id=? AND purpose='minor_dependent' AND version='v1'").get(head.id)).toEqual({ c: 1 });
    const cols = (db.prepare("PRAGMA table_info(hh_member)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("name");
    const row = db.prepare("SELECT * FROM hh_member WHERE id=?").get(ok.body.id) as Record<string, unknown>;
    expect(row.person_id).toBeNull(); // no account, so no possible survey access
    expect(row.year_of_birth).toBe(yr - 8);
    expect(JSON.stringify(row)).not.toContain("Asha");

    // The schema itself forbids a dependent with a person account.
    expect(() => db.prepare("INSERT INTO hh_member (id, household_id, person_id, relation, status, year_of_birth, created_at) VALUES ('x','h','p','son','dependent',2020,1)").run()).toThrow();
    // Cannot be made head.
    expect((await call(head.token, "POST", "/transfer-head", { toPersonId: row.id })).status).toBe(400);
  });

  it("@E2E-31 only the head may add dependents; dependents are erased at 18", async () => {
    const head = person(); const m = person("9000000005");
    await call(head.token, "POST", "/");
    const inv = (await call(head.token, "POST", "/members/invite", { phone: "9000000005", relation: "spouse" })).body.inviteId;
    await call(m.token, "POST", "/invites/accept", { inviteId: inv, pin: "2468" });
    const yr = new Date().getFullYear();
    expect((await call(m.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 5, parentalConsentVersion: "v1" })).status).toBe(403);

    const kid = (await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 17, parentalConsentVersion: "v1" })).body.id;
    const small = (await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 3, parentalConsentVersion: "v1" })).body.id;
    expect(eraseDependentsAt18(new Date())).toBe(0);
    expect(eraseDependentsAt18(new Date(yr + 1, 5, 1))).toBe(1); // the 17-year-old turns 18 next year
    const db = getDb();
    expect(db.prepare("SELECT 1 FROM hh_member WHERE id=?").get(kid)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM hh_member WHERE id=?").get(small)).toBeDefined();
    // Members never see dependents' details.
    const asMember = await call(m.token, "GET", "/mine");
    expect(JSON.stringify(asMember.body)).not.toContain("yearOfBirth");
  });
});

describe("DPDP artefacts (S-44)", () => {
  it("@E2E-54 (API half: notice, consent, grievance contact) serves versioned Telugu and English notices marked DRAFT, and the grievance contact", async () => {
    for (const purpose of ["signup", "household_invite", "minor_dependent"]) {
      const r = await call(null, "GET", `/notices/${purpose}`);
      expect(r.status).toBe(200);
      expect(r.body.version).toBe("v1");
      expect(r.body.status).toMatch(/DRAFT/);
      expect(r.body.text.en.length).toBeGreaterThan(50);
      expect(r.body.text.te).toMatch(/[ఀ-౿]/);
    }
    expect((await call(null, "GET", "/notices/nope")).status).toBe(404);
    const g = await call(null, "GET", "/grievance-officer");
    expect(g.status).toBe(200);
    expect(g.body.status).toMatch(/DRAFT/);
    expect(g.body.email).toBeTruthy();
  });

  it("records a consent via the API and rejects unknown purpose or version", async () => {
    const p = person();
    expect((await call(p.token, "POST", "/consents", { purpose: "signup", version: "v1" })).status).toBe(201);
    expect((await call(p.token, "POST", "/consents", { purpose: "signup", version: "v7" })).status).toBe(400);
    expect((await call(null, "POST", "/consents", { purpose: "signup", version: "v1" })).status).toBe(401);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM consents WHERE person_id=? AND purpose='signup'").get(p.id)).toEqual({ c: 1 });
  });
});

describe("households: invite bound to phone", () => {
  it("rejects and audits acceptance by a person whose verified phone differs", async () => {
    const head = person(); const wrong = person("9000000099"); const noPhone = person(); const right = person("9000000098");
    await call(head.token, "POST", "/");
    const id = (await call(head.token, "POST", "/members/invite", { phone: "9000000098", relation: "spouse" })).body.inviteId;
    const count = () => (getStore("audit").prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action='household_invite_phone_mismatch'").get() as { c: number }).c;
    const before = count();
    expect((await call(wrong.token, "POST", "/invites/accept", { inviteId: id, pin: "7391" })).status).toBe(403);
    expect((await call(noPhone.token, "POST", "/invites/accept", { inviteId: id, pin: "7391" })).status).toBe(403);
    expect(count() - before).toBe(2);
    expect(getDb().prepare("SELECT pin_hash FROM persons WHERE id=?").get(wrong.id)).toEqual({ pin_hash: null });
    expect((await call(right.token, "POST", "/invites/accept", { inviteId: id, pin: "7391" })).status).toBe(200);
  });

  it("an existing identity PIN is verified, not overwritten", async () => {
    const head = person(); const m = person("9000000097");
    await call(head.token, "POST", "/");
    const id = (await call(head.token, "POST", "/members/invite", { phone: "9000000097", relation: "parent" })).body.inviteId;
    expect((await call(m.token, "POST", "/invites/accept", { inviteId: id, pin: "7392" })).status).toBe(200);
    const id2 = (await call(head.token, "POST", "/members/invite", { phone: "9000000097", relation: "parent" })).body.inviteId;
    const mid = (getDb().prepare("SELECT id FROM hh_member WHERE person_id=?").get(m.id) as { id: string }).id;
    await call(m.token, "DELETE", `/members/${mid}`);
    expect((await call(m.token, "POST", "/invites/accept", { inviteId: id2, pin: "7393" })).status).toBe(403);
  });
});

describe("households: volunteer enrolment (S-136)", () => {
  const body = (phone: string, extra: Record<string, unknown> = {}) => ({ phone, noticeShown: true, noticeVersion: "v1", contextKind: "shg", contextRef: "shg-12", ...extra });
  const activate = (code: string, otp: string, pin: string) => fetch(`${base}/api/v1/civic/identity/activate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, otp, pin }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
  const codesFrom = (text: string) => ({ code: /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)![1], otp: /OTP: (\d{6})/.exec(text)![1] });

  it("@E2E-151 only volunteers; the notice must be shown; a volunteer-chosen PIN is refused; nothing is stored before validation", async () => {
    const res = person("9111111110"); const vol = person("9111111111");
    grantVolunteer(vol.id, "orgA");
    expect((await call(res.token, "POST", "/volunteer/enrol", body("9222222221"))).status).toBe(403);
    expect((await call(vol.token, "POST", "/volunteer/enrol", body("9222222221", { noticeShown: false }))).status).toBe(400);
    expect((await call(vol.token, "POST", "/volunteer/enrol", body("9222222221", { noticeVersion: "v9" }))).status).toBe(400);
    const withPin = await call(vol.token, "POST", "/volunteer/enrol", body("9222222221", { pin: "4821" }));
    expect(withPin.status).toBe(400);
    expect(withPin.body.code).toBe("pin_not_allowed");
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM persons WHERE phone_hash=?").get(phoneHash("+919222222221"))).toEqual({ c: 0 });
    expect(smsOutbox).toHaveLength(0);
  });

  it("@E2E-151 enrolment creates a PENDING person with no PIN; the adult activates with code + OTP and their own PIN", async () => {
    const vol = person("9111111112"); grantVolunteer(vol.id, "orgA");
    const r = await call(vol.token, "POST", "/volunteer/enrol", body("9222222222", { label: "Lakshmi" }));
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending");
    const db = getDb();
    const p = db.prepare("SELECT pin_hash, flags, tier FROM persons WHERE id=?").get(r.body.personId) as { pin_hash: string | null; flags: string; tier: string };
    expect(p.pin_hash).toBeNull();
    expect(JSON.parse(p.flags)).toContain("pending_activation");
    expect(db.prepare("SELECT volunteer_id, context_kind, context_ref, label, status FROM enrolments WHERE id=?").get(r.body.enrolmentId)).toEqual({ volunteer_id: vol.id, context_kind: "shg", context_ref: "shg-12", label: "Lakshmi", status: "pending" });
    // the SMS goes to the adult's own number and carries the codes; the volunteer's response does not
    expect(smsOutbox).toHaveLength(1);
    expect(smsOutbox[0].to).toBe("+919222222222");
    expect(JSON.stringify(r.body)).not.toMatch(/otp|code/i);
    const { code, otp } = codesFrom(smsOutbox[0].text);
    expect(db.prepare("SELECT COUNT(*) AS c FROM consents WHERE person_id=?").get(r.body.personId)).toEqual({ c: 0 }); // consent comes from the adult
    // pending: cannot sign in, number is taken
    const login = await fetch(`${base}/api/v1/civic/identity/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+919222222222", pin: "4821" }) });
    expect(login.status).toBe(401);
    expect((await call(vol.token, "POST", "/volunteer/enrol", body("9222222222"))).status).toBe(409);
    // wrong otp, weak pin: nothing activates and the code is not burned by the weak PIN
    expect((await activate(code, otp === "000000" ? "111111" : "000000", "4821")).status).toBe(400);
    const weak = await activate(code, otp, "1234");
    expect(weak.status).toBe(400); expect(weak.body.code).toBe("weak_pin");
    const ok = await activate(code, otp, "4821");
    expect(ok.status).toBe(201);
    expect(ok.body.person.tier).toBe("T0");
    expect(ok.body.token).toBeTruthy();
    expect(db.prepare("SELECT status FROM enrolments WHERE id=?").get(r.body.enrolmentId)).toEqual({ status: "activated" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM consents WHERE person_id=? AND purpose='signup'").get(r.body.personId)).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM attestations WHERE subject_id=?").get(r.body.personId)).toEqual({ c: 0 });
    expect(JSON.stringify(getStore("audit").prepare("SELECT meta FROM audit_log").all())).not.toContain("9222222222");
    expect((await activate(code, otp, "4821")).status).toBe(400); // single use
    expect(getEnrolmentContext(r.body.personId)).toMatchObject({ volunteer_id: vol.id, context_kind: "shg", context_ref: "shg-12", status: "activated" });
  });

  it("@E2E-151 pending enrolments expire after 72 hours and are deleted; the number is free again", async () => {
    const vol = person("9111111114"); grantVolunteer(vol.id);
    const r = await call(vol.token, "POST", "/volunteer/enrol", body("9444444441"));
    const { code, otp } = codesFrom(smsOutbox.at(-1)!.text);
    expect(expirePendingEnrolments(new Date(Date.now() + 71 * 3600_000))).toBe(0);
    expect(expirePendingEnrolments(new Date(Date.now() + 73 * 3600_000))).toBe(1);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM persons WHERE id=?").get(r.body.personId)).toEqual({ c: 0 });
    expect(getDb().prepare("SELECT status FROM enrolments WHERE id=?").get(r.body.enrolmentId)).toEqual({ status: "expired" });
    expect((await activate(code, otp, "4821")).status).toBe(400);
    expect((await call(vol.token, "POST", "/volunteer/enrol", body("9444444441"))).status).toBe(201);
  });

  it("@E2E-151 the T2 independence check refuses the enrolling volunteer, and the re-check sampler returns activated enrolments", async () => {
    const vol = person("9111111115"); grantVolunteer(vol.id, "orgZ");
    const r = await call(vol.token, "POST", "/volunteer/enrol", body("9444444442", { contextRef: "shg-7" }));
    const { code, otp } = codesFrom(smsOutbox.at(-1)!.text);
    await activate(code, otp, "4821");
    getDb().prepare("UPDATE persons SET residence_declared_at=?, tier='T1' WHERE id=?").run(new Date().toISOString(), r.body.personId);
    const res = attest(vol.id, r.body.personId);
    expect("error" in res && res.status).toBe(409);
    const picked = sampleEnrolmentsForRecheck({ fraction: 1, rng: () => 0 });
    expect(picked).toContainEqual({ enrolment_id: r.body.enrolmentId, person_id: r.body.personId, volunteer_id: vol.id, context_kind: "shg", context_ref: "shg-7" });
    expect(sampleEnrolmentsForRecheck({ fraction: 1, rng: () => 0 })).toEqual([]); // each enrolment is sampled once
  });

  it("enforces the per-volunteer daily quota", async () => {
    process.env.CIVIC_ENROL_DAILY_QUOTA = "2";
    try {
      const vol = person("9111111113"); grantVolunteer(vol.id);
      expect((await call(vol.token, "POST", "/volunteer/enrol", body("9333333331"))).status).toBe(201);
      expect((await call(vol.token, "POST", "/volunteer/enrol", body("9333333332"))).status).toBe(201);
      expect((await call(vol.token, "POST", "/volunteer/enrol", body("9333333333"))).status).toBe(429);
      expect(getDb().prepare("SELECT COUNT(*) AS c FROM persons WHERE phone_hash=?").get(phoneHash("+919333333333"))).toEqual({ c: 0 });
    } finally { delete process.env.CIVIC_ENROL_DAILY_QUOTA; }
  });
});

describe("households: abuse caps and transfer confirmation (S-61, S-149)", () => {
  const head = (_n: string) => person();

  it("@E2E-76 per-head daily cap, per-target cap across heads, and a 429 degraded notice when the SMS budget is spent", async () => {
    process.env.CIVIC_INVITE_DAILY_CAP = "2";
    try {
      const h1 = head("a"), h2 = head("b"), h3 = head("c");
      for (const h of [h1, h2, h3]) await call(h.token, "POST", "/");
      expect((await call(h1.token, "POST", "/members/invite", { phone: "9500000001", relation: "spouse" })).status).toBe(201);
      expect((await call(h1.token, "POST", "/members/invite", { phone: "9500000002", relation: "spouse" })).status).toBe(201);
      const capped = await call(h1.token, "POST", "/members/invite", { phone: "9500000003", relation: "spouse" });
      expect(capped.status).toBe(429); expect(capped.body.code).toBe("invite_daily_cap");
      // the same number cannot be invited more than 3 times a day across all heads
      process.env.CIVIC_INVITE_DAILY_CAP = "10";
      const heads = [head("d"), head("e"), head("f"), head("g")];
      for (const h of heads) await call(h.token, "POST", "/");
      const codes: number[] = [];
      for (const h of heads) codes.push((await call(h.token, "POST", "/members/invite", { phone: "9500000009", relation: "parent" })).status);
      expect(codes).toEqual([201, 201, 201, 429]);
      // global SMS budget shared with OTP
      process.env.CIVIC_SMS_HOURLY_BUDGET = "1";
      const budget = await call(h3.token, "POST", "/members/invite", { phone: "9500000010", relation: "parent" });
      expect(budget.status).toBe(429); expect(budget.body.degraded).toBe(true); expect(budget.body.notice).toBeTruthy();
    } finally { delete process.env.CIVIC_INVITE_DAILY_CAP; delete process.env.CIVIC_SMS_HOURLY_BUDGET; }
  });

  it("@E2E-76 a decline blocks re-invites from that household for 7 days; a report blocks every household", async () => {
    const h1 = person(); const h2 = person(); const t = person("9600000001");
    await call(h1.token, "POST", "/"); await call(h2.token, "POST", "/");
    const id = (await call(h1.token, "POST", "/members/invite", { phone: "9600000001", relation: "spouse" })).body.inviteId;
    expect((await call(t.token, "POST", "/invites/decline", { inviteId: id })).status).toBe(200);
    const again = await call(h1.token, "POST", "/members/invite", { phone: "9600000001", relation: "spouse" });
    expect(again.status).toBe(429); expect(again.body.code).toBe("invite_cooldown");
    const other = await call(h2.token, "POST", "/members/invite", { phone: "9600000001", relation: "spouse" });
    expect(other.status).toBe(201); // a decline only protects against the household that asked
    expect((await call(t.token, "POST", "/invites/report-not-agreed", { inviteId: other.body.inviteId })).status).toBe(200);
    const h3 = person(); await call(h3.token, "POST", "/");
    expect((await call(h3.token, "POST", "/members/invite", { phone: "9600000001", relation: "spouse" })).body.code).toBe("invite_cooldown");
  });

  it("@E2E-164 head transfer waits for the recipient, expires after 72h, and the dependents cap holds", async () => {
    const head1 = person(); const m = person("9700000001");
    await call(head1.token, "POST", "/");
    const id = (await call(head1.token, "POST", "/members/invite", { phone: "9700000001", relation: "spouse" })).body.inviteId;
    await call(m.token, "POST", "/invites/accept", { inviteId: id, pin: "7395" });
    const t = await call(head1.token, "POST", "/transfer-head", { toPersonId: m.id });
    expect(t.status).toBe(202);
    expect((await call(head1.token, "POST", "/transfer-head", { toPersonId: m.id })).status).toBe(409);
    expect((await call(head1.token, "GET", "/mine")).body.isHead).toBe(true); // unchanged until confirmed
    expect((await call(head1.token, "POST", "/transfer-head/accept", { transferId: t.body.transferId })).status).toBe(404); // not the recipient
    expect((await call(m.token, "GET", "/mine")).body.pendingTransfer.role).toBe("recipient");
    expect((await call(m.token, "POST", "/transfer-head/accept", { transferId: t.body.transferId })).status).toBe(200);
    expect((await call(m.token, "GET", "/mine")).body.isHead).toBe(true);
    // decline path and expiry
    const t2 = await call(m.token, "POST", "/transfer-head", { toPersonId: head1.id });
    expect((await call(head1.token, "POST", "/transfer-head/decline", { transferId: t2.body.transferId })).status).toBe(200);
    const t3 = await call(m.token, "POST", "/transfer-head", { toPersonId: head1.id });
    getDb().prepare("UPDATE hh_transfer SET expires_at = ? WHERE id = ?").run(Date.now() - 1, t3.body.transferId);
    expect((await call(head1.token, "POST", "/transfer-head/accept", { transferId: t3.body.transferId })).status).toBe(410);
    // dependents cap
    process.env.CIVIC_MAX_DEPENDENTS = "2";
    try {
      const yr = new Date().getFullYear() - 5;
      const add = () => call(m.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr, parentalConsentVersion: "v1" }).then((r) => r.status);
      expect([await add(), await add(), await add()]).toEqual([201, 201, 409]);
    } finally { delete process.env.CIVIC_MAX_DEPENDENTS; }
  });

  it("invite accept reports distinct codes for a phone mismatch and a wrong PIN", async () => {
    const h = person(); const other = person("9800000002"); const right = person("9800000001");
    await call(h.token, "POST", "/");
    const id = (await call(h.token, "POST", "/members/invite", { phone: "9800000001", relation: "spouse" })).body.inviteId;
    expect((await call(other.token, "POST", "/invites/accept", { inviteId: id, pin: "7396" })).body.code).toBe("phone_mismatch");
    const weak = await call(right.token, "POST", "/invites/accept", { inviteId: id, pin: "1234" });
    expect(weak.status).toBe(400); expect(weak.body.code).toBe("weak_pin");
  });
});

describe("households: atomic erasure and deletion", () => {
  it("rolls back dependent erasure if it fails midway", async () => {
    const head = person();
    await call(head.token, "POST", "/");
    const yr = new Date().getFullYear();
    await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 17, parentalConsentVersion: "v1" });
    await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: yr - 16, parentalConsentVersion: "v1" });
    const db = getDb();
    db.exec(`CREATE TRIGGER boom BEFORE DELETE ON hh_member WHEN OLD.year_of_birth = ${yr - 16} BEGIN SELECT RAISE(ABORT,'boom'); END`);
    const cnt = () => (db.prepare("SELECT COUNT(*) AS c FROM hh_member WHERE status='dependent'").get() as { c: number }).c;
    const start = cnt();
    try {
      expect(() => eraseDependentsAt18(new Date(yr + 5, 1, 1))).toThrow();
      expect(cnt()).toBe(start);
    } finally { db.exec("DROP TRIGGER boom"); }
    expect(eraseDependentsAt18(new Date(yr + 5, 1, 1))).toBeGreaterThanOrEqual(2);
  });

  it("head deletes the household in one go; members cannot", async () => {
    const head = person(); const m = person("9000000096");
    await call(head.token, "POST", "/");
    const id = (await call(head.token, "POST", "/members/invite", { phone: "9000000096", relation: "spouse" })).body.inviteId;
    await call(m.token, "POST", "/invites/accept", { inviteId: id, pin: "7394" });
    await call(head.token, "POST", "/dependents", { relation: "son", yearOfBirth: new Date().getFullYear() - 4, parentalConsentVersion: "v1" });
    expect((await call(m.token, "DELETE", "/")).status).toBe(403);
    expect((await call(head.token, "DELETE", "/")).status).toBe(200);
    const db = getDb();
    expect(db.prepare("SELECT COUNT(*) AS c FROM hh_household WHERE head_person_id=?").get(head.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM hh_member WHERE person_id=?").get(m.id)).toEqual({ c: 0 });
    expect((await call(head.token, "GET", "/mine")).status).toBe(404);
  });
});
