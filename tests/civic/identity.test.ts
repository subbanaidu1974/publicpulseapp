import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { audit, getDb, getKeys, migrate, resetDbForTests, smsOutbox, registerErasureHook, verifyAuditChain, getStore } from "../../server/civic/core";
import { identityRouter, grantVolunteer, isSurveyEligible, markResponded, markSurveyClosed, purgeExpired, networkPrefix, networkKeys, DEV_NUMBER_FIXTURES } from "../../server/civic/identity/routes";

let server: Server;
let base = "";
const PHONE = "+919876543210";
const PHONE2 = "+919876543211";

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/identity", identityRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/identity`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  process.env.CIVIC_EXPOSE_DEV_OTP = "1";
  delete process.env.CIVIC_ATTEST_DAILY_QUOTA;
  resetDbForTests();
  migrate();
});
afterEach(() => { vi.restoreAllMocks(); });

async function call(method: string, p: string, body?: unknown, token?: string) {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : {} };
}

async function signup(phone: string, pin = "4821") {
  const rq = await call("POST", "/signup/request", { phone });
  expect(rq.status).toBe(200);
  const v = await call("POST", "/signup/verify", { phone, otp: rq.json.dev_otp, pin });
  expect(v.status).toBe(201);
  return { token: v.json.token as string, id: v.json.person.id as string, person: v.json.person };
}

