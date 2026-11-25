import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getDb, getKeys, getStore, migrate, resetDbForTests } from "../../server/civic/core";
import { identityRouter, isSurveyEligible, normalizeEmail } from "../../server/civic/identity/routes";
import { lastMailTo, mailOutbox, setMailProvider } from "../../server/civic/providers/mail";
import { EMAIL_REHASH, rehashTable } from "../../server/civic/providers/rehash";

let server: Server;
let base = "";
const EMAIL = "asha.rao@example.org";

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/identity", identityRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/identity`;
});
afterAll(() => { server.close(); });
beforeEach(() => { process.env.CIVIC_EXPOSE_DEV_OTP = "1"; resetDbForTests(); migrate(); mailOutbox.length = 0; setMailProvider(null); });

async function call(method: string, p: string, body?: unknown, token?: string) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}
async function signupEmail(email = EMAIL, pin = "4821") {
  const rq = await call("POST", "/signup/email/request", { email });
  expect(rq.status).toBe(200);
  const v = await call("POST", "/signup/email/verify", { email, otp: rq.json.dev_otp, pin, consent_version: "v1" });
  expect(v.status).toBe(201);
  return { token: v.json.token as string, id: v.json.person.id as string, person: v.json.person };
}

describe("email accounts for people with no phone (S-165)", () => {
  it("@E2E-189 signs up with an email and a code, stores only a keyed hash and an encrypted copy, and emails the code", async () => {
    const log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), err = vi.spyOn(console, "error");
    const rq = await call("POST", "/signup/email/request", { email: EMAIL });
    expect(rq.status).toBe(200);
    expect(rq.json.dev_otp).toMatch(/^\d{6}$/);
    expect(lastMailTo(EMAIL)?.text).toContain(rq.json.dev_otp);
    const v = await call("POST", "/signup/email/verify", { email: EMAIL, otp: rq.json.dev_otp, pin: "4821" });
    expect(v.status).toBe(201);
    expect(v.json.person.tier).toBe("T0");
    expect(v.json.person.flags).toContain("email_only");
    const row = getDb().prepare("SELECT phone_hash, phone_enc, email_hash, email_enc FROM persons WHERE id = ?").get(v.json.person.id) as Record<string, string | null>;
    expect(row.phone_hash).toBeNull();
    expect(row.phone_enc).toBeNull();
    expect(row.email_hash).toBe(getKeys().hmac("phone", "email:" + EMAIL));
    expect(getKeys().decrypt("phone", row.email_enc as string)).toBe("email:" + EMAIL);
    const dump = JSON.stringify(["persons", "otps", "sessions", "consents", "rate_events"].map((t) => getDb().prepare(`SELECT * FROM ${t}`).all())) + JSON.stringify(getStore("audit").prepare("SELECT * FROM audit_log").all());
    expect(dump).not.toContain(EMAIL);
    expect(dump).not.toContain("asha.rao");
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, err.mock.calls])).not.toContain("asha.rao");
    expect((await call("GET", "/me", undefined, v.json.token)).status).toBe(200);
    vi.restoreAllMocks();
  });

  it("@E2E-189 an email account can sign in with email and PIN, and a wrong PIN is refused", async () => {
    await signupEmail();
    expect((await call("POST", "/login/email", { email: EMAIL, pin: "9137" })).status).toBe(401);
    const ok = await call("POST", "/login/email", { email: "  Asha.Rao@Example.org ", pin: "4821" });
    expect(ok.status).toBe(200);
    expect(typeof ok.json.token).toBe("string");
    expect((await call("POST", "/login/email", { email: "nobody@example.org", pin: "4821" })).status).toBe(401);
  });

  it("@E2E-189 an email-only account is not survey-eligible, even after the waiting period", async () => {
    const a = await signupEmail();
    expect(a.person.survey_eligible).toBe(false);
    expect(isSurveyEligible(a.id, new Date(Date.now() + 40 * 86_400_000))).toBe(false);
  });

  it("@E2E-189 refuses weak PINs, bad addresses, throwaway domains and a second account on the same address", async () => {
    expect((await call("POST", "/signup/email/request", { email: "not-an-email" })).status).toBe(400);
    const throwaway = await call("POST", "/signup/email/request", { email: "x1@mailinator.com" });
    expect(throwaway.status).toBe(400);
    expect(throwaway.json.code).toBe("email_domain_blocked");
    const rq = await call("POST", "/signup/email/request", { email: "weak.pin@example.org" });
    const weak = await call("POST", "/signup/email/verify", { email: "weak.pin@example.org", otp: rq.json.dev_otp, pin: "1234" });
    expect(weak.status).toBe(400);
    expect(weak.json.code).toBe("weak_pin");
    await signupEmail();
    const again = await call("POST", "/signup/email/request", { email: EMAIL });
    expect(again.status).toBe(200); // the request answers the same whether or not the address has an account
    expect(again.json.dev_otp).toBeUndefined(); // but no usable code is handed out for an address that already has one
    expect((await call("POST", "/signup/email/verify", { email: EMAIL, otp: "000000", pin: "4821" })).status).toBe(400);
  });

  it("@E2E-189 folds Gmail dots and +tags so one mailbox cannot make many accounts", async () => {
    expect(normalizeEmail("A.B.C+news@Gmail.com")).toBe("abc@gmail.com");
    expect(normalizeEmail("abc@googlemail.com")).toBe("abc@gmail.com");
    expect(normalizeEmail("a..b@example.org")).toBeNull();
    expect(normalizeEmail("x@y")).toBeNull();
    await signupEmail("a.b.c@gmail.com");
    const rq = await call("POST", "/signup/email/request", { email: "abc+second@gmail.com" });
    expect(rq.status).toBe(200);
    expect(rq.json.dev_otp).toBeUndefined();
  });

  it("@E2E-189 a code is single-use and burns after 5 wrong tries", async () => {
    const rq = await call("POST", "/signup/email/request", { email: EMAIL });
    const code = rq.json.dev_otp as string;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await call("POST", "/signup/email/verify", { email: EMAIL, otp: wrong, pin: "4821" })).status).toBe(400);
    expect((await call("POST", "/signup/email/verify", { email: EMAIL, otp: code, pin: "4821" })).status).toBe(400); // burned
    const second = await call("POST", "/signup/email/request", { email: "fresh@example.org" });
    expect((await call("POST", "/signup/email/verify", { email: "fresh@example.org", otp: second.json.dev_otp, pin: "4821" })).status).toBe(201);
    expect((await call("POST", "/signup/email/verify", { email: "fresh@example.org", otp: second.json.dev_otp, pin: "4821" })).status).toBe(400);
  });

  it("@E2E-189 a failed mail send drops the code and says so; the PIN can be reset with an emailed code", async () => {
    setMailProvider({ name: "down", send: async () => { throw new Error("smtp down"); } });
    const f = await call("POST", "/signup/email/request", { email: EMAIL });
    expect(f.status).toBe(502);
    expect(f.json.can_retry).toBe(true);
    setMailProvider(null);
    await signupEmail();
    const rq = await call("POST", "/pin/recover/email/request", { email: EMAIL });
    expect(rq.status).toBe(200);
    expect((await call("POST", "/pin/recover/email", { email: EMAIL, otp: rq.json.dev_otp, new_pin: "7392" })).status).toBe(200);
    expect((await call("POST", "/login/email", { email: EMAIL, pin: "4821" })).status).toBe(401);
    expect((await call("POST", "/login/email", { email: EMAIL, pin: "7392" })).status).toBe(200);
  });

  it("@E2E-189 locks sign-in after repeated wrong PINs, and erasing the account removes the address", async () => {
    const a = await signupEmail();
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await call("POST", "/login/email", { email: EMAIL, pin: "9137" })).status;
    expect([423, 429]).toContain(last);
    const del = await call("DELETE", "/me", { pin: "4821" }, a.token);
    expect(del.status).toBe(200);
    const row = getDb().prepare("SELECT email_hash, email_enc FROM persons WHERE id = ?").get(a.id) as Record<string, string | null>;
    expect(row.email_hash).toBeNull();
    expect(row.email_enc).toBeNull();
  });
});

