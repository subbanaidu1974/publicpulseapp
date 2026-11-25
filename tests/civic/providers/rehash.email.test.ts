import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, migrate, resetDbForTests, setKeyProvider } from "../../../server/civic/core";
import { createEmailPerson, normalizeEmail, personOnEmail } from "../../../server/civic/identity/email";
import { EnvelopeKeyProvider, SqlKeyRegistry, type KmsBackend } from "../../../server/civic/providers/keys";
import { EMAIL_REHASH, rehashTable } from "../../../server/civic/providers/rehash";
import { setProviderLogger } from "../../../server/civic/providers/util";

/** In-process KMS stand-in (AES-GCM under a local KEK), as in rehash.test.ts. */
class LocalKms implements KmsBackend {
  readonly name = "local"; private kek = crypto.randomBytes(32);
  async wrap(_id: string, pt: Buffer, aad: string) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.kek, iv); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(pt), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); }
  async unwrap(w: string, aad: string) { const r = Buffer.from(w, "base64"), d = crypto.createDecipheriv("aes-256-gcm", this.kek, r.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]); }
}

let kp: EnvelopeKeyProvider;
beforeEach(async () => {
  resetDbForTests(); migrate(); setProviderLogger(() => undefined);
  kp = new EnvelopeKeyProvider(new LocalKms(), { kekId: "kek", registry: new SqlKeyRegistry() });
  await kp.warm();
  setKeyProvider(kp);
});
afterEach(() => { kp.destroy(); setKeyProvider(null); setProviderLogger(null); resetDbForTests(); });

describe("email identity under key rotation (S-165)", () => {
  it("@E2E-189 after the contact key rotates, an email account is still found, and the rehash moves it to the new version", async () => {
    const email = normalizeEmail("rotate.me@example.org")!;
    const p = await createEmailPerson({ email, pin: "7391", consentVersion: "v1" });
    await kp.rotate("phone");
    expect(personOnEmail(email)?.id).toBe(p.id); // dual-read finds the old hash and moves it
    expect(getDb().prepare("SELECT email_hash FROM persons WHERE id = ?").get(p.id)).toMatchObject({ email_hash: kp.hmacVersioned("phone", "email:" + email, 2) });
    const later = await createEmailPerson({ email: normalizeEmail("second@example.org")!, pin: "7392", consentVersion: "v1" });
    const dry = rehashTable(EMAIL_REHASH, { dryRun: true });
    expect(dry).toMatchObject({ scanned: 2, dryRun: true });
    const real = rehashTable(EMAIL_REHASH, { dryRun: false });
    expect(real.unrecoverable).toBe(0);
    expect(rehashTable(EMAIL_REHASH, { dryRun: true })).toMatchObject({ stale: 0, encStale: 0 });
    expect(personOnEmail(normalizeEmail("second@example.org")!)?.id).toBe(later.id);
  });
});
