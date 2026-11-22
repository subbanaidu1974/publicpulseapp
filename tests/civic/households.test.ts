import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "node:crypto";
import { createSession, getDb, migrate, resetDbForTests, smsOutbox } from "../../server/civic/core";
import { eraseDependentsAt18, householdRouter, INVITE_TTL_MS } from "../../server/civic/households/routes";

let server: Server;
let base: string;

function person(): { id: string; token: string } {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?,?,?)").run(id, now, now);
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
  await new Promise<void>((res) => { server = app.listen(0, "127.0.0.1", () => res()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); resetDbForTests(); });
beforeEach(() => { smsOutbox.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

const PHONE = "9876543210";

describe("households: adult invite (S-21)", () => {
  it("@E2E-30 invitee gets the notice first, stores only a hash, accepts with own PIN; head never sees answers", async () => {
    const head = person(); const spouse = person();
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
    const pin = db.prepare("SELECT pin_hash FROM hh_pin WHERE person_id=?").get(spouse.id) as { pin_hash: string };
    expect(pin.pin_hash).not.toContain("4821");
    expect((await call(spouse.token, "POST", "/invites/accept", { inviteId, pin: "4821" })).status).toBe(409); // single use

    // Head roster: members and statuses only. No answers, no phone, no pin fields.
    const roster = await call(head.token, "GET", "/mine");
    expect(roster.body.members).toHaveLength(2);
    const text = JSON.stringify(roster.body);
    expect(text).not.toMatch(/answer|response|phone|pin/i);
    expect(text).not.toContain(PHONE);
  });

  it("@E2E-30 invite expires at 72h and can no longer be accepted", async () => {
    const head = person(); const late = person();
    await call(head.token, "POST", "/");
    const inv = await call(head.token, "POST", "/members/invite", { phone: "9123456780", relation: "parent" });
    const inviteId = inv.body.inviteId as string;
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + INVITE_TTL_MS + 60_000);
    const r = await call(late.token, "POST", "/invites/accept", { inviteId, pin: "1234" });
    expect(r.status).toBe(410);
    expect((getDb().prepare("SELECT phone_hash, status FROM hh_invite WHERE id=?").get(inviteId) as any)).toEqual({ phone_hash: null, status: "expired" });
    const mine = await call(head.token, "GET", "/mine");
    expect(mine.body.invites).toHaveLength(0);
  });

  it("@E2E-30 invitee can decline, or report 'I did not agree', which removes any membership", async () => {
    const head = person(); const a = person(); const b = person();
    await call(head.token, "POST", "/");
    const i1 = (await call(head.token, "POST", "/members/invite", { phone: "9000000001", relation: "sibling" })).body.inviteId;
    expect((await call(a.token, "POST", "/invites/decline", { inviteId: i1 })).status).toBe(200);
    expect((await call(a.token, "POST", "/invites/accept", { inviteId: i1, pin: "1234" })).status).toBe(409);

    const i2 = (await call(head.token, "POST", "/members/invite", { phone: "9000000002", relation: "spouse" })).body.inviteId;
    await call(b.token, "POST", "/invites/accept", { inviteId: i2, pin: "9999" });
    expect((await call(head.token, "GET", "/mine")).body.members).toHaveLength(2);
    // Someone else cannot report on b's behalf.
    expect((await call(a.token, "POST", "/invites/report-not-agreed", { inviteId: i2 })).status).toBe(403);
    expect((await call(b.token, "POST", "/invites/report-not-agreed", { inviteId: i2 })).status).toBe(200);
    expect((await call(head.token, "GET", "/mine")).body.members).toHaveLength(1);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action='household_invite_reported_not_agreed'").get()).toEqual({ c: 1 });
  });

  it("head role transfers to an adult member only; members cannot invite", async () => {
    const head = person(); const m = person(); const outsider = person();
    await call(head.token, "POST", "/");
    const id = (await call(head.token, "POST", "/members/invite", { phone: "9000000003", relation: "spouse" })).body.inviteId;
    await call(m.token, "POST", "/invites/accept", { inviteId: id, pin: "5555" });
    expect((await call(m.token, "POST", "/members/invite", { phone: "9000000004", relation: "other" })).status).toBe(403);
    expect((await call(head.token, "POST", "/transfer-head", { toPersonId: outsider.id })).status).toBe(400);
    expect((await call(head.token, "POST", "/transfer-head", { toPersonId: m.id })).status).toBe(200);
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
    const head = person(); const m = person();
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
