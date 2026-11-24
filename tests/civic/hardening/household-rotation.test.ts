/** S-161 follow-up: household invites survive an online phone-key rotation (dual-hash lookups via phoneHashCandidates). */
import crypto, { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, getDb, migrate, resetDbForTests, setKeyProvider, smsOutbox } from "../../../server/civic/core";
import { householdRouter } from "../../../server/civic/households/routes";
import { phoneHash } from "../../../server/civic/identity/service";
import { EnvelopeKeyProvider, SqlKeyRegistry, type KmsBackend } from "../../../server/civic/providers/keys";
import { setProviderLogger } from "../../../server/civic/providers/util";

class LocalKms implements KmsBackend {
  readonly name = "local"; private kek = crypto.randomBytes(32);
  async wrap(_id: string, pt: Buffer, aad: string) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.kek, iv); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(pt), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); }
  async unwrap(w: string, aad: string) { const r = Buffer.from(w, "base64"), d = crypto.createDecipheriv("aes-256-gcm", this.kek, r.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]); }
}

let server: Server, base: string, kp: EnvelopeKeyProvider;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/households", householdRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/households`;
});
afterAll(() => { server.close(); });
beforeEach(async () => {
  process.env.NODE_ENV = "test";
  resetDbForTests(); migrate(); setProviderLogger(() => undefined);
  kp = new EnvelopeKeyProvider(new LocalKms(), { kekId: "kek", registry: new SqlKeyRegistry() });
  await kp.warm();
  setKeyProvider(kp);
  smsOutbox.length = 0;
});
afterEach(() => { kp.destroy(); setKeyProvider(null); setProviderLogger(null); resetDbForTests(); });

function person(e164?: string): { id: string; token: string } {
  const id = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, phone_hash, phone_enc, created_at, eligible_from) VALUES (?,?,?,?,?)")
    .run(id, e164 ? phoneHash(e164) : null, e164 ? kp.encrypt("phone", e164) : null, now, now);
  return { id, token: createSession(id) };
}
async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

const LOCAL = "9876500031", E164 = "+919876500031";

describe("household invites across a phone-key rotation (S-161)", () => {
  it("an invite issued before the rotation is still accepted by the invitee (old-hash invite, old or migrated person row)", async () => {
    const head = person(); const spouse = person(E164);
    await call(head.token, "POST", "/");
    const inv = await call(head.token, "POST", "/members/invite", { phone: LOCAL, relation: "spouse" });
    expect(inv.status).toBe(201);
    const oldHash = phoneHash(E164);
    await kp.rotate("phone");
    expect(phoneHash(E164)).not.toBe(oldHash);
    // The invitee's identity row was lazily migrated to the new hash; the invite still holds the old one.
    getDb().prepare("UPDATE persons SET phone_hash = ? WHERE id = ?").run(phoneHash(E164), spouse.id);
    expect((getDb().prepare("SELECT phone_hash FROM hh_invite WHERE id=?").get(inv.body.inviteId) as { phone_hash: string }).phone_hash).toBe(oldHash);
    expect((await call(spouse.token, "POST", "/invites/accept", { inviteId: inv.body.inviteId, pin: "4821" })).status).toBe(200);
  });

  it("a different person's number is still refused after the rotation", async () => {
    const head = person(); const other = person("+919876500099");
    await call(head.token, "POST", "/");
    const inv = await call(head.token, "POST", "/members/invite", { phone: LOCAL, relation: "spouse" });
    await kp.rotate("phone");
    const r = await call(other.token, "POST", "/invites/accept", { inviteId: inv.body.inviteId, pin: "4821" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("phone_mismatch");
  });

  it("duplicate-invite and decline-cooldown checks see old-hash rows after the rotation", async () => {
    const head = person(); const spouse = person(E164);
    await call(head.token, "POST", "/");
    const inv = await call(head.token, "POST", "/members/invite", { phone: LOCAL, relation: "spouse" });
    await kp.rotate("phone");
    expect((await call(head.token, "POST", "/members/invite", { phone: LOCAL, relation: "spouse" })).status).toBe(409); // already invited
    expect((await call(spouse.token, "POST", "/invites/decline", { inviteId: inv.body.inviteId })).status).toBe(200);
    const again = await call(head.token, "POST", "/members/invite", { phone: LOCAL, relation: "spouse" });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("invite_cooldown");
  });
});
