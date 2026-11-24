/** S-161 (@E2E-185): identity looks phones up through phoneHashCandidates, so a key rotation locks nobody out and can finish with the old key retired. */
import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, migrate, resetDbForTests, setKeyProvider } from "../../../server/civic/core";
import { personsOnPhone, phoneHash } from "../../../server/civic/identity/service";
import { EnvelopeKeyProvider, SqlKeyRegistry, type KmsBackend } from "../../../server/civic/providers/keys";
import { PHONE_REHASH, phoneHashCandidates, rehashTable } from "../../../server/civic/providers/rehash";
import { setProviderLogger } from "../../../server/civic/providers/util";
import { caller, serveIdentity, signupVia } from "./helpers";

class LocalKms implements KmsBackend {
  readonly name = "local"; private kek = crypto.randomBytes(32);
  async wrap(_id: string, pt: Buffer, aad: string) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.kek, iv); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(pt), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); }
  async unwrap(w: string, aad: string) { const r = Buffer.from(w, "base64"), d = crypto.createDecipheriv("aes-256-gcm", this.kek, r.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]); }
}

let server: Server, call: ReturnType<typeof caller>, kp: EnvelopeKeyProvider;
beforeAll(async () => { const s = await serveIdentity(); server = s.server; call = caller(s.base); });
afterAll(() => { server.close(); });
beforeEach(async () => {
  process.env.CIVIC_EXPOSE_DEV_OTP = "1";
  resetDbForTests(); migrate(); setProviderLogger(() => undefined);
  kp = new EnvelopeKeyProvider(new LocalKms(), { kekId: "kek", registry: new SqlKeyRegistry() });
  await kp.warm();
  setKeyProvider(kp);
});
afterEach(() => { kp.destroy(); setKeyProvider(null); setProviderLogger(null); resetDbForTests(); delete process.env.CIVIC_EXPOSE_DEV_OTP; });

const A = "+919876500021", B = "+919876500022", C = "+919876500023";
const stored = (id: string) => (getDb().prepare("SELECT phone_hash AS h, phone_enc AS e FROM persons WHERE id = ?").get(id) as { h: string; e: string });

describe("online phone-key rotation (S-161)", () => {
  it("@E2E-185 during the window old accounts still log in, sign-up/recovery find them, and the login itself migrates the row (single write, lazy rewrite)", async () => {
    const a = await signupVia(call, A, "4821");
    const b = await signupVia(call, B, "5827");
    const oldHashA = stored(a.id).h;
    await kp.rotate("phone");
    expect(phoneHash(A)).not.toBe(oldHashA);
    expect(phoneHashCandidates(A)).toEqual([phoneHash(A), oldHashA]); // current first, old still readable

    // old account logs in; its row is rewritten to the NEW hash and ciphertext on the way
    const login = await call("POST", "/login", { phone: A, pin: "4821" });
    expect(login.status).toBe(200);
    expect(login.json.person.id).toBe(a.id);
    expect(stored(a.id).h).toBe(phoneHash(A));
    expect(stored(a.id).e).toMatch(/^v2\.2\./);
    expect(stored(b.id).h).not.toBe(phoneHash(B)); // B was not touched yet

    // a number that already has an old-hash account cannot sign up again (no duplicate adult under the new key)
    const rq = await call("POST", "/signup/request", { phone: B });
    const dup = await call("POST", "/signup/verify", { phone: B, otp: rq.json.dev_otp, pin: "9051" });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe("number_registered");

    // recovery for an old-hash account works and also migrates it
    const rec = await call("POST", "/pin/recover/request", { phone: B });
    expect((await call("POST", "/pin/recover", { phone: B, otp: rec.json.dev_otp, new_pin: "7391", person_id: b.id })).status).toBe(200);
    expect(stored(b.id).h).toBe(phoneHash(B));
    expect((await call("POST", "/login", { phone: B, pin: "7391" })).status).toBe(200);

    // a brand-new sign-up writes the NEW hash directly
    const c = await signupVia(call, C, "6203");
    expect(stored(c.id).h).toBe(phoneHash(C));
  });

  it("@E2E-185 an OTP requested before the rotation can still be used after it, and a new code replaces the old-hash row", async () => {
    const rq = await call("POST", "/signup/request", { phone: A });
    const before = getDb().prepare("SELECT phone_hash AS h FROM otps").all() as { h: string }[];
    await kp.rotate("phone");
    const v = await call("POST", "/signup/verify", { phone: A, otp: rq.json.dev_otp, pin: "4821" });
    expect(v.status).toBe(201);
    expect(before).toHaveLength(1);
    // a code issued under the old key is not duplicated by a new request: already_sent is honoured across the rotation
    await call("POST", "/login", { phone: A, pin: "4821" });
    const rq2 = await call("POST", "/pin/recover/request", { phone: B });
    await kp.rotate("phone");
    const again = await call("POST", "/pin/recover/request", { phone: B });
    expect(again.json.already_sent).toBe(true);
    expect(rq2.json.dev_otp).toMatch(/^\d{6}$/);
    // storing a fresh code removes the old-hash twin
    getDb().prepare("UPDATE otps SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    const fresh = await call("POST", "/pin/recover/request", { phone: B });
    expect(fresh.json.dev_otp).toMatch(/^\d{6}$/);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM otps WHERE purpose = 'recovery'").get()).toEqual({ c: 1 });
  });

  it("@E2E-185 the rotation finishes end to end: rehash migrates the rest, the old key is retired, and everybody can still log in", async () => {
    const ids: Record<string, string> = {};
    for (const [ph, pin] of [[A, "4821"], [B, "5827"], [C, "6203"]]) ids[ph] = (await signupVia(call, ph, pin)).id;
    await kp.rotate("phone");
    await call("POST", "/login", { phone: A, pin: "4821" }); // one row migrates lazily, the others by the job
    const dry = rehashTable(PHONE_REHASH, { dryRun: true });
    expect(dry).toMatchObject({ stale: 2, alreadyCurrent: 1, unrecoverable: 0 });
    const real = rehashTable(PHONE_REHASH, { dryRun: false });
    expect(real).toMatchObject({ stale: 2, updated: 2 }); // the lazily migrated row is already current (hash and ciphertext)
    expect(rehashTable(PHONE_REHASH, { dryRun: true })).toMatchObject({ stale: 0, encStale: 0 });
    await kp.retire("phone", 1);
    expect(phoneHashCandidates(A)).toHaveLength(1);
    for (const [ph, pin] of [[A, "4821"], [B, "5827"], [C, "6203"]]) {
      const r = await call("POST", "/login", { phone: ph, pin });
      expect(r.status, ph).toBe(200);
      expect(r.json.person.id).toBe(ids[ph]);
      expect(personsOnPhone(ph)).toHaveLength(1);
    }
  });
});
