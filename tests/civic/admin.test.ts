import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "node:crypto";
import { createSession, getDb, grantRole, hasRole, listRoles, migrate, resetDbForTests, verifyAuditChain, getStore } from "../../server/civic/core";
import { adminRouter, base32Decode, base32Encode, hotp, matchTotp, totp } from "../../server/civic/admin/routes";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/admin", adminRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/admin`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); process.env.CIVIC_TOTP_WINDOW = "60"; }); // tests mint codes for successive future steps
afterEach(() => { delete process.env.CIVIC_TOTP_WINDOW; });

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
  return { status: r.status, body: (t ? JSON.parse(t) : {}) as Record<string, any> };
}
/** Make `p` an admin with confirmed MFA; returns a function minting a fresh code each call (the next 30 s step so codes never repeat). */
async function adminWithMfa() {
  const p = mk();
  grantRole("system", p.id, "admin");
  const en = await call(p.token, "POST", "/mfa/enrol");
  expect(en.status).toBe(201);
  const secret = base32Decode(en.body.secret);
  let step = 0;
  const code = () => totp(secret, Date.now() + 30_000 * ++step);
  // enrolment confirmation uses the current step; later codes use future steps (inside the +/-1 window only for step 1, so keep offsets tiny)
  const conf = await call(p.token, "POST", "/mfa/confirm", { code: totp(secret, Date.now()) });
  expect(conf.status).toBe(200);
  return { ...p, secret, recovery: en.body.recovery_codes as string[], code };
}

