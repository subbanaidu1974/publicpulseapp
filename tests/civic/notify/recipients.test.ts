import { beforeEach, describe, expect, it } from "vitest";
import { getStore, smsOutbox } from "../../../server/civic/core";
import { lintContent, notifyPolicy, processDeferred, pushOutbox, setNotifyClock } from "../../../server/civic/notify";
import * as svc from "../../../server/civic/notify/service";
import * as d from "../../../server/civic/notify/delivery";
import { MSG, NIGHT, NOON, call, devPush, freshWorld, mkOrg, mkPerson, mkSender, opt, sendFull, serve } from "./helpers";

beforeEach(freshWorld);
const decl = { accepted: true, reason: "Emergency notice for public safety" };
const setup = () => { const org = mkOrg(); return { a: mkSender(org), b: mkSender(org), org }; };

describe("content linter: never asks for OTP, PIN, login, payment or unknown links @E2E-47", () => {
  const bad = [
    "Share your OTP to claim", "Your one time password is", "Enter your PIN now", "O T P required", "o.t.p", "Send your password", "click here to login", "Please login to continue",
    "Pay Rs 10 to receive the grant", "Send your bank account details", "UPI PIN needed", "Aadhaar number required", "Visit http://evil.example/claim", "Open bit.ly/abc123", "see www.scam.com",
    "https://ap.gov.in.evil.com/x", "http://ap.gov.in/x", "https://192.168.1.1/x",
    "మీ ఓటీపీ చెప్పండి", "మీ పిన్ నమోదు చేయండి", "పాస్‌వర్డ్ ఇవ్వండి", "లాగిన్ కావడానికి ఇక్కడ క్లిక్ చేయండి", "చెల్లింపు చేయండి", "బ్యాంక్ ఖాతా వివరాలు పంపండి",
  ];
  it.each(bad)("rejects %s", (t) => { expect(lintContent([t]).length).toBeGreaterThan(0); });
  const good = ["Free health camp at the village hall on Monday.", "Heavy rain alert. Stay indoors.", "Details at https://www.ap.gov.in/schemes", "సోమవారం ఉచిత ఆరోగ్య శిబిరం.", "Call the helpline 1100 for help."];
  it.each(good)("allows %s", (t) => { expect(lintContent([t])).toEqual([]); });
  it("send-time refusal is logged without content", async () => {
    const { a } = setup();
    expect(() => svc.createMessage(a.id, { ...MSG, text_en: "Share your OTP now" })).toThrow(/refused/);
    const log = svc.publicBlockLog();
    expect(log[0]).toMatchObject({ reason_code: "content_policy", category: "service" });
    expect(JSON.stringify(log)).not.toContain("OTP");
  });
});