describe("adding a phone to an email-only account (S-167)", () => {
  const PHONE = "+919876543210";
  async function phoneCode(phone: string) { const r = await call("POST", "/signup/request", { phone }); expect(r.status).toBe(200); return r.json.dev_otp as string; }

  it("@E2E-193 a code to the phone upgrades the account: the phone is stored hashed, email_only goes, sign-in by phone works with the same PIN, and it is survey-eligible after the waiting period", async () => {
    const a = await signupEmail();
    const add = await call("POST", "/phone/add", { phone: PHONE, otp: await phoneCode(PHONE) }, a.token);
    expect(add.status).toBe(200);
    expect(add.json.person.flags).not.toContain("email_only");
    const row = getDb().prepare("SELECT phone_hash, phone_enc, email_hash FROM persons WHERE id = ?").get(a.id) as Record<string, string | null>;
    expect(row.phone_hash).toBe(getKeys().hmac("phone", PHONE));
    expect(getKeys().decrypt("phone", row.phone_enc as string)).toBe(PHONE);
    expect(row.email_hash).not.toBeNull(); // both ways to sign in now work
    expect((await call("POST", "/login", { phone: PHONE, pin: "4821" })).status).toBe(200);
    expect((await call("POST", "/login/email", { email: EMAIL, pin: "4821" })).status).toBe(200);
    expect(isSurveyEligible(a.id, new Date(Date.now() + 15 * 86_400_000))).toBe(true);
    expect(isSurveyEligible(a.id)).toBe(false); // still inside its own 14-day waiting period
  });

  it("@E2E-193 needs a valid code, a signed-in account and a number that passes the checks; only one phone per account", async () => {
    const a = await signupEmail();
    expect((await call("POST", "/phone/add", { phone: PHONE, otp: "123456" })).status).toBe(401);
    expect((await call("POST", "/phone/add", { phone: PHONE, otp: "000000" }, a.token)).status).toBe(400);
    expect((await call("POST", "/phone/add", { phone: "12345", otp: "000000" }, a.token)).status).toBe(400);
    const voip = "+919999900002"; // dev number-intelligence fixture: VoIP
    expect((await call("POST", "/signup/request", { phone: voip })).status).toBe(403); // a VoIP number never gets a code
    expect((await call("POST", "/phone/add", { phone: voip, otp: "123456" }, a.token)).status).toBe(400);
    expect((await call("POST", "/phone/add", { phone: PHONE, otp: await phoneCode(PHONE) }, a.token)).status).toBe(200);
    const second = await call("POST", "/phone/add", { phone: "+919876543299", otp: await phoneCode("+919876543299") }, a.token);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("phone_already_set");
  });

  it("@E2E-193 a recently re-issued number is flagged on the upgraded account and keeps it survey-ineligible", async () => {
    const a = await signupEmail();
    const reissued = "+919999900001"; // dev fixture: recycled number
    const add = await call("POST", "/phone/add", { phone: reissued, otp: await phoneCode(reissued) }, a.token);
    expect(add.status).toBe(200);
    expect(add.json.person.flags).toContain("recently_reissued");
    expect(isSurveyEligible(a.id, new Date(Date.now() + 40 * 86_400_000))).toBe(false);
  });

  it("@E2E-193 respects the cap of adults per number", async () => {
    process.env.CIVIC_MAX_ADULTS_PER_SIM = "1";
    try {
      const rq = await call("POST", "/signup/request", { phone: PHONE });
      expect((await call("POST", "/signup/verify", { phone: PHONE, otp: rq.json.dev_otp, pin: "4821" })).status).toBe(201);
      const a = await signupEmail();
      const add = await call("POST", "/phone/add", { phone: PHONE, otp: await phoneCode(PHONE) }, a.token);
      expect(add.status).toBe(409);
      expect(add.json.code).toBe("sim_full");
    } finally { delete process.env.CIVIC_MAX_ADULTS_PER_SIM; }
  });
});