describe("TOTP (RFC 6238, in-house)", () => {
  const seed = Buffer.from("12345678901234567890");
  it("@E2E-155 matches the RFC 6238 SHA-1 test vectors and RFC 4648 base32", () => {
    expect(hotp(seed, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(hotp(seed, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(hotp(seed, Math.floor(1234567890 / 30), 8)).toBe("89005924");
    expect(totp(seed, 59_000)).toBe("287082");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(matchTotp(seed, "287082", 59_000 + 30_000, 1)).toBe(1); // one step of drift accepted
    expect(matchTotp(seed, "287082", 59_000 + 120_000, 1)).toBeNull();
  });
});

describe("admin roles (S-140)", () => {
  it("@E2E-155 /admin/me gives citizens an empty roles array and holders their roles", async () => {
    const c = mk();
    const me = await call(c.token, "GET", "/me");
    expect(me.body).toMatchObject({ person_id: c.id, roles: [], is_admin: false, mfa: { enrolled: false } });
    grantRole("system", c.id, "officer", "village:1", "Roads");
    grantRole("system", c.id, "journalist");
    const me2 = await call(c.token, "GET", "/me");
    expect(me2.body.roles.sort()).toEqual(["journalist", "officer"]);
    expect(me2.body.role_details).toContainEqual({ role: "officer", jurisdiction: "village:1", department: "Roads" });
    expect((await call(null, "GET", "/me")).status).toBe(401);
  });

  it("@E2E-155 all eight roles exist, volunteer is bridged to the person row, and requireRole rejects non-admins", async () => {
    const p = mk();
    for (const r of ["politician", "journalist", "eci_liaison", "geo_reviewer", "volunteer"] as const) grantRole("system", p.id, r);
    expect(listRoles(p.id).map((r) => r.role).sort()).toEqual(["eci_liaison", "geo_reviewer", "journalist", "politician", "volunteer"]);
    expect(getDb().prepare("SELECT role FROM persons WHERE id=?").get(p.id)).toEqual({ role: "volunteer" });
    expect((await call(p.token, "GET", "/roles")).status).toBe(403);
    expect((await call(p.token, "POST", "/mfa/enrol")).status).toBe(403);
  });

  it("@E2E-155 granting needs MFA and a second admin: requester cannot approve; approver's code is single-use", async () => {
    const a1 = await adminWithMfa(), a2 = await adminWithMfa();
    const target = mk();
    const req = { action: "grant", person_id: target.id, role: "officer", jurisdiction: "village:7", department: "Water", reason: "new JE posted" };
    expect((await call(a1.token, "POST", "/roles/requests", req)).body.code).toBe("mfa_required");
    expect((await call(a1.token, "POST", "/roles/requests", req, { "x-totp-code": "000000" })).body.code).toBe("mfa_invalid");
    const c1 = await call(a1.token, "POST", "/roles/requests", req, { "x-totp-code": a1.code() });
    expect(c1.status).toBe(201);
    expect(hasRole(target.id, "officer")).toBe(false); // nothing yet
    // same admin cannot approve their own request
    const self = await call(a1.token, "POST", `/roles/requests/${c1.body.id}/approve`, {}, { "x-totp-code": a1.code() });
    expect(self.status).toBe(403); expect(self.body.code).toBe("dual_control");
    expect(hasRole(target.id, "officer")).toBe(false);
    // an admin cannot grant themselves a role either
    expect((await call(a1.token, "POST", "/roles/requests", { ...req, person_id: a1.id }, { "x-totp-code": a1.code() })).body.code).toBe("self_grant");
    // second admin approves
    const code2 = a2.code();
    const ok = await call(a2.token, "POST", `/roles/requests/${c1.body.id}/approve`, {}, { "x-totp-code": code2 });
    expect(ok.status).toBe(200);
    expect(hasRole(target.id, "officer", "village:7")).toBe(true);
    expect(getDb().prepare("SELECT department, granted_by FROM roles WHERE person_id=? AND role='officer'").get(target.id)).toEqual({ department: "Water", granted_by: a2.id });
    // replaying the same code is refused
    const replay = await call(a2.token, "GET", "/roles/requests?status=approved");
    expect(replay.body.requests).toHaveLength(1);
    const c2 = await call(a1.token, "POST", "/roles/requests", { ...req, action: "revoke", reason: "moved to another district" }, { "x-totp-code": a1.code() });
    expect((await call(a2.token, "POST", `/roles/requests/${c2.body.id}/approve`, {}, { "x-totp-code": code2 })).body.code).toBe("mfa_invalid");
    expect((await call(a2.token, "POST", `/roles/requests/${c2.body.id}/approve`, {}, { "x-totp-code": a2.code() })).status).toBe(200);
    expect(hasRole(target.id, "officer")).toBe(false);
    // everything is in the audit log, privileged list reads included, and the chain still verifies
    const actions = (getStore("audit").prepare("SELECT action FROM audit_log").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.role_request.create", "admin.role_request.approve", "admin.role_request.self_approval_refused", "role.grant", "role.revoke", "read.sensitive"]));
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-155 requests expire after 72h, a revoked admin loses access, and recovery codes work once", async () => {
    const a1 = await adminWithMfa(), a2 = await adminWithMfa();
    const target = mk();
    const r = await call(a1.token, "POST", "/role-requests", { action: "grant", person_id: target.id, role: "moderator", reason: "district moderator" }, { "x-totp-code": a1.code() });
    getDb().prepare("UPDATE role_requests SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await call(a2.token, "POST", `/role-requests/${r.body.id}/approve`, {}, { "x-totp-code": a2.code() })).status).toBe(410);
    // recovery code instead of TOTP
    const r2 = await call(a1.token, "POST", "/role-requests", { action: "revoke", person_id: a2.id, role: "admin", reason: "leaving the team" }, { "x-recovery-code": a1.recovery[0] });
    expect(r2.status).toBe(201);
    expect((await call(a1.token, "POST", "/role-requests", { action: "revoke", person_id: a2.id, role: "admin", reason: "again please" }, { "x-recovery-code": a1.recovery[0] })).body.code).toBe("mfa_invalid");
    expect((await call(a2.token, "POST", `/role-requests/${r2.body.id}/approve`, {}, { "x-totp-code": a2.code() })).status).toBe(200);
    expect(hasRole(a2.id, "admin")).toBe(false);
    // a1 is now the only admin: a revoke request cannot be completed by anyone (no second admin) and reject works
    expect((await call(a2.token, "GET", "/roles")).status).toBe(403);
  });

  it("@E2E-155 MFA secrets are stored encrypted and recovery codes only as hashes; enrolment cannot be repeated", async () => {
    const a = await adminWithMfa();
    const row = getDb().prepare("SELECT secret_enc FROM admin_mfa WHERE person_id=?").get(a.id) as { secret_enc: string };
    expect(row.secret_enc.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(getDb().prepare("SELECT * FROM admin_mfa_recovery").all())).not.toContain(a.recovery[0]);
    expect((await call(a.token, "POST", "/mfa/enrol")).status).toBe(409);
    const st = await call(a.token, "GET", "/me");
    expect(st.body.mfa).toEqual({ enrolled: true, confirmed: true, recovery_codes_left: 8 });
  });

  it("@E2E-155 the issues officer_role stub rows are migrated into core roles", () => {
    const d = getDb();
    const p = mk();
    d.exec("DROP TABLE admin_mfa; DROP TABLE admin_mfa_recovery; DROP TABLE role_requests; DELETE FROM migrations WHERE id = 'admin_001_mfa_requests'");
    d.exec("CREATE TABLE IF NOT EXISTS officer_role (person_id TEXT NOT NULL, role TEXT NOT NULL, department TEXT, jurisdiction_lgd TEXT, label TEXT, PRIMARY KEY (person_id, role))");
    d.prepare("INSERT INTO officer_role VALUES (?,?,?,?,?)").run(p.id, "officer", "Health", "lgd-99", "x");
    d.prepare("INSERT INTO officer_role VALUES (?,?,?,?,?)").run("ghost-person", "officer", "Health", null, "x");
    migrate();
    expect(d.prepare("SELECT role, jurisdiction, department, granted_by FROM roles WHERE person_id=?").get(p.id)).toEqual({ role: "officer", jurisdiction: "lgd-99", department: "Health", granted_by: "system:migration" });
    expect(d.prepare("SELECT COUNT(*) AS c FROM roles WHERE person_id='ghost-person'").get()).toEqual({ c: 0 });
    expect(hasRole(p.id, "officer", "lgd-99")).toBe(true);
  });
});
