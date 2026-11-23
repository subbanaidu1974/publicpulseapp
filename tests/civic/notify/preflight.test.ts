import { beforeEach, describe, expect, it } from "vitest";
import { getDb, getStore, grantRole } from "../../../server/civic/core";
import { setNotifyCalendar } from "../../../server/civic/notify";
import * as d from "../../../server/civic/notify/delivery";
import * as svc from "../../../server/civic/notify/service";
import { MSG, call, freshWorld, mkAdmin, mkOrg, mkPerson, mkSender, serve } from "./helpers";

beforeEach(freshWorld);
const CAL = { schema: 1, coveredFrom: "2026-01-01", coveredThrough: "2027-01-01", entries: [{ state: "AP", mccStart: "2026-06-10", end: "2026-06-20", source: "test", verified: true }] };

describe("sender pre-flight: lint, public status (S-155)", () => {
  it("@E2E-170 POST /messages/lint returns findings without creating or logging anything, for senders only", async () => {
    const { s, base } = await serve();
    try {
      setNotifyCalendar(CAL);
      const org = mkOrg(), a = mkSender(org);
      const before = (getDb().prepare("SELECT COUNT(*) AS c FROM notify_messages").get() as { c: number }).c;
      const blocksBefore = svc.publicBlockLog().length;
      expect((await call(base, "POST", "/messages/lint", { body: MSG })).status).toBe(401);
      expect((await call(base, "POST", "/messages/lint", { token: mkPerson().token, body: MSG })).body.code).toBe("not_a_sender");
      const clean = await call(base, "POST", "/messages/lint", { token: a.token, body: { text_en: MSG.text_en, text_te: MSG.text_te, state: "AP" } });
      expect(clean.status).toBe(200);
      expect(clean.body).toMatchObject({ clean: true, findings: [], rules: [], mcc: { state: "AP", window: "open" } });
      const bad = await call(base, "POST", "/messages/lint", { token: a.token, body: { text_en: "Share your OTP and visit http://evil.example/pay now", text_te: "ఇక్కడ క్లిక్ చేయండి", title_en: "Hello" } });
      expect(bad.body.clean).toBe(false);
      expect(bad.body.rules).toEqual(expect.arrayContaining(["otp", "link_not_allowed", "click_here"]));
      expect(bad.body.findings.find((f: any) => f.rule === "otp")).toMatchObject({ field: "text_en" });
      expect(bad.body.findings.find((f: any) => f.rule === "click_here")).toMatchObject({ field: "text_te" });
      expect((await call(base, "POST", "/messages/lint", { token: a.token, body: { slots: { place: "pay by UPI" } } })).body.findings[0]).toMatchObject({ field: "slot:place", rule: "payment" });
      // nothing was created, no block log row, and the real create path still refuses the same text
      expect((getDb().prepare("SELECT COUNT(*) AS c FROM notify_messages").get() as { c: number }).c).toBe(before);
      expect(svc.publicBlockLog().length).toBe(blocksBefore);
      const real = await call(base, "POST", "/messages", { token: a.token, body: { ...MSG, text_en: "Share your OTP now" } });
      expect(real.status).toBe(422);
      expect(real.body.rules).toContain("otp");
    } finally { s.close(); }
  });

  it("@E2E-170 GET /notify/status is public: kill switch (no reason) and the MCC window notice", async () => {
    const { s, base } = await serve();
    try {
      setNotifyCalendar(CAL);
      const org = mkOrg(), other = mkOrg("department", "Health Department");
      const open = await call(base, "GET", "/status?state=AP");
      expect(open.status).toBe(200);
      expect(open.body.kill).toMatchObject({ engaged: false, scope: null, since: null });
      expect(open.body.window).toMatchObject({ state: "AP", status: "open", declaration_needed: false });
      expect((await call(base, "GET", "/status?state=1x")).body.code).toBe("bad_state");
      const admin = mkAdmin();
      svc.engageKill(admin.id, { scope: "org", org_id: org.id, reason: "suspected hijack of a sender" });
      const orgKill = await call(base, "GET", `/status?state=AP&org_id=${org.id}`);
      expect(orgKill.body.kill).toMatchObject({ engaged: true, scope: "org", orgs_suspended: 1 });
      expect(orgKill.body.kill.notice_te).toMatch(/[ఀ-౿]/);
      expect((await call(base, "GET", `/status?org_id=${other.id}`)).body.kill.engaged).toBe(false);
      expect((await call(base, "GET", "/status")).body.kill).toMatchObject({ engaged: false, orgs_suspended: 1 });
      svc.engageKill(admin.id, { scope: "all", reason: "global stop for the test" });
      const all = await call(base, "GET", "/status");
      expect(all.body.kill).toMatchObject({ engaged: true, scope: "all" });
      expect(all.body.kill.since).toMatch(/^\d{4}-/);
      expect(JSON.stringify(all.body)).not.toMatch(/suspected hijack|global stop|reason/);
      // MCC window: blackout, then unknown (calendar unreadable)
      const { setNotifyClock } = await import("../../../server/civic/notify");
      setNotifyClock(() => new Date("2026-06-10T06:00:00Z"));
      const black = await call(base, "GET", "/status?state=AP");
      expect(black.body.window).toMatchObject({ status: "blackout", declaration_needed: true });
      expect(black.body.window.notice_en).toMatch(/code of conduct is in force/);
      setNotifyCalendar(null);
      const unk = await call(base, "GET", "/status?state=AP");
      expect(unk.body.window).toMatchObject({ status: "unknown", declaration_needed: true, blocked_categories: expect.arrayContaining(["scheme", "other"]) });
    } finally { s.close(); }
  });
});