describe("identity: sign-up (S-18)", () => {
  it("@E2E-25 creates a T0 account; the DB and logs never hold the clear phone number", async () => {
    const log = vi.spyOn(console, "log"), info = vi.spyOn(console, "info"), warn = vi.spyOn(console, "warn"), err = vi.spyOn(console, "error");
    const rq = await call("POST", "/signup/request", { phone: PHONE });
    expect(rq.status).toBe(200);
    expect(rq.json.dev_otp).toMatch(/^\d{6}$/);
    const otp = rq.json.dev_otp as string;
    const v = await call("POST", "/signup/verify", { phone: PHONE, otp, pin: "4821" });
    expect(v.status).toBe(201);
    expect(v.json.person.tier).toBe("T0");
    const me = await call("GET", "/me", undefined, v.json.token);
    expect(me.json.person.tier).toBe("T0");
    // stored value is the keyed hash
    const row = getDb().prepare("SELECT phone_hash, phone_enc, pin_hash FROM persons WHERE id = ?").get(v.json.person.id) as { phone_hash: string; phone_enc: string; pin_hash: string };
    expect(row.phone_hash).toBe(getKeys().hmac("phone", PHONE));
    expect(getKeys().decrypt("phone", row.phone_enc)).toBe(PHONE);
    expect(row.pin_hash).not.toContain("4821");
    // clear number and OTP appear nowhere in any table or any log line
    const dump = JSON.stringify(["persons", "otps", "sessions", "audit_log", "consents", "rate_events", "attestations"].map((t) => (t === "audit_log" ? getStore("audit") : getDb()).prepare(`SELECT * FROM ${t}`).all()));
    expect(dump).not.toContain(PHONE);
    expect(dump).not.toContain(PHONE.slice(3));
    const logged = JSON.stringify([log.mock.calls, info.mock.calls, warn.mock.calls, err.mock.calls]);
    expect(logged).not.toContain(PHONE.slice(3));
    expect(logged).not.toContain(otp);
    // consent recorded, 14-day gate exposed
    const c = getDb().prepare("SELECT purpose, version FROM consents WHERE person_id = ?").get(v.json.person.id) as { purpose: string; version: string };
    expect(c).toEqual({ purpose: "signup", version: "v1" });
    const days = (Date.parse(v.json.person.eligible_from) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  it("OTP: wrong code rejected, 5-minute expiry, no dev OTP unless exposed, per-phone rate limit", async () => {
    const rq = await call("POST", "/signup/request", { phone: PHONE });
    expect((await call("POST", "/signup/verify", { phone: PHONE, otp: rq.json.dev_otp === "000000" ? "111111" : "000000", pin: "4821" })).status).toBe(400);
    getDb().prepare("UPDATE otps SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await call("POST", "/signup/verify", { phone: PHONE, otp: rq.json.dev_otp, pin: "4821" })).status).toBe(400);
    process.env.CIVIC_EXPOSE_DEV_OTP = "0";
    const hidden = await call("POST", "/signup/request", { phone: PHONE });
    expect(hidden.json.dev_otp).toBeUndefined();
    expect(smsOutbox.at(-1)!.text).toMatch(/\d{6}/); // delivered by SMS only
    expect((await call("POST", "/signup/request", { phone: PHONE })).status).toBe(200); // 3rd
    expect((await call("POST", "/signup/request", { phone: PHONE })).status).toBe(429); // 4th in window
    expect((await call("POST", "/signup/request", { phone: "12345" })).status).toBe(400);
  });

  it("@E2E-26 recently re-issued numbers are flagged and never survey-eligible; the age gate holds for 14 days; VoIP is blocked", async () => {
    const reissued = [...DEV_NUMBER_FIXTURES.reissued][0];
    const a = await signup(reissued);
    expect(a.person.flags).toContain("recently_reissued");
    expect(a.person.survey_eligible).toBe(false);
    const day15 = new Date(Date.now() + 15 * 86400000);
    expect(isSurveyEligible(a.id, day15)).toBe(false); // flag blocks even after the age gate

    const b = await signup(PHONE);
    expect(b.person.survey_eligible).toBe(false); // under 14 days
    expect(isSurveyEligible(b.id, new Date(Date.now() + 13 * 86400000))).toBe(false);
    expect(isSurveyEligible(b.id, day15)).toBe(true);

    const voip = [...DEV_NUMBER_FIXTURES.voip][0];
    expect((await call("POST", "/signup/request", { phone: voip })).status).toBe(403);
  });
});

describe("identity: shared SIM (S-19)", () => {
  it("@E2E-27 two adults link to one SIM, each with own PIN, and answer separately", async () => {
    const a = await signup(PHONE, "4821");
    const link = await call("POST", "/sim/link", { pin: "7345", label: "Amma", consent_version: "v1" }, a.token);
    expect(link.status).toBe(201);
    expect(link.text).not.toContain("7345");
    const bId = link.json.person.id as string;
    expect(bId).not.toBe(a.id);
    const rows = getDb().prepare("SELECT phone_hash FROM persons WHERE phone_hash = ?").all(getKeys().hmac("phone", PHONE));
    expect(rows).toHaveLength(2);
    // ambiguous login must name the person
    expect((await call("POST", "/login", { phone: PHONE, pin: "7345" })).status).toBe(400);
    const la = await call("POST", "/login", { phone: PHONE, pin: "4821", person_id: a.id });
    const lb = await call("POST", "/login", { phone: PHONE, pin: "7345", person_id: bId });
    expect(la.status).toBe(200); expect(lb.status).toBe(200);
    expect(la.json.person.id).toBe(a.id); expect(lb.json.person.id).toBe(bId);
    // A's PIN does not open B's account
    expect((await call("POST", "/login", { phone: PHONE, pin: "4821", person_id: bId })).status).toBe(401);
    // each answers separately
    markResponded(a.id, "S1"); markResponded(bId, "S1");
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM has_responded WHERE survey_id = 'S1'").get()).toEqual({ c: 2 });
    // another SIM does not see them
    const other = await signup(PHONE2);
    expect((await call("GET", "/sim/members", undefined, other.token)).json.members).toHaveLength(1);
  });

  it("@E2E-28 lockout after 5 wrong PINs; the SIM holder is told; no PIN is ever shown", async () => {
    const a = await signup(PHONE, "4821");
    const link = await call("POST", "/sim/link", { pin: "7345", label: "Appa", consent_version: "v1" }, a.token);
    const bId = link.json.person.id as string;
    smsOutbox.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("POST", "/login", { phone: PHONE, pin: "0000", person_id: bId })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 423, 423]);
    // even the right PIN is refused while locked
    expect((await call("POST", "/login", { phone: PHONE, pin: "7345", person_id: bId })).status).toBe(423);
    // the SIM holder is notified, and the notice carries no PIN
    const notice = smsOutbox.filter((m) => m.to === PHONE && /locked/i.test(m.text));
    expect(notice).toHaveLength(1);
    for (const pin of ["4821", "7345", "0000"]) expect(notice[0].text).not.toContain(pin);
    // another adult on the SIM sees only the locked state
    const members = await call("GET", "/sim/members", undefined, a.token);
    expect(members.json.members.find((m: { person_id: string }) => m.person_id === bId).locked).toBe(true);
    expect(members.text).not.toMatch(/pin/i);
    // A is unaffected; unlock after the window
    expect((await call("POST", "/login", { phone: PHONE, pin: "4821", person_id: a.id })).status).toBe(200);
    getDb().prepare("UPDATE pin_failures SET locked_until = ? WHERE person_id = ?").run(new Date(Date.now() - 1000).toISOString(), bId);
    expect((await call("POST", "/login", { phone: PHONE, pin: "7345", person_id: bId })).status).toBe(200);
  });
});

describe("identity: lockout abuse resistance", () => {
  beforeEach(() => { process.env.CIVIC_TRUSTED_EDGE_IPS = "127.0.0.1,::1"; }); // the test client plays the trusted edge, so its device ids are believed
  afterEach(() => { delete process.env.CIVIC_TRUSTED_EDGE_IPS; });
  const wrong = (phone: string, id: string, dev: string, pin = "0000") => call2("/login", { phone, pin, person_id: id }, { "x-device-id": dev, "x-edge-verified": "1" });
  async function call2(p: string, body: unknown, headers: Record<string, string>) {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  }

  it("an attacker who locks their own device does not lock the owner out; a global ceiling rate-limits foreign sources", async () => {
    process.env.CIVIC_PIN_GLOBAL_CEILING = "8";
    try {
      const a = await signup(PHONE, "4821");
      expect((await wrap(PHONE, "4821", a.id, "owner-phone")).status).toBe(200); // owner source is now known
      const st: number[] = [];
      for (let i = 0; i < 5; i++) st.push((await wrong(PHONE, a.id, "attacker-1")).status);
      expect(st).toEqual([401, 401, 401, 401, 423]);
      expect((await wrong(PHONE, a.id, "owner-phone", "4821")).status).toBe(200); // owner unaffected
      // attacker rotates devices: ceiling (8 wrong in the window) kicks in as a rate limit, not a lock
      const more: number[] = [];
      for (let i = 0; i < 5; i++) more.push((await wrong(PHONE, a.id, "attacker-" + (i + 2))).status);
      expect(more).toContain(429);
      // owner on a known device still gets in; a brand-new device is limited until a fresh OTP resets the PIN
      expect((await wrong(PHONE, a.id, "owner-phone", "4821")).status).toBe(200);
      expect((await wrong(PHONE, a.id, "owner-new-phone", "4821")).status).toBe(429);
      const rq = await call("POST", "/signup/request", { phone: PHONE });
      const rec = await call("POST", "/pin/recover", { phone: PHONE, otp: rq.json.dev_otp, new_pin: "2468", person_id: a.id });
      expect(rec.status).toBe(200);
      expect((await wrong(PHONE, a.id, "owner-new-phone", "2468")).status).toBe(200);
      expect((await wrong(PHONE, a.id, "attacker-1", "4821")).status).toBe(401); // old PIN dead
    } finally { delete process.env.CIVIC_PIN_GLOBAL_CEILING; }
  });
  const wrap = (phone: string, pin: string, id: string, dev: string) => wrong(phone, id, dev, pin);
});

describe("identity: per-network OTP cap", () => {
  it("derives /24 and /48 prefixes and adds an x-asn bucket", () => {
    expect(networkPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(networkPrefix("::ffff:203.0.113.5")).toBe("203.0.113.0/24");
    expect(networkPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(networkPrefix("2001:db8:abcd:ff::9")).toBe(networkPrefix("2001:0db8:abcd:1::2"));
    expect(networkKeys("203.0.113.1", "AS64500")).toEqual(["net:203.0.113.0/24", "asn:AS64500"]);
    expect(networkKeys("203.0.113.1")).toEqual(["net:203.0.113.0/24"]);
  });

  it("caps OTP requests per network across different phones (env-configurable)", async () => {
    process.env.CIVIC_OTP_NET_LIMIT = "3";
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await call("POST", "/signup/request", { phone: "+91987654330" + i })).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally { delete process.env.CIVIC_OTP_NET_LIMIT; }
  });

  it("rotating the spoofable x-asn header does not evade the prefix cap", async () => {
    process.env.CIVIC_OTP_NET_LIMIT = "2";
    try {
      const req = (phone: string, asn: string) => fetch(base + "/signup/request", { method: "POST", headers: { "content-type": "application/json", "x-asn": asn }, body: JSON.stringify({ phone }) }).then((r) => r.status);
      expect(await req("+919876543401", "AS1")).toBe(200);
      expect(await req("+919876543402", "AS2")).toBe(200);
      expect(await req("+919876543403", "AS3")).toBe(429);
    } finally { delete process.env.CIVIC_OTP_NET_LIMIT; }
  });
});

describe("identity: trust tiers (S-20)", () => {
  it("@E2E-29 one attestation stays T1, two independent attestors reach T2, quota enforced, attestors hidden", async () => {
    const res = await signup(PHONE, "4821");
    await call("POST", "/residence", { residence: "Kothapalli hamlet, Rayavaram" }, res.token);
    expect((await call("GET", "/me", undefined, res.token)).json.person.tier).toBe("T1");
    const v1 = await signup("+919876543221"); const v2 = await signup("+919876543222"); const v3 = await signup("+919876543223");
    expect((await call("POST", "/attest", { person_id: res.id }, v1.token)).status).toBe(403); // not a volunteer yet
    grantVolunteer(v1.id, "shg-a"); grantVolunteer(v2.id, "shg-b"); grantVolunteer(v3.id, "shg-a");

    const r1 = await call("POST", "/attest", { person_id: res.id }, v1.token);
    expect(r1.status).toBe(200); expect(r1.json.tier).toBe("T1");
    expect((await call("POST", "/attest", { person_id: res.id }, v1.token)).status).toBe(409); // same volunteer twice
    expect((await call("POST", "/attest", { person_id: res.id }, v3.token)).status).toBe(409); // same organisation: not independent
    expect((await call("GET", "/me", undefined, res.token)).json.person.tier).toBe("T1");
    const r2 = await call("POST", "/attest", { person_id: res.id }, v2.token);
    expect(r2.json.tier).toBe("T2");
    const me = await call("GET", "/me", undefined, res.token);
    expect(me.json.person.tier).toBe("T2");
    expect(me.text).not.toContain(v1.id); expect(me.text).not.toContain(v2.id);
    // attestor identity is in the audit log
    const rows = getStore("audit").prepare("SELECT actor FROM audit_log WHERE action = 'attest.residence'").all() as { actor: string }[];
    expect(rows.map((r) => r.actor)).toEqual([v1.id, v2.id]);
    expect(verifyAuditChain().ok).toBe(true);

    // per-volunteer daily quota
    process.env.CIVIC_ATTEST_DAILY_QUOTA = "1";
    const other = await signup("+919876543224");
    await call("POST", "/residence", { residence: "Another hamlet" }, other.token);
    expect((await call("POST", "/attest", { person_id: other.id }, v1.token)).status).toBe(429);
    // T2 never changes weights: nothing in the person view carries a weight
    expect(JSON.stringify(me.json)).not.toMatch(/weight/i);
  });

  it("attestation needs a declared residence and cannot come from the same SIM", async () => {
    const a = await signup(PHONE);
    const link = await call("POST", "/sim/link", { pin: "7345", consent_version: "v1" }, a.token);
    grantVolunteer(a.id);
    await call("POST", "/residence", { residence: "Somewhere" }, (await call("POST", "/login", { phone: PHONE, pin: "7345", person_id: link.json.person.id })).json.token);
    expect((await call("POST", "/attest", { person_id: link.json.person.id }, a.token)).status).toBe(403); // same SIM
    const v = await signup(PHONE2); grantVolunteer(v.id, "x");
    const nores = await signup("+919876543225");
    expect((await call("POST", "/attest", { person_id: nores.id }, v.token)).status).toBe(409);
  });
});

describe("identity: erasure and retention (S-43)", () => {
  it("@E2E-52 account deletion removes the phone copy, redacts has_responded and audit entries, and the chain still verifies", async () => {
    const hookSeen: string[] = [];
    registerErasureHook("test.hook", (id) => hookSeen.push(id));
    const a = await signup(PHONE, "4821");
    await call("POST", "/residence", { residence: "Rayavaram" }, a.token);
    markResponded(a.id, "S1"); markResponded(a.id, "S2");
    audit(a.id, "custom.event", "thing:" + a.id, { k: 1 });
    const before = (getStore("audit").prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;

    expect((await call("DELETE", "/me", { pin: "9999" }, a.token)).status).toBe(401);
    const del = await call("DELETE", "/me", { pin: "4821" }, a.token);
    expect(del.status).toBe(200);
    expect(hookSeen).toEqual([a.id]);

    const p = getDb().prepare("SELECT phone_hash, phone_enc, pin_hash, residence_enc, label, deleted_at FROM persons WHERE id = ?").get(a.id) as Record<string, unknown>;
    expect(p.phone_enc).toBeNull(); expect(p.phone_hash).toBeNull(); expect(p.pin_hash).toBeNull(); expect(p.residence_enc).toBeNull();
    expect(p.deleted_at).not.toBeNull();
    // has_responded rows survive (turnout counts) but no longer reference the person
    const hr = getDb().prepare("SELECT person_id FROM has_responded").all() as { person_id: string }[];
    expect(hr).toHaveLength(2);
    for (const r of hr) expect(r.person_id.startsWith("redacted:")).toBe(true);
    // audit rows are redacted, not removed; nothing references the id; chain verifies
    const rows = getStore("audit").prepare("SELECT actor, object, meta, redacted FROM audit_log").all() as { actor: string; object: string; meta: string; redacted: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(rows)).not.toContain(a.id);
    expect(rows.filter((r) => r.redacted).length).toBeGreaterThan(0);
    expect(verifyAuditChain().ok).toBe(true);
    // old session is dead; the number can sign up again
    expect((await call("GET", "/me", undefined, a.token)).status).toBe(401);
    expect((await call("POST", "/login", { phone: PHONE, pin: "4821" })).status).toBe(401);
    await signup(PHONE, "5739");
    expect(verifyAuditChain().ok).toBe(true);
    // re-marking a redacted row as unredacted without its audit.redact record is detected
    const seq = (getStore("audit").prepare("SELECT seq FROM audit_log WHERE redacted = 1 LIMIT 1").get() as { seq: number }).seq;
    getStore("audit").prepare("DELETE FROM audit_log WHERE action = 'audit.redact'").run();
    expect(verifyAuditChain().ok).toBe(false);
    expect(seq).toBeGreaterThan(0);
  });

  it("@E2E-53 retention job removes phone copies and residence data older than the window, keeps the rest", async () => {
    const a = await signup(PHONE);
    await call("POST", "/residence", { residence: "Rayavaram" }, a.token);
    const inWindow = purgeExpired(new Date(Date.now() + 5 * 86400000));
    expect(inWindow.phone_copies).toBe(0); expect(inWindow.residence).toBe(0);
    const row = () => getDb().prepare("SELECT phone_enc, residence_enc, phone_hash, phone_purged_at FROM persons WHERE id = ?").get(a.id) as Record<string, unknown>;
    expect(row().phone_enc).not.toBeNull();
    const out = purgeExpired(new Date(Date.now() + 200 * 86400000));
    expect(out.phone_copies).toBe(1); expect(out.residence).toBe(1);
    expect(row().phone_enc).toBeNull(); expect(row().residence_enc).toBeNull();
    expect(row().phone_hash).not.toBeNull(); // login keeps working
    expect(row().phone_purged_at).not.toBeNull();
    expect(out.sessions).toBe(1); // 30-day session expired
    expect(verifyAuditChain().ok).toBe(true);
    expect((await call("POST", "/login", { phone: PHONE, pin: "4821" })).status).toBe(200);
  });

  it("retention runs from last activity / survey close, not creation", async () => {
    const day = 86400000;
    const a = await signup(PHONE);
    const b = await signup(PHONE2);
    await call("POST", "/residence", { residence: "Rayavaram" }, a.token);
    markResponded(b.id, "S9");
    // A was active 100 days from now; B responded to a survey that closed 150 days from now
    getDb().prepare("UPDATE persons SET last_active_at = ?, residence_declared_at = ? WHERE id = ?").run(new Date(Date.now() + 100 * day).toISOString(), new Date(Date.now() - 400 * day).toISOString(), a.id);
    getDb().prepare("UPDATE persons SET last_active_at = ? WHERE id = ?").run(new Date(Date.now() - 400 * day).toISOString(), b.id);
    getDb().prepare("UPDATE persons SET created_at = ? WHERE id IN (?, ?)").run(new Date(Date.now() - 400 * day).toISOString(), a.id, b.id);
    markSurveyClosed("S9", new Date(Date.now() + 150 * day));
    expect(purgeExpired(new Date(Date.now() + 200 * day)).phone_copies).toBe(0); // both anchored within 180 days
    const out = purgeExpired(new Date(Date.now() + 290 * day)); // A idle 190d; B closed 140d ago
    expect(out.phone_copies).toBe(1);
    const enc = (id: string) => (getDb().prepare("SELECT phone_enc FROM persons WHERE id = ?").get(id) as { phone_enc: string | null }).phone_enc;
    expect(enc(a.id)).toBeNull(); expect(enc(b.id)).not.toBeNull();
    expect(purgeExpired(new Date(Date.now() + 400 * day)).phone_copies).toBe(1); // B too, once its close date ages out
  });

  it("account deletion is atomic: a failing erasure hook rolls everything back", async () => {
    const a = await signup(PHONE, "4821");
    await call("POST", "/residence", { residence: "Rayavaram" }, a.token);
    markResponded(a.id, "S1");
    audit(a.id, "custom.event", "thing:" + a.id, { k: 1 });
    registerErasureHook("test.zz_fail", () => { throw new Error("boom"); });
    try {
      const del = await call("DELETE", "/me", { pin: "4821" }, a.token);
      expect(del.status).toBe(500);
      const p = getDb().prepare("SELECT phone_hash, phone_enc, residence_enc, deleted_at FROM persons WHERE id = ?").get(a.id) as Record<string, unknown>;
      expect(p.phone_hash).not.toBeNull(); expect(p.phone_enc).not.toBeNull(); expect(p.residence_enc).not.toBeNull(); expect(p.deleted_at).toBeNull();
      expect((getDb().prepare("SELECT person_id FROM has_responded").get() as { person_id: string }).person_id).toBe(a.id); // earlier hook rolled back
      expect((getStore("audit").prepare("SELECT COUNT(*) AS c FROM audit_log WHERE redacted = 1").get() as { c: number }).c).toBe(0);
      expect((getDb().prepare("SELECT COUNT(*) AS c FROM consents WHERE person_id = ?").get(a.id) as { c: number }).c).toBe(1);
      expect((await call("GET", "/me", undefined, a.token)).status).toBe(200); // session survives
      expect(verifyAuditChain().ok).toBe(true);
    } finally { registerErasureHook("test.zz_fail", () => {}); }
    expect((await call("DELETE", "/me", { pin: "4821" }, a.token)).status).toBe(200); // works once the hook is healthy
  });
});
