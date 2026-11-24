import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STORE_NAMES, audit, createSession, grantRole as grantCoreRole, getDb, getStore, migrate, resetDbForTests, verifyAuditChain, type StoreName } from "../../server/civic/core";
import { pseudonymsOf, reporterPseudonym } from "../../server/civic/core/pseudonyms";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createPerson, deleteAccount } from "../../server/civic/identity/service";
import { appeal, clock, grantRole, meToo, moderate, rebuttal, reportIssue, transition } from "../../server/civic/issues/service";
import { proposeChange, reviewChange } from "../../server/civic/issues/curation";
import { resetLexiconCache } from "../../server/civic/issues/moderation";
import { setMediaScanner, storeMedia } from "../../server/civic/issues/media";
import { sqliteCallStore } from "../../server/civic/channels/callstore";
import { createPair, recordIssue, submitRecheck, requestSwitch } from "../../server/civic/assisted";
import { MockGrievanceAdapter, forwardToGrievance, postReply, setGrievanceAdapter } from "../../server/civic/representatives";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "civic-erase-"));
process.env.CIVIC_MEDIA_DIR = path.join(tmp, "media");
process.env.CIVIC_LEXICON_FILE = path.join(tmp, "lexicon.json");
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const T0 = new Date("2026-03-01T10:00:00Z");
const PHONE = "+919876522222";
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0"), Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]), Buffer.alloc(30, 5), Buffer.from([0xff, 0xd9])]);

beforeEach(() => {
  fs.copyFileSync(path.resolve("data/civic/moderation-lexicon.json"), process.env.CIVIC_LEXICON_FILE!);
  resetLexiconCache(); setMediaScanner(null);
  resetDbForTests(); migrate(); loadDemoGeo();
  clock.now = () => T0;
});

/** Every (table, column) of the given stores (default: all four) whose text value contains the needle. */
function scanAll(needle: string, stores: StoreName[] = STORE_NAMES): string[] {
  const hits: string[] = [];
  for (const store of stores) {
    const d = getStore(store);
    for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
      for (const col of d.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]) {
        const n = (d.prepare(`SELECT COUNT(*) c FROM "${name}" WHERE CAST("${col.name}" AS TEXT) LIKE ?`).get(`%${needle}%`) as { c: number }).c;
        if (n) hits.push(`${name}.${col.name}`);
      }
    }
  }
  return hits;
}
const tablesWith = (needle: string, stores?: StoreName[]) => new Set(scanAll(needle, stores).map((h) => h.split(".")[0]));
const tablesWithAny = (needles: string[], stores?: StoreName[]) => new Set(needles.flatMap((n) => [...tablesWith(n, stores)]));

