import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { isCleared, mccGate, mccTemplates, notifyWindow, setMccTemplates, setNotifyCalendar, setNotifyClock, type MccTemplate } from "../../../server/civic/notify";
import * as svc from "../../../server/civic/notify/service";
import { assertFor, call, freshWorld, mkOrg, mkPerson, mkSender, opt, sendFull, serve } from "./helpers";

// Fake calendar: AP blackout [2026-06-10 00:00 IST, 2026-06-20 00:00 IST); coverage the whole of 2026.
const CAL = { schema: 1, coveredFrom: "2026-01-01", coveredThrough: "2027-01-01", entries: [{ state: "AP", mccStart: "2026-06-10", end: "2026-06-20", source: "test", verified: true }] };
const START = Date.parse("2026-06-10T00:00:00+05:30"), END = Date.parse("2026-06-20T00:00:00+05:30");
const decl = { accepted: true, reason: "Department self-declaration for this notice" };
const CLEARED: MccTemplate = { id: "t.cleared.camp", category: "service", text_en: "Health camp at {place} on Monday.", text_te: "సోమవారం {place} లో ఆరోగ్య శిబిరం.", slots: { place: { max: 40 } }, cleared_by: "TEST AUTHORITY", cleared_on: "2026-05-01", source: "test fixture, not a real clearance" };

beforeEach(() => { freshWorld(); setNotifyCalendar(CAL); setMccTemplates([CLEARED, { ...CLEARED, id: "t.uncleared", cleared_by: null, cleared_on: null }]); });
const at = (ms: number) => setNotifyClock(() => new Date(ms));
const gate = (category: string, o: Record<string, unknown> = {}, ms = START + 1000) => mccGate({ category, state: "AP", now: new Date(ms), ...o } as never);
const setup = async () => { const org = await mkOrg(); return { a: await mkSender(org), b: await mkSender(org) }; };
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe("window states and boundary instants @E2E-48", () => {
  it("open before the start, blackout from the start instant, open again at the end instant", async () => {
    expect(notifyWindow("AP", null, new Date(START - 1))).toBe("open");
    expect(notifyWindow("AP", null, new Date(START))).toBe("blackout");
    expect(notifyWindow("AP", null, new Date(END - 1))).toBe("blackout");
    expect(notifyWindow("AP", null, new Date(END))).toBe("open");
  });
  it("unknown outside calendar coverage, with no calendar, and for an unreadable calendar", async () => {
    expect(notifyWindow("AP", null, new Date("2025-12-31T18:29:59Z"))).toBe("unknown");
    expect(notifyWindow("AP", null, new Date("2027-01-01T00:00:00+05:30"))).toBe("unknown");
    setNotifyCalendar(null);
    expect(notifyWindow("AP", null, new Date(START - 1))).toBe("unknown");
  });
  it("other states are unaffected; a district entry blacks out only that district", async () => {
    expect(notifyWindow("TS", null, new Date(START + 1))).toBe("open");
    setNotifyCalendar({ ...CAL, entries: [{ state: "AP:KRISHNA", mccStart: "2026-06-10", end: "2026-06-20", source: "t", verified: true }] });
    expect(notifyWindow("AP", "KRISHNA", new Date(START + 1))).toBe("blackout");
    expect(notifyWindow("AP", "GUNTUR", new Date(START + 1))).toBe("open");
    expect(notifyWindow("AP", null, new Date(START + 1))).toBe("open");
  });
  it("unverified and example entries never block anything", async () => {
    setNotifyCalendar({ ...CAL, entries: [{ ...CAL.entries[0], verified: false }, { ...CAL.entries[0], example: true }] });
    expect(notifyWindow("AP", null, new Date(START + 1))).toBe("open");
  });
});

describe("MCC gate rules @E2E-48", () => {
  it("open window: everything passes the gate", async () => { for (const c of ["service", "scheme", "civic", "other"]) expect(gate(c, {}, START - 1).allowed).toBe(true); });
  it("blackout: free text and scheme announcements are blocked; only a cleared template with a self-declaration passes", async () => {
    expect(gate("scheme")).toMatchObject({ allowed: false, reason: "mcc_not_precleared" });
    expect(gate("service")).toMatchObject({ allowed: false, reason: "mcc_not_precleared" });
    expect(gate("service", { templateId: "t.uncleared", declaration: decl })).toMatchObject({ allowed: false, reason: "mcc_template_not_cleared" });
    expect(gate("service", { templateId: "t.cleared.camp" })).toMatchObject({ allowed: false, reason: "mcc_declaration_missing" });
    expect(gate("service", { templateId: "t.cleared.camp", declaration: { accepted: true, reason: "short" } }).reason).toBe("mcc_declaration_missing");
    expect(gate("service", { templateId: "t.cleared.camp", declaration: { accepted: false, reason: "long enough reason" } }).reason).toBe("mcc_declaration_missing");
    expect(gate("civic", { templateId: "t.cleared.camp", declaration: decl }).reason).toBe("mcc_not_precleared"); // wrong category for the template
    expect(gate("service", { templateId: "t.cleared.camp", declaration: decl }).allowed).toBe(true);
  });
  it("blackout: emergency always passes, with the declaration", async () => {
    expect(gate("emergency", { declaration: decl }).allowed).toBe(true);
    expect(gate("emergency")).toMatchObject({ allowed: false, reason: "mcc_declaration_missing" });
  });
  it("unknown window fails closed for scheme announcements, not for emergency", async () => {
    const ms = Date.parse("2025-06-01T00:00:00Z");
    expect(gate("scheme", {}, ms)).toMatchObject({ allowed: false, window: "unknown", reason: "mcc_unknown_window" });
    expect(gate("emergency", { declaration: decl }, ms).allowed).toBe(true);
    expect(gate("service", {}, ms).allowed).toBe(true);
  });
  it("shipped template file is examples only: nothing is cleared, no invented clearance", async () => {
    setMccTemplates(null);
    const j = JSON.parse(fs.readFileSync("data/reference/mcc-templates.json", "utf8"));
    expect(j.templates.length).toBeGreaterThan(0);
    for (const t of mccTemplates()) { expect(t.cleared_by).toBeNull(); expect(isCleared(t)).toBe(false); expect(t.example).toBe(true); }
  });
});

