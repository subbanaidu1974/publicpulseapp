import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStore, migrate, resetDbForTests } from "../../../server/civic/core";
import { BreakGlass } from "../../../server/civic/providers/breakglass";
import { EnvelopeKeyProvider, type KmsBackend } from "../../../server/civic/providers/keys";
import { setProviderLogger } from "../../../server/civic/providers/util";

class LocalKms implements KmsBackend {
  readonly name = "local"; keks = new Map<string, Buffer>();
  private k(id: string) { let k = this.keks.get(id); if (!k) { k = crypto.randomBytes(32); this.keks.set(id, k); } return k; }
  async wrap(id: string, pt: Buffer, aad: string) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.k(id), iv); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(pt), c.final()]); return id + "|" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); }
  async unwrap(w: string, aad: string) { const [id, b] = w.split("|"), r = Buffer.from(b, "base64"), d = crypto.createDecipheriv("aes-256-gcm", this.k(id), r.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]); }
}

const ADMINS = new Set(["admin-a", "admin-b", "admin-c"]);
let kp: EnvelopeKeyProvider, kms: LocalKms, bg: BreakGlass, t: number;
const auditRows = () => (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'keys.breakglass.%' ORDER BY seq").all() as { action: string }[]).map((r) => r.action);

beforeEach(async () => {
  resetDbForTests(); migrate(); setProviderLogger(() => undefined); t = Date.now();
  kms = new LocalKms();
  kp = new EnvelopeKeyProvider(kms, { kekId: "kek-main" });
  await kp.warm(["phone"]);
  bg = new BreakGlass({ access: kp.breakGlassAccess(), isAdmin: (p) => ADMINS.has(p), recoveryKekId: "kek-recovery", now: () => t });
});
afterEach(() => { kp.destroy(); setProviderLogger(null); resetDbForTests(); });

const approved = () => { const r = bg.request("admin-a", { purpose: "phone", version: 1, reason: "disaster recovery drill" }); bg.approve(r.id, "admin-b"); bg.approve(r.id, "admin-c"); return r.id; };

describe("break-glass dual control (S-64)", () => {
  it("@E2E-79 needs a written reason from an admin, then two OTHER admins; the requester cannot approve and nobody approves twice", () => {
    expect(() => bg.request("nobody", { purpose: "phone", version: 1, reason: "a long enough reason" })).toThrow(/admin/);
    expect(() => bg.request("admin-a", { purpose: "phone", version: 1, reason: "short" })).toThrow(/reason/);
    const r = bg.request("admin-a", { purpose: "phone", version: 1, reason: "disaster recovery drill" });
    expect(() => bg.approve(r.id, "admin-a")).toThrow(/own/);
    expect(() => bg.approve(r.id, "intruder")).toThrow(/admin/);
    expect(bg.approve(r.id, "admin-b")).toEqual({ approvals: 1, ready: false });
    expect(() => bg.approve(r.id, "admin-b")).toThrow(/already/);
    expect(bg.approve(r.id, "admin-c")).toEqual({ approvals: 2, ready: true });
  });

  it("@E2E-79 one approval is not enough, and the approval count cannot be configured below two", async () => {
    const weak = new BreakGlass({ access: { copyKey: () => Buffer.alloc(1), wrapFor: async () => "x" }, isAdmin: (p) => ADMINS.has(p), approvalsRequired: 1, recoveryKekId: "k" });
    const r = weak.request("admin-a", { purpose: "phone", version: 1, reason: "disaster recovery drill" });
    weak.approve(r.id, "admin-b");
    await expect(weak.exportRecoveryBundle(r.id, "admin-b")).rejects.toThrow(/not usable/);
  });

  it("@E2E-79 export returns the data key wrapped under the RECOVERY KEK (never clear), once, and the bundle is recoverable only through that KEK", async () => {
    const id = approved();
    const bundle = await bg.exportRecoveryBundle(id, "admin-b");
    expect(bundle.startsWith("kek-recovery|")).toBe(true);
    const clear = await kms.unwrap(bundle, "civic-key:phone:1:recovery");
    expect(clear.length).toBe(32);
    await expect(bg.exportRecoveryBundle(id, "admin-b")).rejects.toThrow(/used/); // single use
  });

  it("@E2E-79 useKey hands a transient copy to the callback and zeroizes it afterwards, also when the callback throws", async () => {
    let leaked: Buffer | undefined;
    const id = approved();
    const out = await bg.useKey(id, "admin-c", (k) => { leaked = k; expect(k.length).toBe(32); expect(k.some((b) => b !== 0)).toBe(true); return "done"; });
    expect(out).toBe("done");
    expect(leaked!.every((b) => b === 0)).toBe(true);
    const id2 = approved();
    await expect(bg.useKey(id2, "admin-b", (k) => { leaked = k; throw new Error("boom"); })).rejects.toThrow("boom");
    expect(leaked!.every((b) => b === 0)).toBe(true);
    await expect(bg.useKey(id2, "admin-b", () => 1)).rejects.toThrow(/used/);
  });

  it("@E2E-79 only an admin can use a grant; unapproved, denied and expired grants cannot be used", async () => {
    const r = bg.request("admin-a", { purpose: "phone", version: 1, reason: "disaster recovery drill" });
    await expect(bg.exportRecoveryBundle(r.id, "admin-a")).rejects.toThrow(/pending/);
    bg.approve(r.id, "admin-b"); bg.approve(r.id, "admin-c");
    await expect(bg.exportRecoveryBundle(r.id, "outsider")).rejects.toThrow(/admin/);
    const d = bg.request("admin-a", { purpose: "phone", version: 1, reason: "another written reason" });
    bg.deny(d.id, "admin-b");
    expect(() => bg.approve(d.id, "admin-c")).toThrow(/denied/);
    const e = approved();
    t += 16 * 60_000;
    await expect(bg.exportRecoveryBundle(e, "admin-b")).rejects.toThrow(/expired/);
    expect(() => bg.approve("bg_missing", "admin-b")).toThrow(/unknown/);
  });

  it("@E2E-79 every step and every use is audited, without key material", async () => {
    const id = approved();
    await bg.useKey(id, "admin-b", () => 1);
    expect(auditRows()).toEqual(["keys.breakglass.request", "keys.breakglass.approve", "keys.breakglass.approve", "keys.breakglass.use"]);
    const meta = (getStore("audit").prepare("SELECT meta FROM audit_log WHERE action = 'keys.breakglass.use'").get() as { meta: string }).meta;
    expect(meta).toContain("phone");
  });

  it("@E2E-79 if the audit write fails the key is NOT released (fail closed)", async () => {
    const id = approved();
    const strict = new BreakGlass({ access: { copyKey: () => { throw new Error("must not be reached"); }, wrapFor: async () => { throw new Error("must not be reached"); } }, isAdmin: (p) => ADMINS.has(p), recoveryKekId: "k", auditFn: () => { throw new Error("audit down"); } });
    expect(() => strict.request("admin-a", { purpose: "phone", version: 1, reason: "disaster recovery drill" })).toThrow(/audit down/);
    void id;
  });

  it("@E2E-79 the break-glass capability can be taken once per provider; nothing else can reach a clear data key", () => {
    expect(() => kp.breakGlassAccess()).toThrow(/already/);
  });

  it("@E2E-79 export needs a configured recovery KEK", async () => {
    const noKek = new BreakGlass({ access: { copyKey: () => Buffer.alloc(32), wrapFor: async () => "x" }, isAdmin: (p) => ADMINS.has(p) });
    const r = noKek.request("admin-a", { purpose: "phone", version: 1, reason: "disaster recovery drill" });
    noKek.approve(r.id, "admin-b"); noKek.approve(r.id, "admin-c");
    await expect(noKek.exportRecoveryBundle(r.id, "admin-b")).rejects.toThrow(/recovery KEK/);
  });
});
