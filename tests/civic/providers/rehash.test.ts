import "../../../server/civic/issues/service";
import "../../../server/civic/issues/media";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, getKeys, getStore, grantRole, migrate, resetDbForTests, setKeyProvider } from "../../../server/civic/core";
import { actorPseudonym, linkPerson, myIssueIds, reporterPseudonym, mediaOwnerPseudonym } from "../../../server/civic/core/pseudonyms";
import { createPerson, phoneHash } from "../../../server/civic/identity/service";
import { EnvelopeKeyProvider, SqlKeyRegistry, type KmsBackend } from "../../../server/civic/providers/keys";
import { PHONE_REHASH, clearEphemeral, hashCandidates, phoneHashCandidates, rehashPseudonyms, rehashTable } from "../../../server/civic/providers/rehash";
import { setProviderLogger } from "../../../server/civic/providers/util";

/** In-process KMS stand-in (AES-GCM under a local KEK) so these tests exercise rotation without HTTP. */
class LocalKms implements KmsBackend {
  readonly name = "local"; private kek = crypto.randomBytes(32);
  async wrap(_id: string, pt: Buffer, aad: string) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.kek, iv); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(pt), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); }
  async unwrap(w: string, aad: string) { const r = Buffer.from(w, "base64"), d = crypto.createDecipheriv("aes-256-gcm", this.kek, r.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]); }
}

let kp: EnvelopeKeyProvider;
const PHONES = ["+919876500011", "+919876500012", "+919876500013"];

beforeEach(async () => {
  resetDbForTests(); migrate(); setProviderLogger(() => undefined);
  kp = new EnvelopeKeyProvider(new LocalKms(), { kekId: "kek", registry: new SqlKeyRegistry() });
  await kp.warm();
  setKeyProvider(kp);
});
afterEach(() => { kp.destroy(); setKeyProvider(null); setProviderLogger(null); resetDbForTests(); });

const people = () => PHONES.map((ph, i) => createPerson({ phone: ph, pin: "7391" + i, consentVersion: "v1" }));
const stored = () => (getDb().prepare("SELECT id, phone_hash AS h, phone_enc AS e FROM persons ORDER BY created_at, id").all() as { id: string; h: string; e: string }[]);