describe("own devices (S-155)", () => {
  it("@E2E-170 GET /devices lists the caller's devices and never a token", async () => {
    const { s, base } = await serve();
    try {
      const p = mkPerson(), q = mkPerson();
      expect((await call(base, "GET", "/devices")).status).toBe(401);
      expect((await call(base, "GET", "/devices", { token: p.token })).body).toEqual({ devices: [], count: 0 });
      d.registerDevice(p.id, "token-abcdefghij-1", "android");
      d.registerDevice(p.id, "token-abcdefghij-2", "ios");
      d.registerDevice(q.id, "token-other-person", "web");
      const r = await call(base, "GET", "/devices", { token: p.token });
      expect(r.body.count).toBe(2);
      expect(r.body.devices.map((x: any) => x.platform).sort()).toEqual(["android", "ios"]);
      expect(r.body.devices[0]).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{12}$/), label_en: expect.any(String), label_te: expect.any(String), created_at: expect.any(String) });
      expect(JSON.stringify(r.body)).not.toMatch(/token-|token_/);
      await call(base, "DELETE", "/devices", { token: p.token });
      expect((await call(base, "GET", "/devices", { token: p.token })).body.count).toBe(0);
      expect((await call(base, "GET", "/devices", { token: q.token })).body.count).toBe(1);
    } finally { s.close(); }
  });
});

describe("admin lookups (S-155)", () => {
  it("@E2E-170 people lookup: a phone is a query only; the answer is an opaque id, masked tail and roles, audited", async () => {
    const { s, base } = await serve();
    try {
      const admin = mkAdmin(), cand = mkPerson({ unit: null });
      getDb().prepare("UPDATE persons SET label = ? WHERE id = ?").run("Sita Rao (volunteer)", cand.id);
      grantRole("system", cand.id, "officer", null, "Revenue");
      const phone = (getDb().prepare("SELECT phone_enc FROM persons WHERE id = ?").get(cand.id) as { phone_enc: string }).phone_enc;
      expect(phone).toBeTruthy();
      expect((await call(base, "GET", "/admin/people?q=abc", { token: mkPerson().token })).status).toBe(403);
      expect((await call(base, "GET", "/admin/people?q=ab", { token: admin.token })).body.code).toBe("query_too_short");
      const num = (await import("../../../server/civic/core")).getKeys().decrypt("phone", phone);
      const byPhone = await call(base, "GET", `/admin/people?q=${encodeURIComponent(num)}`, { token: admin.token });
      expect(byPhone.status).toBe(200);
      expect(byPhone.body.people).toHaveLength(1);
      const hit = byPhone.body.people[0];
      expect(hit).toMatchObject({ person_id: cand.id, matched_by: "phone", roles: [expect.objectContaining({ role: "officer", department: "Revenue" })], senders: [] });
      expect(hit.phone_tail).toBe("••••" + num.slice(-4));
      const flat = JSON.stringify(byPhone.body);
      expect(flat).not.toContain(num);
      expect(flat).not.toContain(num.slice(3));
      expect(flat).not.toContain("Sita");
      const byName = await call(base, "GET", "/admin/people?q=sita", { token: admin.token });
      expect(byName.body.people.map((x: any) => x.person_id)).toEqual([cand.id]);
      expect(byName.body.people[0].matched_by).toBe("name_hint");
      expect(JSON.stringify(byName.body)).not.toMatch(/Sita|Rao/);
      expect((await call(base, "GET", "/admin/people?q=zzzzzz", { token: admin.token })).body.people).toEqual([]);
      const audits = getStore("audit").prepare("SELECT object, meta FROM audit_log WHERE action = 'read.sensitive' AND object = 'notify_people_lookup'").all() as { object: string; meta: string }[];
      expect(audits.length).toBeGreaterThanOrEqual(3);
      expect(audits.map((a) => a.meta).join()).not.toContain(num);
    } finally { s.close(); }
  });

  it("@E2E-170 credential lookup by sender: ids for revocation, no key material, admin only", async () => {
    const { s, base } = await serve();
    try {
      const org = mkOrg(), a = mkSender(org), admin = mkAdmin();
      expect((await call(base, "GET", `/admin/credentials?sender=${a.senderId}`, { token: a.token })).status).toBe(403);
      expect((await call(base, "GET", "/admin/credentials", { token: admin.token })).body.code).toBe("sender_required");
      expect((await call(base, "GET", "/admin/credentials?sender=nope", { token: admin.token })).status).toBe(404);
      const r = await call(base, "GET", `/admin/credentials?sender=${a.senderId}`, { token: admin.token });
      expect(r.status).toBe(200);
      expect(r.body.sender).toMatchObject({ id: a.senderId, org_name: "Revenue Department", status: "active" });
      expect(r.body.credentials).toHaveLength(1);
      expect(r.body.credentials[0]).toMatchObject({ id: a.authn.id, revoked: false });
      expect(JSON.stringify(r.body)).not.toMatch(/spki|public_key/);
      svc.revokeCredential(admin.id, a.authn.id);
      expect((await call(base, "GET", `/admin/credentials?sender=${a.senderId}`, { token: admin.token })).body.credentials[0].revoked).toBe(true);
      expect(getStore("audit").prepare("SELECT 1 AS x FROM audit_log WHERE action = 'read.sensitive' AND object LIKE 'notify_credentials:%'").get()).toBeTruthy();
    } finally { s.close(); }
  });
});
