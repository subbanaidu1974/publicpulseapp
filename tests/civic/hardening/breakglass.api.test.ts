/** S-163 (@E2E-187): the break-glass dual-control flow exposed through the admin API, audited, and counted (only counted) in the public audit summary. */
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, getDb, getStore, grantRole, migrate, resetDbForTests, setKeyProvider, verifyAuditChain } from "../../../server/civic/core";
import { adminRouter, auditRouter, base32Decode, totp } from "../../../server/civic/admin/routes";
import { setBreakGlass } from "../../../server/civic/admin/breakglass";
import { BreakGlass } from "../../../server/civic/providers/breakglass";
import { EnvelopeKeyProvider, type KmsBackend } from "../../../server/civic/providers/keys";
import { setProviderLogger } from "../../../server/civic/providers/util";

class LocalKms implements KmsBackend {
  readonly name = "local"; keks = new Map<string, Buffer>();
  private k(id: string) { let k = this.keks.get(id); if (!k) { k = crypto.randomBytes(32); this.keks.set(id, k); } return k; }
  async wrap(id: string, pt: Buffer, aad: string) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.k(id), iv); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(pt), c.final()]); return id + "|" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); }
  async unwrap(w: string, aad: string) { const [id, b] = w.split("|"), r = Buffer.from(b, "base64"), d = crypto.createDecipheriv("aes-256-gcm", this.k(id), r.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]); }
}