describe("MCC through the send path and the public block log @E2E-48", () => {
  it("blocked sends are logged publicly with no content; a cleared template with declaration is recorded and sent", async () => {
    const { a, b } = await setup();
    const p = mkPerson(); opt(p.id, "service"); opt(p.id, "scheme");
    at(START + 3_600_000);
    expect(await code(svc.createMessage(a.id, { category: "scheme", target: { state: "AP", units: ["U1"] }, text_en: "New scheme announced today.", text_te: "ఈ రోజు కొత్త పథకం ప్రకటన." }))).toBe("mcc_not_precleared");
    const log = await svc.publicBlockLog();
    expect(log[0]).toMatchObject({ category: "scheme", reason_code: "mcc_not_precleared", sender_org: "Revenue Department" });
    expect(Object.keys(log[0]).sort()).toEqual(["category", "id", "reason_code", "sender_org", "time_bucket"]);
    expect(JSON.stringify(log)).not.toContain("scheme announced");
    expect(await code(svc.createMessage(a.id, { category: "service", target: { state: "AP", units: ["U1"] }, template_id: "t.cleared.camp", slots: { place: "Village hall" } }))).toBe("mcc_declaration_missing");
    const r = await sendFull(a, b, { category: "service", template_id: "t.cleared.camp", slots: { place: "Village hall" }, text_en: undefined, text_te: undefined, declaration: decl });
    expect(r.status).toBe("sent");
    const m = await svc.getMessage(a.id, (await svc.listMessages(a.id))[0].id as string);
    expect(m).toMatchObject({ template_id: "t.cleared.camp", mcc_window: "blackout" });
    expect(m.declaration).toMatchObject({ accepted: true, reason: decl.reason });
    expect(m.declaration.checkbox_text_en).toContain("Model Code of Conduct");
    expect(m.text_en).toBe("Health camp at Village hall on Monday.");
  });
  it("window can turn to blackout between approval and send: send blocks and logs it", async () => {
    const { a, b } = await setup();
    at(START - 3_600_000);
    const m = await svc.createMessage(a.id, { category: "scheme", target: { state: "AP", units: ["U1"] }, text_en: "Scheme news for farmers.", text_te: "రైతులకు పథక వార్త." }), id = m.id as string;
    await svc.approveMessage(b.id, id, await assertFor(b, id, "approve"));
    at(START + 1);
    await expect(svc.sendMessage(a.id, id, await assertFor(a, id, "send"))).rejects.toMatchObject({ code: "mcc_not_precleared" });
    expect((await svc.getMessage(a.id, id)).status).toBe("blocked");
    expect((await svc.publicBlockLog())[0].reason_code).toBe("mcc_not_precleared");
  });
  it("unknown window: scheme blocked and logged", async () => {
    const { a } = await setup();
    setNotifyCalendar(null);
    expect(await code(svc.createMessage(a.id, { category: "scheme", target: { state: "AP", units: ["U1"] }, text_en: "Scheme news for farmers.", text_te: "రైతులకు పథక వార్త." }))).toBe("mcc_unknown_window");
    expect((await svc.publicBlockLog())[0].reason_code).toBe("mcc_unknown_window");
  });
  it("GET /block-log and /templates are public", async () => {
    const { s, base } = await serve();
    try {
      const { a } = await setup();
      at(START + 1);
      await code(svc.createMessage(a.id, { category: "scheme", target: { state: "AP", units: ["U1"] }, text_en: "Scheme news.", text_te: "పథక వార్త." }));
      const r = await call(base, "GET", "/block-log");
      expect(r.status).toBe(200); expect(r.body.entries.length).toBe(1);
      const t = await call(base, "GET", "/templates");
      expect(t.body.templates.every((x: { cleared: boolean }) => x.cleared === false || x.cleared === true)).toBe(true);
    } finally { s.close(); }
  });
});