describe("recipient controls @E2E-47", () => {
  it("defaults: only emergency is on; others need opt-in; emergency cannot be switched off", () => {
    const p = mkPerson();
    const pr = d.getPrefs(p.id);
    expect(pr.categories.emergency).toEqual({ opted_in: true, locked: true });
    expect(pr.categories.service.opted_in).toBe(false);
    expect(pr.quiet_hours).toEqual({ start: "21:00", end: "07:00", default: true });
    expect(() => d.updatePrefs(p.id, { categories: { emergency: false } })).toThrow(/cannot be switched off/);
    expect(() => d.updatePrefs(p.id, { quiet_hours: { start: "25:00", end: "07:00" } })).toThrow();
    expect(d.updatePrefs(p.id, { categories: { service: true }, quiet_hours: { start: "22:00", end: "06:00" } }).categories.service.opted_in).toBe(true);
  });
  it("delivers only to opted-in people, with the anti-phishing word, inbox, read state and unsubscribe", async () => {
    const { a, b } = setup();
    const yes = mkPerson(), no = mkPerson();
    opt(yes.id, "service");
    d.setAntiPhish(yes.id, "mango tree");
    const r = await sendFull(a, b);
    expect(r.stats).toMatchObject({ audience: 2, delivered: 1, opted_out: 1 });
    const items = d.inbox(yes.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ antiphish_word: "mango tree", read: false, category: "service" });
    expect(d.inbox(no.id)).toHaveLength(0);
    expect(d.markRead(yes.id, items[0].id as string)).toBe(true);
    expect(d.inbox(yes.id)[0].read).toBe(true);
    expect(d.markRead(no.id, items[0].id as string)).toBe(false);
    d.unsubscribeAll(yes.id);
    expect(d.getPrefs(yes.id).categories.service.opted_in).toBe(false);
  });
  it("anti-phishing word rules", () => {
    const p = mkPerson();
    expect(() => d.setAntiPhish(p.id, "ab")).toThrow();
    expect(() => d.setAntiPhish(p.id, "see http://x.co")).toThrow();
    d.setAntiPhish(p.id, "నా పదం");
    expect(d.getAntiPhish(p.id)).toBe("నా పదం");
  });
  it("per-person daily caps per category", async () => {
    const { a, b } = setup();
    const p = mkPerson(); opt(p.id, "service");
    const cap = notifyPolicy().caps.service.daily;
    let delivered = 0, capped = 0;
    for (let i = 0; i < cap + 1; i++) { const r = await sendFull(a, b, { text_en: `Camp number ${i} at the hall.` }); delivered += (r.stats as any).delivered; capped += (r.stats as any).daily_cap; }
    expect(delivered).toBe(cap); expect(capped).toBe(1);
  });
  it("quiet hours defer non-emergency messages until 07:00 IST; the job delivers them; emergency bypasses", async () => {
    const { a, b } = setup();
    const p = mkPerson(); opt(p.id, "service");
    setNotifyClock(() => NIGHT);
    const r = await sendFull(a, b);
    expect(r.stats).toMatchObject({ deferred: 1, delivered: 0 });
    expect(d.inbox(p.id)).toHaveLength(0);
    const em = svc.createMessage(a.id, { ...MSG, category: "emergency", declaration: decl, text_en: "Flood warning for the village." }); // 2 approvals
    expect(em.approvals_required).toBe(2);
    const c = mkSender(mkOrg()); void c;
    expect(d.inQuiet("21:00", "07:00", NIGHT)).toBe(true);
    expect(d.inQuiet("21:00", "07:00", new Date("2026-06-01T01:30:00Z"))).toBe(false); // 07:00 IST exactly
    expect(d.inQuiet("21:00", "07:00", new Date("2026-06-01T15:30:00Z"))).toBe(true); // 21:00 IST exactly
    setNotifyClock(() => new Date("2026-06-02T01:31:00Z")); // 07:01 IST next day
    expect(await processDeferred(new Date("2026-06-02T01:31:00Z"))).toMatchObject({ delivered: 1 });
    expect(d.inbox(p.id)).toHaveLength(1);
    void NOON;
  });
  it("emergency goes out on every channel (inbox, push, SMS) and bypasses opt-in and quiet hours", async () => {
    const org = mkOrg(), a = mkSender(org, "emergency_authority"), b = mkSender(org, "emergency_authority"), c = mkSender(org, "emergency_authority");
    const p = mkPerson(); d.registerDevice(p.id, "tok-123456789", "android"); d.setAntiPhish(p.id, "mango tree");
    setNotifyClock(() => NIGHT);
    const m = svc.createMessage(a.id, { ...MSG, category: "emergency", declaration: decl, text_en: "Flood warning for the village.", text_te: "గ్రామానికి వరద హెచ్చరిక." });
    const id = m.id as string;
    for (const s of [b, c]) svc.approveMessage(s.id, id, (await import("./helpers")).assertFor(s, id, "approve"));
    const r = await svc.sendMessage(a.id, id, (await import("./helpers")).assertFor(a, id, "send"));
    expect(r.stats).toMatchObject({ delivered: 1, push_sent: 1, sms_sent: 1 });
    expect(pushOutbox.at(-1)!.payload.antiphish).toBe("mango tree");
    expect(smsOutbox.at(-1)!.text).toContain("[mango tree]");
    expect(smsOutbox.at(-1)!.text).toContain("OTP, PIN"); // platform-authored footer (Telugu default)
  });
  it("SMS fallback for non-emergency only when push fails AND the person allows SMS", async () => {
    const { a, b } = setup();
    const p = mkPerson(), q = mkPerson();
    for (const x of [p, q]) { opt(x.id, "service"); d.registerDevice(x.id, "tok-" + x.id.slice(0, 10), "android"); }
    d.updatePrefs(p.id, { sms_ok: true });
    const t = devPush(); t.failNext = true;
    await sendFull(a, b);
    // the dev transport fails exactly once: whoever came first falls back (only if sms_ok)
    const rows = getStore("identity").prepare("SELECT person_id, push_status, sms_status FROM notify_inbox").all() as { person_id: string; push_status: string; sms_status: string | null }[];
    const failed = rows.find((r) => r.push_status.startsWith("failed"))!;
    expect(failed).toBeTruthy();
    expect(!!failed.sms_status).toBe(failed.person_id === p.id);
    const blocked = mkPerson(); opt(blocked.id, "service"); d.updatePrefs(blocked.id, { push_blocked: true, sms_ok: true });
    await sendFull(a, b, { text_en: "Second camp tomorrow morning." });
    const r2 = getStore("identity").prepare("SELECT push_status, sms_status FROM notify_inbox WHERE person_id = ?").get(blocked.id) as { push_status: string; sms_status: string };
    expect(r2).toMatchObject({ push_status: "blocked", sms_status: "sent" });
  });
  it("targeting is geographic only", () => {
    const { a } = setup();
    expect(() => svc.createMessage(a.id, { ...MSG, target: { state: "AP", units: ["U1"], party: "X" } })).toThrow(/geography only/);
    expect(() => svc.createMessage(a.id, { ...MSG, target: { state: "AP", units: ["U1"], caste: "X" } })).toThrow(/geography only/);
  });
  it("HTTP: prefs, anti-phish word, inbox, read, unsubscribe", async () => {
    const { s, base } = await serve();
    try {
      const p = mkPerson();
      expect((await call(base, "GET", "/prefs")).status).toBe(401);
      expect((await call(base, "PUT", "/prefs", { token: p.token, body: { categories: { civic: true } } })).body.categories.civic.opted_in).toBe(true);
      expect((await call(base, "PUT", "/antiphish", { token: p.token, body: { word: "x" } })).status).toBe(400);
      expect((await call(base, "PUT", "/antiphish", { token: p.token, body: { word: "river bank" } })).status).toBe(200);
      expect((await call(base, "GET", "/inbox", { token: p.token })).body).toMatchObject({ items: [], unread: 0 });
      expect((await call(base, "POST", "/inbox/nope/read", { token: p.token })).status).toBe(404);
      expect((await call(base, "POST", "/unsubscribe", { token: p.token })).body.categories.civic.opted_in).toBe(false);
      expect((await call(base, "GET", "/block-log")).status).toBe(200);
    } finally { s.close(); }
  });
});
