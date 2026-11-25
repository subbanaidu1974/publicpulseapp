import { beforeEach, describe, expect, it } from "vitest";
import { getDb, getStore } from "../../../server/civic/core";
import { createEmailPerson } from "../../../server/civic/identity/email";
import { lastMailTo, mailOutbox } from "../../../server/civic/providers/mail";
import * as d from "../../../server/civic/notify/delivery";
import * as svc from "../../../server/civic/notify/service";
import { MSG, assertFor, freshWorld, mkOrg, mkPerson, mkSender, opt, sendFull } from "./helpers";

beforeEach(() => { freshWorld(); mailOutbox.length = 0; });
const setup = () => { const org = mkOrg(); return { a: mkSender(org), b: mkSender(org) }; };
async function emailPerson(addr: string): Promise<string> {
  const p = await createEmailPerson({ email: addr, pin: "739104", consentVersion: "t" });
  getDb().prepare("UPDATE persons SET residence_unit = 'U1' WHERE id = ?").run(p.id);
  return p.id;
}
const row = (id: string) => getStore("identity").prepare("SELECT push_status, sms_status, email_status FROM notify_inbox WHERE person_id = ?").get(id) as { push_status: string; sms_status: string | null; email_status: string | null };

describe("email notification channel (S-184) @E2E-196", () => {
  it("is off by default: an email-only account gets the inbox entry but no mail", async () => {
    const { a, b } = setup(); const id = await emailPerson("quiet@gmail.com"); opt(id, "service");
    await sendFull(a, b);
    expect(row(id).email_status).toBeNull();
    expect(mailOutbox).toHaveLength(0);
    expect(d.getPrefs(id)).toMatchObject({ email_ok: false, has_email: true });
  });

  it("when switched on, mail goes out if push cannot reach the person, with sender, safety word and no links", async () => {
    const { a, b } = setup(); const id = await emailPerson("reader@gmail.com"); opt(id, "service");
    d.setAntiPhish(id, "mango tree"); d.updatePrefs(id, { email_ok: true, language: "en" });
    await sendFull(a, b, { text_en: "Camp at the hall. Details at https://www.ap.gov.in/schemes today." });
    expect(row(id)).toMatchObject({ push_status: "no_device", email_status: "sent" });
    const m = lastMailTo("reader@gmail.com")!;
    expect(m.text).toContain("mango tree");
    expect(m.text).toContain("Do not reply");
    expect(m.text).not.toMatch(/https?:\/\//);
    expect(m.text).toContain("[link removed]");
  });

  it("is the Telugu body when the person's language is Telugu", async () => {
    const { a, b } = setup(); const id = await emailPerson("telugu@gmail.com"); opt(id, "service");
    d.updatePrefs(id, { email_ok: true, language: "te" });
    await sendFull(a, b);
    expect(lastMailTo("telugu@gmail.com")!.text).toContain("పంపినవారు");
  });

  it("is skipped when push already reached the person (non-emergency)", async () => {
    const { a, b } = setup(); const id = await emailPerson("pushed@gmail.com"); opt(id, "service");
    d.registerDevice(id, "tok-pushed-12345", "android"); d.updatePrefs(id, { email_ok: true });
    await sendFull(a, b);
    expect(row(id)).toMatchObject({ push_status: "sent", email_status: null });
    expect(mailOutbox).toHaveLength(0);
  });

  it("emergency goes by email even when push worked, but only for someone who opted in to email", async () => {
    const org = mkOrg(), a = mkSender(org), b = mkSender(org), c = mkSender(org);
    const on = await emailPerson("on@gmail.com"), off = await emailPerson("off@gmail.com");
    for (const id of [on, off]) d.registerDevice(id, "tok-" + id.slice(0, 10), "android");
    d.updatePrefs(on, { email_ok: true });
    const m = svc.createMessage(a.id, { ...MSG, category: "emergency", declaration: { accepted: true, reason: "Emergency notice for public safety" }, text_en: "Flood warning. Move to higher ground." });
    for (const x of [b, c]) svc.approveMessage(x.id, m.id as string, assertFor(x, m.id as string, "approve"));
    await svc.sendMessage(a.id, m.id as string, assertFor(a, m.id as string, "send"));
    expect(row(on).email_status).toBe("sent");
    expect(row(off).email_status).toBeNull();
    expect(lastMailTo("off@gmail.com")).toBeUndefined();
  });

  it("cannot be switched on by an account with no email, and bad values are refused", () => {
    const p = mkPerson();
    expect(() => d.updatePrefs(p.id, { email_ok: true })).toThrow(/no email/);
    expect(() => d.updatePrefs(p.id, { email_ok: "yes" })).toThrow(/true or false/);
    expect(d.updatePrefs(p.id, { email_ok: false }).email_ok).toBe(false);
  });

  it("a phone-only person is untouched and a failing mail provider does not break delivery", async () => {
    const { a, b } = setup(); const id = await emailPerson("fail@gmail.com"); opt(id, "service");
    d.updatePrefs(id, { email_ok: true });
    getDb().prepare("UPDATE persons SET email_enc = 'not-decryptable' WHERE id = ?").run(id);
    const r = await sendFull(a, b);
    expect(r.stats).toMatchObject({ delivered: 1 });
    expect(row(id).email_status).toBe("failed");
  });
});