let server: Server, base = "", abase = "", kp: EnvelopeKeyProvider, kms: LocalKms, clock = 0;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/admin", adminRouter);
  app.use("/api/v1/civic/audit", auditRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const o = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic`;
  base = o + "/admin"; abase = o + "/audit";
});
afterAll(() => { server.close(); });
beforeEach(async () => {
  resetDbForTests(); migrate(); setProviderLogger(() => undefined);
  process.env.CIVIC_TOTP_WINDOW = "60";
  kms = new LocalKms();
  kp = new EnvelopeKeyProvider(kms, { kekId: "kek-main" });
  await kp.warm();
  setKeyProvider(kp);
  clock = Date.now();
  setBreakGlass(new BreakGlass({ access: kp.breakGlassAccess(), recoveryKekId: "kek-recovery", now: () => clock }));
});
afterEach(() => { setBreakGlass(null); kp.destroy(); setKeyProvider(null); setProviderLogger(null); resetDbForTests(); delete process.env.CIVIC_TOTP_WINDOW; });

function mk(): { id: string; token: string } {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?,?,?)").run(id, now, now);
  return { id, token: createSession(id) };
}
async function call(token: string | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}, root = base) {
  const r = await fetch(root + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: (t ? JSON.parse(t) : {}) as Record<string, any>, text: t };
}
async function adminWithMfa() {
  const p = mk();
  grantRole("system", p.id, "admin");
  const en = await call(p.token, "POST", "/mfa/enrol");
  const secret = base32Decode(en.body.secret);
  let step = 0;
  const code = () => String(totp(secret, Date.now() + 30_000 * ++step));
  expect((await call(p.token, "POST", "/mfa/confirm", { code: String(totp(secret, Date.now())) })).status).toBe(200);
  return { ...p, code, h: () => ({ "x-totp-code": code() }) };
}
const actions = () => (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'keys.breakglass.%' ORDER BY seq").all() as { action: string }[]).map((r) => r.action);
const summary = async () => (await call(null, "GET", "/summary", undefined, {}, abase)).body;

describe("break-glass through the admin API (S-163)", () => {
  it("@E2E-187 request, two OTHER admins approve with TOTP, one single use within 15 minutes; every step is audited and the public summary only counts", async () => {
    const [a, b, c] = [await adminWithMfa(), await adminWithMfa(), await adminWithMfa()];
    const req = await call(a.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "disaster recovery drill for the phone key" }, a.h());
    expect(req.status, req.text).toBe(201);
    expect(req.body).toMatchObject({ purpose: "phone", version: 1, status: "pending", approvals: 0, requested_by: a.id });
    const id = req.body.id as string;

    // the requester cannot approve (dual control), the refusal is audited
    const self = await call(a.token, "POST", `/breakglass/requests/${id}/approve`, {}, a.h());
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("dual_control");
    // not usable before two approvals
    expect((await call(b.token, "POST", `/breakglass/requests/${id}/export`, {}, b.h())).status).toBe(409);
    expect((await call(b.token, "POST", `/breakglass/requests/${id}/approve`, {}, b.h())).body).toMatchObject({ ok: true, approvals: 1, ready: false });
    expect((await call(b.token, "POST", `/breakglass/requests/${id}/approve`, {}, b.h())).status).toBe(409); // nobody approves twice
    expect((await call(c.token, "POST", `/breakglass/requests/${id}/approve`, {}, c.h())).body).toMatchObject({ ok: true, approvals: 2, ready: true });

    // one use: the key comes out wrapped under the recovery KEK, never in the clear, never in the audit log or the summary
    const out = await call(c.token, "POST", `/breakglass/requests/${id}/export`, {}, c.h());
    expect(out.status, out.text).toBe(200);
    expect(out.body.bundle.startsWith("kek-recovery|")).toBe(true);
    const clear = await kms.unwrap(out.body.bundle, "civic-key:phone:1:recovery");
    expect(clear.length).toBe(32);
    const again = await call(c.token, "POST", `/breakglass/requests/${id}/export`, {}, c.h());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_used");

    expect(actions()).toEqual(["keys.breakglass.request", "keys.breakglass.self_approval_refused", "keys.breakglass.approve", "keys.breakglass.approve", "keys.breakglass.export"]);
    const bundleB64 = out.body.bundle.split("|")[1] as string;
    const allAudit = JSON.stringify(getStore("audit").prepare("SELECT actor, object, meta FROM audit_log").all());
    expect(allAudit).not.toContain(bundleB64);
    expect(allAudit).not.toContain(clear.toString("hex"));
    expect(allAudit).not.toContain(clear.toString("base64"));

    const s = await summary();
    expect(s.break_glass).toEqual({ requests: 1, approvals: 2, denials: 0, uses: 1, self_approval_refusals: 1 });
    expect(s.total).toBeGreaterThan(5);
    expect(JSON.stringify(s)).not.toContain(bundleB64);
    expect(JSON.stringify(s)).not.toContain(a.id); // counts only: no actor ids
    expect(verifyAuditChain().ok).toBe(true);

    const listed = await call(a.token, "GET", "/breakglass/requests");
    expect(listed.body.requests[0]).toMatchObject({ id, status: "used", approvals: 2 });
    expect(JSON.stringify(listed.body)).not.toContain(bundleB64);
  });

  it("@E2E-187 a request needs an admin, MFA, a known key purpose and a written reason", async () => {
    const a = await adminWithMfa();
    const plain = mk();
    expect((await call(plain.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "disaster recovery drill" })).status).toBe(403);
    expect((await call(a.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "disaster recovery drill" })).body.code).toBe("mfa_required");
    expect((await call(a.token, "POST", "/breakglass/requests", { purpose: "nonsense", reason: "disaster recovery drill" }, a.h())).body.code).toBe("unknown_purpose");
    expect((await call(a.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "short" }, a.h())).body.code).toBe("reason_required");
    expect((await call(null, "GET", "/breakglass/requests")).status).toBe(401);
    expect((await call(plain.token, "GET", "/breakglass/requests")).status).toBe(403);
  });

  it("@E2E-187 the grant expires after 15 minutes: neither approval nor use is possible afterwards", async () => {
    const [a, b, c] = [await adminWithMfa(), await adminWithMfa(), await adminWithMfa()];
    const r1 = await call(a.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "expiry check, never approved" }, a.h());
    clock += 15 * 60_000 + 1000;
    const late = await call(b.token, "POST", `/breakglass/requests/${r1.body.id}/approve`, {}, b.h());
    expect(late.status).toBe(410);
    expect(late.body.code).toBe("request_expired");
    const r2 = await call(a.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "approved then left unused" }, a.h());
    await call(b.token, "POST", `/breakglass/requests/${r2.body.id}/approve`, {}, b.h());
    await call(c.token, "POST", `/breakglass/requests/${r2.body.id}/approve`, {}, c.h());
    clock += 15 * 60_000 + 1000;
    const use = await call(c.token, "POST", `/breakglass/requests/${r2.body.id}/export`, {}, c.h());
    expect(use.status).toBe(410);
    expect(use.body.code).toBe("request_expired");
    expect(actions()).not.toContain("keys.breakglass.export");
    expect((await summary()).break_glass.uses).toBe(0);
  });

  it("@E2E-187 deny ends a request; a missing or wrong TOTP code stops every state-changing step", async () => {
    const [a, b] = [await adminWithMfa(), await adminWithMfa()];
    const r = await call(a.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "deny and MFA check" }, a.h());
    expect((await call(b.token, "POST", `/breakglass/requests/${r.body.id}/approve`, {})).body.code).toBe("mfa_required");
    expect((await call(b.token, "POST", `/breakglass/requests/${r.body.id}/approve`, {}, { "x-totp-code": "000000" })).body.code).toBe("mfa_invalid");
    expect((await call(b.token, "POST", `/breakglass/requests/${r.body.id}/deny`, {}, b.h())).body).toMatchObject({ ok: true, status: "denied" });
    expect((await call(b.token, "POST", `/breakglass/requests/${r.body.id}/approve`, {}, b.h())).status).toBe(409);
    expect((await summary()).break_glass).toMatchObject({ requests: 1, approvals: 0, denials: 1, uses: 0 });
    expect((await call(b.token, "POST", `/breakglass/requests/nope/approve`, {}, b.h())).status).toBe(404);
  });

  it("@E2E-187 without an envelope key provider (the dev provider) the API answers 501 instead of pretending", async () => {
    const a = await adminWithMfa();
    setBreakGlass(null);
    kp.destroy(); setKeyProvider(null); // back to the dev provider, which has no break-glass capability
    resetDbForTests(); migrate();
    const b = await adminWithMfa();
    const r = await call(b.token, "POST", "/breakglass/requests", { purpose: "phone", reason: "dev provider has none" }, b.h());
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("break_glass_unavailable");
    expect(a.id).toBeTruthy();
  });
});