describe("erasure completeness (S-143)", () => {
  it("@E2E-158 dump-all-tables: after account deletion no table or column holds the person id or phone hash", async () => {
    const victim = createPerson({ phone: PHONE, pin: "4821", consentVersion: "v1" });
    const id = victim.id;
    const phoneHash = (getDb().prepare("SELECT phone_hash FROM persons WHERE id=?").get(id) as { phone_hash: string }).phone_hash;
    expect(phoneHash).toBeTruthy();
    getDb().prepare("UPDATE persons SET residence_unit=?, residence_declared_at=? WHERE id=?").run("DEMO-V-KLR", T0.toISOString(), id);
    createSession(id);
    createPerson({ phone: "+919876533333", pin: "4821", consentVersion: "v1" });
    const bystander = "bystander";

    // -- the person's data in every issue table --
    grantRole(id, "officer", "Rural Water Supply", "DEMO-M-KLP", "RWS victim");
    grantRole(id, "moderator", null, null, "Mod victim");
    grantRole("mod-2", "moderator", null, null, "Mod 2");
    grantRole("off-2", "officer", "Roads and Buildings", "DEMO-M-KLP", "R&B 2");

    const photo = await storeMedia(id, jpeg, "image/jpeg", T0);                                    // issue_media
    const mine = reportIssue(id, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply here", photo_ref: photo.ref, lat: 16.2401, lon: 80.1502 }, T0); // issue.reporter_id, gps_enc
    const held = reportIssue(id, { category: "health", village_lgd: "DEMO-V-KLR", description_en: "Mr Ramesh Kumar took a bribe" }, T0);
    expect(held.held).toBe(true);
    appeal(held.id, id, "this is about a post, not a person", T0);                                   // issue_appeal
    const road = reportIssue(bystander, { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Pothole outside the school" }, T0);
    meToo(road.id, id, T0);                                                                          // issue_me_too
    for (const to of ["Verified", "Assigned", "Resolved"]) transition(road.id, "off-2", { to }, T0);
    expect((getStore("issues").prepare("SELECT COUNT(*) c FROM issue_sample WHERE person_id=?").get(reporterPseudonym(road.id, id)) as { c: number }).c).toBe(1); // issue_sample (the sample draws from supporters)
    rebuttal(road.id, id, "We are on it", T0);                                                       // officer_rebuttal.author_id
    const other = reportIssue(bystander, { category: "electricity", village_lgd: "DEMO-V-KLR", description_en: "Transformer sparking nightly" }, T0);
    // a held issue by someone else, approved by the victim as moderator -> moderation_action
    const heldOther = reportIssue(bystander, { category: "agriculture", village_lgd: "DEMO-V-KLR", description_en: "Mrs Lakshmi Devi sells bad seed" }, T0);
    expect(heldOther.held).toBe(true);
    moderate(heldOther.id, id, "approve", T0, "false positive");
    // lexicon proposals: victim approves one, proposes one, rejects one -> lexicon_change
    const p1 = proposeChange("mod-2", { op: "add", list: "abuse.en", term: "zorbleflax" }, T0);
    reviewChange(id, p1.id, "approve", T0);
    proposeChange(id, { op: "add", list: "abuse.en", term: "quibblewump" }, T0);
    const p3 = proposeChange("mod-2", { op: "add", list: "abuse.en", term: "frobnitz" }, T0);
    reviewChange(id, p3.id, "reject", T0);
    // IVR call state naming the person (and a shared-SIM neighbour)
    sqliteCallStore.put({ callId: "call-erase-1", phone: "9876522222", state: "pin", createdAt: Date.now(), turns: 1, adults: [id, "someone-else"], personId: id, needsPin: true });
    // S-145: the victim is also a representative who replied on an issue and forwarded it to the (mock) grievance system
    grantCoreRole("system", id, "politician", "DEMO-C-TNL");
    postReply(id, other.id, { text: "We have asked the department to look into the transformer problem this week." }, T0);   // rep_reply.author_id
    setGrievanceAdapter(new MockGrievanceAdapter());
    await forwardToGrievance(id, other.id, T0);                                                                              // grievance_link.requested_by
    setGrievanceAdapter(null);
    // S-49 assisted participation: the victim is a coordinator who formed a pair, one of its two assistants, a reviewer and an admin who asked for the kill switch
    const mate = createPerson({ phone: "+919876544455", pin: "4821", consentVersion: "v1" }), partner = createPerson({ phone: "+919876544456", pin: "4821", consentVersion: "v1" });
    for (const p of [mate, partner]) grantCoreRole("system", p.id, "volunteer");
    grantCoreRole("system", id, "assist_coordinator", ""); grantCoreRole("system", id, "assist_reviewer", ""); grantCoreRole("system", id, "volunteer", "");
    createPair(id, { village_lgd: "DEMO-V-KLR", member_a: mate.id, member_b: partner.id }, T0);                  // assist_pair.formed_by
    const coord2 = createPerson({ phone: "+919876544458", pin: "4821", consentVersion: "v1" }), mate2 = createPerson({ phone: "+919876544457", pin: "4821", consentVersion: "v1" });
    grantCoreRole("system", coord2.id, "assist_coordinator", ""); grantCoreRole("system", mate2.id, "volunteer", "");
    createPair(coord2.id, { village_lgd: "DEMO-V-ANM", member_a: id, member_b: mate2.id }, T0);                                  // assist_pair.member_a
    const ticks = { adult: true, explained: true, willing_self: true, deletion_known: true };
    recordIssue(id, mate2.id, { category: "roads", description_en: "Culvert near the market is broken", adult_attested: true, consent_a: { adult: true, explained: true, willing_self: true, deletion_known: true }, consent_b: { adult: true, explained: true, willing_self: true, deletion_known: true } }, T0); // assisted_record.consent_by_a
    const rec = recordIssue(mate.id, partner.id, { category: "water", description_en: "Hand pump stopped working near the school", adult_attested: true, consent_a: ticks, consent_b: ticks }, T0);
    submitRecheck(id, rec.id, "confirmed", "checked by phone", T0);                                                              // assist_recheck.reviewer_id
    requestSwitch(id, "disable", "test the pause", T0);                                                                          // assisted_switch_request.requested_by
    audit(id, "custom.action", `person:${id}`, { note: "x" });
    void mine; void other;

    // every issue-related table that can hold a person must contain the person before deletion (guards against new, unhooked tables)
    // S-74: the issues store holds NO person id, only keyed pseudonyms; the identity store keeps the roles and the encrypted way back.
    expect(scanAll(id, ["issues", "audit", "survey"]).filter((h) => !h.startsWith("audit_log.")), "issues/survey stores must not contain the person id").toEqual([]);
    expect(tablesWith(id, ["identity"])).toContain("officer_role");
    const pseudonyms = pseudonymsOf(id);
    expect(pseudonyms.length).toBeGreaterThan(4);
    const before = tablesWithAny(pseudonyms, ["issues"]);
    const personTables = ["issue", "issue_me_too", "issue_sample", "issue_appeal", "issue_media", "officer_rebuttal", "moderation_action", "lexicon_change", "ivr_call", "rep_reply", "grievance_link", "assist_pair", "assisted_record", "assist_recheck", "assisted_switch_request"];
    for (const t of personTables) expect(before, `table ${t} should hold a pseudonym of the person before erasure`).toContain(t);
    const issueTables = (getStore("issues").prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    for (const t of issueTables) if (!["issue_event", "migrations", "admin_unit", "hamlet", "village_constituency"].includes(t)) expect(personTables, `new table ${t} needs a row in this test and an erasure hook`).toContain(t);
    const mediaFiles = fs.readdirSync(process.env.CIVIC_MEDIA_DIR!).filter((f) => f !== ".gitignore");
    expect(mediaFiles).toHaveLength(1);

    // -- delete the account --
    const out = deleteAccount(id);
    for (const h of ["issue_media", "issues.reporter", "issues.me_too", "issues.samples", "issues.appeals", "issues.officer", "issues.moderation", "issues.rep_reply", "channels.ivr_call", "assisted.pseudonyms"]) expect(out.hooks).toContain(h);

    // -- dump every table and column --
    const leaks: Record<string, string[]> = {};
    expect(getDb().prepare("SELECT person_id, last_error, attempts FROM erasure_outbox").all()).toEqual([]); // the cross-store step completed
    expect(getDb().prepare("SELECT COUNT(*) c FROM issue_links WHERE person_id=?").get(id)).toMatchObject({ c: 0 });
    for (const ps of pseudonyms) expect(scanAll(ps), `pseudonym ${ps.slice(0, 8)} must be gone from every store`).toEqual([]);
    for (const [label, needle] of [["person id", id], ["phone hash", phoneHash], ["phone number", "9876522222"], ["phone e164", PHONE]] as const) {
      const hits = scanAll(needle).filter((h) => !(label === "person id" && h === "persons.id")); // the tombstone row keeps its id
      if (hits.length) leaks[label] = hits;
    }
    expect(leaks).toEqual({});
    const tomb = getDb().prepare("SELECT * FROM persons WHERE id=?").get(id) as Record<string, unknown>;
    expect(tomb).toMatchObject({ phone_hash: null, phone_enc: null, pin_hash: null, residence_unit: null, label: null });
    expect(tomb.deleted_at).toBeTruthy();
    expect(fs.readdirSync(process.env.CIVIC_MEDIA_DIR!).filter((f) => f !== ".gitignore")).toEqual([]);

    // what must survive: the public record and counts, without the link
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue_me_too WHERE issue_id=?").get(road.id)).toMatchObject({ c: 2 }); // bystander (reporter) + the erased supporter, pseudonymised
    expect(getStore("issues").prepare("SELECT reporter_id, gps_enc FROM issue WHERE id=?").get(mine.id)).toMatchObject({ reporter_id: "erased", gps_enc: null });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue_appeal").get()).toMatchObject({ c: 1 });
    expect(getStore("issues").prepare("SELECT author_id FROM officer_rebuttal WHERE issue_id=?").get(road.id)).toMatchObject({ author_id: null });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM lexicon_change").get()).toMatchObject({ c: 3 });

    // the audit log keeps redacted rows with digests only, and the chain still verifies
    const rows = getStore("audit").prepare("SELECT * FROM audit_log WHERE redacted=1").all() as any[];
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) { expect(r.actor).toBe("[redacted]"); expect(r.actor_d).toMatch(/^[0-9a-f]{64}$/); expect(r.meta).toBe("{}"); }
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-158 erasing one person leaves other people's rows alone", async () => {
    const a = createPerson({ phone: "+919876544441", pin: "4821", consentVersion: "v1" });
    const b = createPerson({ phone: "+919876544442", pin: "4821", consentVersion: "v1" });
    for (const p of [a, b]) getDb().prepare("UPDATE persons SET residence_unit='DEMO-V-KLR', residence_declared_at=? WHERE id=?").run(T0.toISOString(), p.id);
    const ia = reportIssue(a.id, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply here" }, T0);
    const ib = reportIssue(b.id, { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Pothole outside the school" }, T0);
    meToo(ib.id, a.id, T0);
    deleteAccount(a.id);
    expect(getStore("issues").prepare("SELECT reporter_id FROM issue WHERE id=?").get(ib.id)).toMatchObject({ reporter_id: reporterPseudonym(ib.id, b.id) });
    expect(getStore("issues").prepare("SELECT reporter_id FROM issue WHERE id=?").get(ia.id)).toMatchObject({ reporter_id: "erased" });
    expect(tablesWithAny(pseudonymsOf(b.id), ["issues"])).toContain("issue");
    expect(tablesWith(b.id, ["issues"]).size).toBe(0); // and still no person id in the issues store
  });
});
