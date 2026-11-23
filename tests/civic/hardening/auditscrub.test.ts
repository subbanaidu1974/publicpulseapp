/** S-160 (@E2E-184): the "no phone numbers, PINs, OTPs or response contents in audit metadata" rule is enforced inside audit(), and a scan proves it. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import {
  SCRUBBED, audit, auditScrubCount, createSession, findAuditViolations, getDb, getStore, grantRole, migrate, resetAuditScrubCount, resetDbForTests, scrubAuditMeta, verifyAuditChain,
} from "../../../server/civic/core";
import { grantVolunteer } from "../../../server/civic/identity/routes";
import { caller, serveIdentity, signupVia } from "./helpers";

let server: Server, call: ReturnType<typeof caller>;
beforeAll(async () => { const s = await serveIdentity(); server = s.server; call = caller(s.base); });
afterAll(() => { server.close(); });
beforeEach(() => { process.env.CIVIC_EXPOSE_DEV_OTP = "1"; resetDbForTests(); migrate(); resetAuditScrubCount(); });
afterEach(() => { delete process.env.CIVIC_EXPOSE_DEV_OTP; });

const metas = () => (getStore("audit").prepare("SELECT seq, action, meta FROM audit_log ORDER BY seq").all() as { seq: number; action: string; meta: string }[]);

describe("audit metadata scrubber (S-160, T-31)", () => {
  it("@E2E-184 sensitive keys and phone-shaped values are replaced, whatever the nesting; ordinary values are untouched", () => {
    const out = scrubAuditMeta({
      pin: "4821", new_pin: "7391", oldPin: "1111", otp: "123456", phone: "+919876543210", answers: { q1: "a" }, token: "abc", password: "x",
      note: "call me on 9876543210 or +91 98765 43210 or 91-9876543210", nested: { deep: { msisdn: "x", list: ["+919876543210", "fine"] } },
      code: "123456", reason: "voip", count: 12, ms: 1700000000000, seqs: [1, 2, 3], hash: "ab1234567890cd", at: "2026-11-23T10:00:00.000Z", category: "water", village: "DEMO-V-KLR",
    });
    for (const k of ["pin", "new_pin", "oldPin", "otp", "phone", "answers", "token", "password", "code"]) expect(out[k], k).toBe(SCRUBBED);
    expect(String(out.note)).not.toMatch(/\d{10}/);
    expect(String(out.note)).not.toContain("98765");
    expect((out.nested as any).deep.msisdn).toBe(SCRUBBED);
    expect((out.nested as any).deep.list).toEqual([SCRUBBED, "fine"]);
    expect(out).toMatchObject({ reason: "voip", count: 12, ms: 1700000000000, seqs: [1, 2, 3], hash: "ab1234567890cd", at: "2026-11-23T10:00:00.000Z", category: "water", village: "DEMO-V-KLR" });
    expect(out._scrubbed).toBeGreaterThanOrEqual(11);
    expect(findAuditViolations(JSON.stringify(out))).toEqual([]);
  });

  it("@E2E-184 audit() applies the scrubber: the stored row and its hash chain never contain the value, the chain still verifies, the attempt is counted", () => {
    audit("someone", "test.leak", "obj", { phone: "+919876543210", pin: "4821", detail: "otp was 123456 for 9876543210", answers: { q: "secret answer" }, ok: true });
    const row = metas().find((m) => m.action === "test.leak")!;
    expect(row.meta).not.toContain("9876543210");
    expect(row.meta).not.toContain("4821");
    expect(row.meta).not.toContain("secret answer");
    expect(JSON.parse(row.meta)).toMatchObject({ phone: SCRUBBED, pin: SCRUBBED, answers: SCRUBBED, ok: true });
    expect(findAuditViolations(row.meta)).toEqual([]);
    expect(auditScrubCount()).toBeGreaterThanOrEqual(4);
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-184 the scanner itself flags an unscrubbed row (so a scrubber regression fails the flow scan below)", () => {
    expect(findAuditViolations(JSON.stringify({ phone: "+919876543210" }))).toEqual(["phone"]);
    expect(findAuditViolations(JSON.stringify({ x: { y: "call 9876543210" } }))).toEqual(["x.y"]);
    expect(findAuditViolations(JSON.stringify({ code: "123456" }))).toEqual(["code"]);
    expect(findAuditViolations("not json")).toEqual(["unparseable"]);
    expect(findAuditViolations(JSON.stringify({ pin: SCRUBBED }))).toEqual([]);
  });

  it("@E2E-184 representative flows (sign-up, login, recovery, PIN change, sessions, role grants, volunteer enrolment, erasure) leave no violation in the audit table", async () => {
    const PHONE = "+919876543210", PIN = "4821";
    const a = await signupVia(call, PHONE, PIN);
    expect((await call("POST", "/login", { phone: PHONE, pin: PIN })).status).toBe(200);
    for (let i = 0; i < 5; i++) await call("POST", "/login", { phone: PHONE, pin: "9753", person_id: a.id }); // wrong PINs -> lockout audit
    const rec = await call("POST", "/pin/recover/request", { phone: PHONE });
    expect((await call("POST", "/pin/recover", { phone: PHONE, otp: rec.json.dev_otp, new_pin: "7391", person_id: a.id })).status).toBe(200);
    const login = await call("POST", "/login", { phone: PHONE, pin: "7391" });
    const ch = await call("POST", "/pin/change", { old_pin: "7391", new_pin: "6203" }, login.json.token);
    expect(ch.status).toBe(200);
    await call("POST", "/residence", { residence: "Kolluru village, house 12" }, ch.json.token);
    // volunteer enrolment (texts a code and OTP to another number; none of it may reach the log)
    const vol = await signupVia(call, "+919876500011", "5827");
    grantVolunteer(vol.id, "org-1");
    const vtoken = createSession(vol.id);
    const enr = await call("POST", "/volunteer/enrol", { phone: "+919876500012", context: "household", label: "Lakshmi" }, vtoken);
    expect(enr.status).toBe(201);
    const b = await signupVia(call, "+919876500013", "9051");
    grantRole("system", b.id, "admin");
    expect((await call("DELETE", "/me", { pin: "9051" }, b.token)).status).toBe(200);
    // free-text style metadata, as a careless caller might write it
    audit(a.id, "careless.call", "x", { note: `user ${PHONE} did a thing`, pin: PIN, phone: PHONE });

    const rows = metas();
    expect(rows.length).toBeGreaterThan(15);
    const bad: string[] = [];
    for (const r of rows) {
      for (const p of findAuditViolations(r.meta)) bad.push(`${r.seq} ${r.action} ${p}`);
      for (const secret of ["9876543210", "9876500011", "9876500012", "9876500013", PIN, "7391", "6203", "5827", "9051"]) if (r.meta.includes(secret)) bad.push(`${r.seq} ${r.action} contains ${secret}`);
    }
    expect(bad).toEqual([]);
    expect(rows.find((r) => r.action === "careless.call")!.meta).toContain(SCRUBBED);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM persons").get()).toBeTruthy();
    expect(verifyAuditChain().ok).toBe(true);
  });
});
