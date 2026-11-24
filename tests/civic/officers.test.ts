import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "node:crypto";

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "officer-letters-"));
process.env.CIVIC_MEDIA_DIR = mediaDir;

import { createSession, getDb, getStore, grantRole, hasRole, listRolesDetailed, migrate, resetDbForTests, verifyAuditChain } from "../../server/civic/core";
import { adminRouter, base32Decode, totp } from "../../server/civic/admin/routes";
import { officersRouter, checkOfficialEmail, officerDomains } from "../../server/civic/officers";
import { createIssuesRouter } from "../../server/civic/issues/routes";
import { roleOf } from "../../server/civic/issues/service";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/admin", adminRouter);
  app.use("/api/v1/civic/officers", officersRouter);
  app.use("/api/v1/civic/issues", createIssuesRouter());
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic`;
});
afterAll(() => { server.close(); fs.rmSync(mediaDir, { recursive: true, force: true }); });
beforeEach(() => { resetDbForTests(); migrate(); process.env.CIVIC_TOTP_WINDOW = "60"; });
afterEach(() => { delete process.env.CIVIC_TOTP_WINDOW; delete process.env.CIVIC_OFFICER_DOMAINS; delete process.env.CIVIC_OFFICER_APPLY_PER_30D; });

const crc = Buffer.alloc(4);
const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type, "latin1"), data, crc]); };
const letterPng = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", Buffer.alloc(20, 7)), chunk("IEND", Buffer.alloc(0))]);

function mk(): { id: string; token: string } {
  const id = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?,?,?)").run(id, now, now);
  return { id, token: createSession(id) };
}
async function call(token: string | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let json: Record<string, any> = {};
  try { json = t ? JSON.parse(t) : {}; } catch { /* binary */ }
  return { status: r.status, body: json, headers: r.headers, text: t };
}
async function adminWithMfa() {
  const p = mk();
  grantRole("system", p.id, "admin");
  const en = await call(p.token, "POST", "/admin/mfa/enrol");
  const secret = base32Decode(en.body.secret);
  let step = 0;
  const code = () => totp(secret, Date.now() + 30_000 * ++step);
  expect((await call(p.token, "POST", "/admin/mfa/confirm", { code: totp(secret, Date.now()) })).status).toBe(200);
  return { ...p, code, mfa: () => ({ "x-totp-code": code() }) };
}
async function uploadLetter(token: string): Promise<string> {
  const r = await fetch(base + "/issues/media", { method: "POST", headers: { "content-type": "image/png", authorization: "Bearer " + token }, body: letterPng() });
  expect(r.status).toBe(201);
  return ((await r.json()) as { ref: string }).ref;
}
const application = (letter_ref: string, over: Record<string, unknown> = {}) => ({
  full_name: "A. Sample Officer", department: "Rural Water Supply", designation: "Assistant Engineer", official_email: "a.officer@ap.gov.in", jurisdiction: "", letter_ref, ...over,
});

describe("official e-mail domain check (S-141, automated)", () => {
  it("accepts the allow-list and its subdomains, refuses look-alikes, other TLDs, non-ASCII and malformed addresses", () => {
    expect(officerDomains().length).toBeGreaterThan(0);
    expect(checkOfficialEmail("Name@AP.gov.in")).toMatchObject({ ok: true, email: "name@ap.gov.in", matched: "gov.in" });
    expect(checkOfficialEmail("x@dept.nic.in")).toMatchObject({ ok: true, matched: "nic.in" });
    for (const bad of ["x@evilgov.in", "x@gov.in.example.com", "x@gov.in.", "x@gmail.com", "x@gov.com", "x@gov.in@evil.com", "x@gоv.in", "x@@gov.in", "no-at-sign", "", "x y@gov.in"]) {
      expect(checkOfficialEmail(bad).ok, bad).toBe(false);
    }
    process.env.CIVIC_OFFICER_DOMAINS = "only.example.org";
    expect(checkOfficialEmail("a@gov.in").ok).toBe(false);
    expect(checkOfficialEmail("a@x.only.example.org").ok).toBe(true);
  });

  it("GET /officers/domains is public and lists the registry and the departments", async () => {
    const r = await call(null, "GET", "/officers/domains");
    expect(r.status).toBe(200);
    expect(r.body.domains.map((d: { domain: string }) => d.domain)).toContain("gov.in");
    expect(r.body.departments).toContain("Rural Water Supply");
  });
});

describe("applying (S-141)", () => {
  it("needs a signed-in person; refuses an off-list domain without storing anything and audits the refusal", async () => {
    expect((await call(null, "POST", "/officers/applications", {})).status).toBe(401);
    const p = mk();
    const ref = await uploadLetter(p.token);
    const bad = await call(p.token, "POST", "/officers/applications", application(ref, { official_email: "someone@gmail.com" }));
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("domain_not_allowed");
    expect(getDb().prepare("SELECT COUNT(*) c FROM officer_application").get()).toEqual({ c: 0 });
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'officer.application.domain_refused'").get()).toEqual({ c: 1 });
  });

  it("validates department, letter and jurisdiction format; the letter must be the applicant's own upload", async () => {
    const p = mk(), other = mk();
    const ref = await uploadLetter(p.token);
    expect((await call(p.token, "POST", "/officers/applications", application(ref, { department: "Made Up" }))).body.code).toBe("unknown_department");
    expect((await call(p.token, "POST", "/officers/applications", application(ref, { full_name: "x" }))).body.code).toBe("name_required");
    expect((await call(p.token, "POST", "/officers/applications", application(ref, { jurisdiction: "bad code!" }))).body.code).toBe("jurisdiction_format");
    expect((await call(p.token, "POST", "/officers/applications", application("media:" + "0".repeat(32)))).body.code).toBe("letter_required");
    expect((await call(other.token, "POST", "/officers/applications", application(ref))).body.code).toBe("letter_required"); // not their upload
  });

  it("stores name and e-mail encrypted, shows the applicant their own status, allows one open application and a withdrawal", async () => {
    const p = mk();
    const ref = await uploadLetter(p.token);
    const ok = await call(p.token, "POST", "/officers/applications", application(ref, { jurisdiction: "" }));
    expect(ok.status).toBe(201);
    const raw = JSON.stringify(getDb().prepare("SELECT * FROM officer_application").all());
    expect(raw).not.toContain("a.officer@ap.gov.in");
    expect(raw).not.toContain("Sample Officer");
    const mine = await call(p.token, "GET", "/officers/applications/mine");
    expect(mine.body.applications[0]).toMatchObject({ id: ok.body.id, status: "submitted", department: "Rural Water Supply", email_domain: "ap.gov.in", domain_check: "pass", letter_checked: false, can_withdraw: true });
    expect(JSON.stringify(mine.body)).not.toContain("a.officer");
    const ref2 = await uploadLetter(p.token);
    expect((await call(p.token, "POST", "/officers/applications", application(ref2))).body.code).toBe("application_open");
    expect((await call(p.token, "POST", `/officers/applications/${ok.body.id}/withdraw`, {})).body.status).toBe("withdrawn");
    expect((await call(mk().token, "POST", `/officers/applications/${ok.body.id}/withdraw`, {})).status).toBe(404);
  });

  it("is rate limited per person", async () => {
    process.env.CIVIC_OFFICER_APPLY_PER_30D = "2";
    const p = mk();
    const r1 = await call(p.token, "POST", "/officers/applications", application(await uploadLetter(p.token)));
    await call(p.token, "POST", `/officers/applications/${r1.body.id}/withdraw`, {});
    const r2 = await call(p.token, "POST", "/officers/applications", application(await uploadLetter(p.token)));
    expect(r2.status).toBe(201);
    await call(p.token, "POST", `/officers/applications/${r2.body.id}/withdraw`, {});
    const r3 = await call(p.token, "POST", "/officers/applications", application(await uploadLetter(p.token)));
    expect(r3.status).toBe(429);
    expect(r3.body.code).toBe("rate_limited");
  });
});

describe("verification queue with dual control (S-141, human letter check)", () => {
  async function submitted() {
    const applicant = mk();
    const ref = await uploadLetter(applicant.token);
    const r = await call(applicant.token, "POST", "/officers/applications", application(ref, { jurisdiction: "DEMO-M-KLP" }));
    expect(r.status).toBe(201);
    return { applicant, id: r.body.id as string };
  }

  it("is admin only; verification needs MFA and an explicit letter check; letter views are audited and never cached", async () => {
    const { applicant, id } = await submitted();
    const a1 = await adminWithMfa();
    expect((await call(applicant.token, "GET", "/officers/admin/queue")).status).toBe(403);
    const q = await call(a1.token, "GET", "/officers/admin/queue");
    expect(q.body.applications).toHaveLength(1);
    expect(q.body.applications[0]).toMatchObject({ id, full_name: "A. Sample Officer", official_email: "a.officer@ap.gov.in", department: "Rural Water Supply" });
    const noMfa = await call(a1.token, "POST", `/officers/admin/applications/${id}/verify`, { letter_checked: true });
    expect(noMfa.body.code).toBe("mfa_required");
    const noCheck = await call(a1.token, "POST", `/officers/admin/applications/${id}/verify`, {}, a1.mfa());
    expect(noCheck.body.code).toBe("letter_check_required");
    const letter = await call(a1.token, "GET", `/officers/admin/applications/${id}/letter`);
    expect(letter.status).toBe(200);
    expect(letter.headers.get("content-type")).toBe("image/png");
    expect(letter.headers.get("cache-control")).toBe("no-store");
    expect((await call(applicant.token, "GET", `/officers/admin/applications/${id}/letter`)).status).toBe(403);
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'read.sensitive'").get()).toMatchObject({ c: 2 }); // queue read and letter view
  });

  it("first admin verifies, a DIFFERENT admin approves through the role request, and only then the scoped officer role exists", async () => {
    const { applicant, id } = await submitted();
    const a1 = await adminWithMfa(), a2 = await adminWithMfa();
    const v = await call(a1.token, "POST", `/officers/admin/applications/${id}/verify`, { letter_checked: true, note: "letter matches the posting order" }, a1.mfa());
    expect(v.status).toBe(201);
    expect(v.body.status).toBe("awaiting_second_admin");
    expect(hasRole(applicant.id, "officer")).toBe(false);
    expect((await call(applicant.token, "GET", "/officers/applications/mine")).body.applications[0].status).toBe("awaiting_second_admin");
    // the verifying admin cannot approve their own request
    const self = await call(a1.token, "POST", `/admin/roles/requests/${v.body.role_request_id}/approve`, {}, a1.mfa());
    expect(self.body.code).toBe("dual_control");
    expect(hasRole(applicant.id, "officer")).toBe(false);
    // a withdrawn application cannot be taken back after verification
    expect((await call(applicant.token, "POST", `/officers/applications/${id}/withdraw`, {})).body.code).toBe("not_withdrawable");
    const ok = await call(a2.token, "POST", `/admin/roles/requests/${v.body.role_request_id}/approve`, {}, a2.mfa());
    expect(ok.status).toBe(200);
    expect(hasRole(applicant.id, "officer", "DEMO-M-KLP")).toBe(true);
    expect(listRolesDetailed(applicant.id).find((r) => r.role === "officer")).toMatchObject({ jurisdiction: "DEMO-M-KLP", department: "Rural Water Supply" });
    expect(roleOf(applicant.id, "officer")).toMatchObject({ department: "Rural Water Supply", jurisdiction_lgd: "DEMO-M-KLP" }); // the issue workflow honours the department
    const mine = await call(applicant.token, "GET", "/officers/applications/mine");
    expect(mine.body.applications[0]).toMatchObject({ status: "approved", letter_checked: true });
    const acts = (getStore("audit").prepare("SELECT action FROM audit_log").all() as { action: string }[]).map((r) => r.action);
    for (const a of ["officer.application.submit", "officer.application.verify", "admin.role_request.create", "admin.role_request.approve", "role.grant", "officer.application.approved"]) expect(acts, a).toContain(a);
    expect(verifyAuditChain().ok).toBe(true);
    // approved applications leave the open queue
    expect((await call(a1.token, "GET", "/officers/admin/queue")).body.applications).toHaveLength(0);
    expect((await call(a1.token, "GET", "/officers/admin/queue?status=approved")).body.applications).toHaveLength(1);
  });

  it("an admin cannot review or approve their own application", async () => {
    const a1 = await adminWithMfa(), a2 = await adminWithMfa();
    const ref = await uploadLetter(a1.token);
    const sub = await call(a1.token, "POST", "/officers/applications", application(ref));
    expect(sub.status).toBe(201);
    const own = await call(a1.token, "POST", `/officers/admin/applications/${sub.body.id}/verify`, { letter_checked: true }, a1.mfa());
    expect(own.status).toBe(403);
    expect(own.body.code).toBe("self_grant");
    // a second admin files it, then the applicant (an admin) must not be able to approve it
    const v = await call(a2.token, "POST", `/officers/admin/applications/${sub.body.id}/verify`, { letter_checked: true }, a2.mfa());
    expect(v.status).toBe(201);
    const selfApprove = await call(a1.token, "POST", `/admin/roles/requests/${v.body.role_request_id}/approve`, {}, a1.mfa());
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.code).toBe("self_grant");
    expect(hasRole(a1.id, "officer")).toBe(false);
  });

  it("a rejection needs a reason, ends the application, and the second admin's rejection of the request is reflected", async () => {
    const one = await submitted();
    const two = await submitted();
    const a1 = await adminWithMfa(), a2 = await adminWithMfa();
    expect((await call(a1.token, "POST", `/officers/admin/applications/${one.id}/reject`, { note: "" }, a1.mfa())).body.code).toBe("note_required");
    const rej = await call(a1.token, "POST", `/officers/admin/applications/${one.id}/reject`, { note: "letter does not match the post" }, a1.mfa());
    expect(rej.body.status).toBe("rejected");
    expect((await call(one.applicant.token, "GET", "/officers/applications/mine")).body.applications[0].status).toBe("rejected");
    expect(hasRole(one.applicant.id, "officer")).toBe(false);
    // second path: verified, then the second admin rejects the dual-control request
    const v = await call(a1.token, "POST", `/officers/admin/applications/${two.id}/verify`, { letter_checked: true }, a1.mfa());
    expect((await call(a2.token, "POST", `/admin/roles/requests/${v.body.role_request_id}/reject`, {}, a2.mfa())).status).toBe(200);
    expect((await call(two.applicant.token, "GET", "/officers/applications/mine")).body.applications[0].status).toBe("rejected");
    expect(hasRole(two.applicant.id, "officer")).toBe(false);
  });

  it("a request that expires leaves the application expired, and the person can apply again", async () => {
    const { applicant, id } = await submitted();
    const a1 = await adminWithMfa();
    const v = await call(a1.token, "POST", `/officers/admin/applications/${id}/verify`, { letter_checked: true }, a1.mfa());
    getDb().prepare("UPDATE role_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), v.body.role_request_id);
    expect((await call(applicant.token, "GET", "/officers/applications/mine")).body.applications[0].status).toBe("expired");
    const again = await call(applicant.token, "POST", "/officers/applications", application(await uploadLetter(applicant.token)));
    expect(again.status).toBe(201);
  });

  it("erasing the account removes the application", async () => {
    const { applicant } = await submitted();
    const { runErasureHooks } = await import("../../server/civic/core");
    runErasureHooks(applicant.id);
    expect(getDb().prepare("SELECT COUNT(*) c FROM officer_application").get()).toEqual({ c: 0 });
  });
});