describe("dual-hash rotation helper (S-64)", () => {
  it("@E2E-79 before rotation a dry run reports everything current and changes nothing", () => {
    people();
    const r = rehashTable(PHONE_REHASH);
    expect(r).toMatchObject({ dryRun: true, scanned: 3, alreadyCurrent: 3, stale: 0, unrecoverable: 0, updated: 0 });
  });

  it("@E2E-79 rotate -> dual-read finds old rows, dry-run reports them without writing, run migrates, then retire is safe", async () => {
    const ps = people();
    const before = stored();
    await kp.rotate("phone");
    // single-write: a person created now gets the NEW hash
    const late = createPerson({ phone: "+919876500099", pin: "7392", consentVersion: "v1" });
    expect(stored().find((r) => r.id === late.id)!.h).toBe(kp.hmacVersioned("phone", "+919876500099", 2));
    // the plain lookup (current hash only) no longer sees old rows ...
    expect(getDb().prepare("SELECT COUNT(*) c FROM persons WHERE phone_hash = ?").get(phoneHash(PHONES[0])) as { c: number }).toEqual({ c: 0 });
    // ... dual-read does
    const cands = phoneHashCandidates(PHONES[0]);
    expect(cands).toHaveLength(2);
    expect(getDb().prepare(`SELECT COUNT(*) c FROM persons WHERE phone_hash IN (${cands.map(() => "?").join(",")})`).get(...cands) as { c: number }).toEqual({ c: 1 });

    const dry = rehashTable(PHONE_REHASH, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, scanned: 4, alreadyCurrent: 1, stale: 3, fromOldVersion: 3, fromUnknown: 0, encStale: 3, updated: 0 });
    expect(stored().filter((r) => before.some((b) => b.id === r.id)).map((r) => r.h)).toEqual(before.map((b) => b.h)); // untouched

    const real = rehashTable(PHONE_REHASH, { dryRun: false, batch: 2 }); // batching exercised
    expect(real).toMatchObject({ dryRun: false, stale: 3, updated: 3 });
    for (const [i, p] of ps.entries()) {
      const row = stored().find((r) => r.id === p.id)!;
      expect(row.h).toBe(kp.hmacVersioned("phone", PHONES[i], 2));
      expect(row.e).toMatch(/^v2\.2\./); // re-encrypted under the new key version
      expect(kp.decrypt("phone", row.e)).toBe(PHONES[i]);
    }
    // idempotent and resumable
    expect(rehashTable(PHONE_REHASH, { dryRun: false })).toMatchObject({ stale: 0, updated: 0, alreadyCurrent: 4 });
    await kp.retire("phone", 1);
    expect(phoneHashCandidates(PHONES[0])).toHaveLength(1);
    expect(phoneHash(PHONES[0])).toBe(stored().find((r) => r.id === ps[0].id)!.h);
  });

  it("@E2E-79 rows whose phone was purged cannot be recomputed: reported as unrecoverable and left alone", async () => {
    const [a] = people();
    getDb().prepare("UPDATE persons SET phone_enc = NULL WHERE id = ?").run(a.id);
    await kp.rotate("phone");
    const r = rehashTable(PHONE_REHASH, { dryRun: false });
    expect(r).toMatchObject({ unrecoverable: 1, stale: 2, updated: 2 });
  });

  it("@E2E-79 a hash that matches no known version is reported as fromUnknown (tamper / foreign key signal) but still recomputed from the ciphertext", async () => {
    const [a] = people();
    getDb().prepare("UPDATE persons SET phone_hash = 'deadbeef' WHERE id = ?").run(a.id);
    await kp.rotate("phone");
    const r = rehashTable(PHONE_REHASH, { dryRun: true });
    expect(r.fromUnknown).toBe(1);
    expect(r.fromOldVersion).toBe(2);
  });

  it("@E2E-79 with a v1 provider, hashCandidates degrades to the single current hash and rehash refuses", () => {
    setKeyProvider({ hmac: (p, v) => "h:" + p + v, encrypt: (_p, v) => v, decrypt: (_p, v) => v });
    expect(hashCandidates("phone", "x")).toEqual(["h:phonex"]);
    expect(() => rehashTable(PHONE_REHASH)).toThrow(/v2/);
  });

  it("@E2E-79 pseudonyms: rotating reporter/actor/issue-link keys is a tested dry run then an applied, idempotent re-key of both stores", async () => {
    const [a, b] = people();
    const idb = getStore("issues");
    const mkIssue = (id: string, reporter: string) => idb.prepare("INSERT INTO issue (id, category, village_lgd, department, status, reporter_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, "water", "V1", "RWS", "open", reporter, "2026-01-01", "2026-01-01");
    mkIssue("ISS-1", reporterPseudonym("ISS-1", a.id)); linkPerson(a.id, "issue", "ISS-1", "V1");
    idb.prepare("INSERT INTO issue_me_too (issue_id, person_id, at, self) VALUES (?,?,?,0)").run("ISS-1", reporterPseudonym("ISS-1", b.id), "2026-01-02"); linkPerson(b.id, "issue", "ISS-1", "V1");
    idb.prepare("INSERT INTO issue_media (id, owner_id, kind, mime, bytes, file, created_at, retain_until) VALUES (?,?,?,?,?,?,?,?)").run("M-1", mediaOwnerPseudonym("M-1", a.id), "photo", "image/jpeg", 10, "f", "2026-01-01", "2027-01-01");
    linkPerson(a.id, "media", "M-1", null);
    grantRole("system", a.id, "moderator");
    idb.prepare("INSERT INTO moderation_action (id, issue_id, actor_id, decision, at) VALUES (?,?,?,?,?)").run("MA-1", "ISS-1", actorPseudonym(a.id), "approve", "2026-01-03");

    await kp.rotate("reporter-pseudonym"); await kp.rotate("actor-pseudonym"); await kp.rotate("issue-link");
    const snapshot = JSON.stringify([idb.prepare("SELECT reporter_id FROM issue").all(), getDb().prepare("SELECT link_key FROM issue_links ORDER BY link_key").all()]);
    const dry = rehashPseudonyms();
    expect(dry).toMatchObject({ dryRun: true, updatedRows: 0, unreadableLinks: 0 });
    expect(dry.stalePseudonymRows).toBe(4); // issue.reporter_id, issue_me_too.person_id, issue_media.owner_id, moderation_action.actor_id
    expect(dry.staleLinkKeys).toBe(3);
    expect(JSON.stringify([idb.prepare("SELECT reporter_id FROM issue").all(), getDb().prepare("SELECT link_key FROM issue_links ORDER BY link_key").all()])).toBe(snapshot);

    const real = rehashPseudonyms({ dryRun: false });
    expect(real.updatedRows).toBe(4 + 3);
    expect((idb.prepare("SELECT reporter_id r FROM issue WHERE id='ISS-1'").get() as { r: string }).r).toBe(reporterPseudonym("ISS-1", a.id));
    expect((idb.prepare("SELECT person_id p FROM issue_me_too").get() as { p: string }).p).toBe(reporterPseudonym("ISS-1", b.id));
    expect((idb.prepare("SELECT owner_id o FROM issue_media WHERE id='M-1'").get() as { o: string }).o).toBe(mediaOwnerPseudonym("M-1", a.id));
    expect((idb.prepare("SELECT actor_id o FROM moderation_action").get() as { o: string }).o).toBe(actorPseudonym(a.id));
    expect(myIssueIds(a.id)).toEqual(["ISS-1"]); // the link ledger still resolves
    expect(rehashPseudonyms()).toMatchObject({ stalePseudonymRows: 0, staleLinkKeys: 0 });
    // old pseudonyms are gone, so the old key versions can be retired
    await kp.retire("reporter-pseudonym", 1); await kp.retire("actor-pseudonym", 1); await kp.retire("issue-link", 1);
    expect(myIssueIds(b.id)).toEqual(["ISS-1"]);
  });

  it("@E2E-79 ephemeral keyed values (OTPs, sessions...) are cleared, not migrated; dry-run counts first", () => {
    const [a] = people();
    getDb().prepare("INSERT INTO otps (phone_hash, purpose, code_hash, expires_at, attempts) VALUES ('h','signup','c','2999',0)").run();
    const dry = clearEphemeral("otp");
    expect(dry).toEqual([{ purpose: "otp", dryRun: true, table: "otps", rows: 1 }]);
    expect((getDb().prepare("SELECT COUNT(*) c FROM otps").get() as { c: number }).c).toBe(1);
    clearEphemeral("otp", { dryRun: false });
    expect((getDb().prepare("SELECT COUNT(*) c FROM otps").get() as { c: number }).c).toBe(0);
    expect(clearEphemeral("phone")).toEqual([]); // phone is migrated by rehashTable, never cleared
    void a; void getKeys;
  });
});
