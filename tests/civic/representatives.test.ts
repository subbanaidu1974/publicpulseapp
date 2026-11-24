import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "node:crypto";
import { createSession, getDb, getStore, grantRole, migrate, resetDbForTests, verifyAuditChain } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createIssuesRouter } from "../../server/civic/issues/routes";
import { resetExportRate } from "../../server/civic/issues/public";
import { representativesRouter, MockGrievanceAdapter, setGrievanceAdapter, validateTicket, schemeRegistry, GRIEVANCE_CONTRACT } from "../../server/civic/representatives";

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/civic/issues", createIssuesRouter());
  app.use("/api/v1/civic/representatives", representativesRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); loadDemoGeo(); resetExportRate(); setGrievanceAdapter(null); });
afterEach(() => { setGrievanceAdapter(null); delete process.env.CIVIC_REP_REPLIES_PER_DAY; });

function mk(): { id: string; token: string } {
  const id = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, tier, created_at, eligible_from) VALUES (?,?,?,?)").run(id, "T1", now, now);
  return { id, token: createSession(id) };
}
async function call(token: string | null, method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json: Record<string, any> = {};
  try { json = t ? JSON.parse(t) : {}; } catch { /* not json */ }
  return { status: r.status, body: json, text: t };
}
const politician = (constituency = "DEMO-C-TNL") => { const p = mk(); grantRole("system", p.id, "politician", constituency); return p; };
const moderator = () => { const p = mk(); grantRole("system", p.id, "moderator"); return p; };
async function report(village = "DEMO-V-KLR", text = "No drinking water supply in the lane") {
  const p = mk();
  const r = await call(p.token, "POST", "/issues", { category: "water", village_lgd: village, description_en: text });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { reporter: p, id: r.body.id as string };
}
const TEXT = "We have asked the department to restore the water supply and will follow up this week.";

describe("representative reply (S-145)", () => {
  it("a representative of the constituency posts one labelled reply; the public page shows it without changing the report", async () => {
    const { id } = await report();
    const before = await call(null, "GET", `/issues/${id}`);
    expect(before.body.official_reply).toBeNull();
    const rep = politician();
    const r = await call(rep.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT, scheme_tags: ["jal_jeevan"] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version: 1, status: "visible", scheme_tags: ["jal_jeevan"] });
    const after = await call(null, "GET", `/issues/${id}`);
    expect(after.body.official_reply).toMatchObject({
      label: "representative_reply", text: TEXT, version: 1, edited: false, history: [],
      constituency: { lgd: "DEMO-C-TNL", name_en: "Tenali" },
      scheme_tags: [{ id: "jal_jeevan", label_en: expect.any(String), label_te: expect.any(String) }],
    });
    // nothing about the report moves: status, counts, timeline, order
    const strip = (b: Record<string, any>) => { const { official_reply, ...rest } = b; void official_reply; return rest; };
    expect(strip(after.body)).toEqual(strip(before.body));
    // no identity of the representative in the public payload
    expect(after.text).not.toContain(rep.id);
    expect(JSON.stringify(getStore("issues").prepare("SELECT * FROM rep_reply").all())).not.toContain(rep.id); // pseudonymous author only
  });

  it("refuses citizens, representatives of another constituency, and issues that are not public", async () => {
    const { id } = await report();
    const citizen = mk();
    expect((await call(null, "POST", `/representatives/issues/${id}/reply`, { text: TEXT })).status).toBe(401);
    expect((await call(citizen.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT })).body.code).toBe("role_required");
    const wrong = politician("DEMO-C-WGE");
    const out = await call(wrong.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("outside_scope");
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'scope.denied'").get()).toEqual({ c: 1 });
    const none = politician();
    expect((await call(none.token, "POST", `/representatives/issues/nope/reply`, { text: TEXT })).status).toBe(404);
    const held = await report("DEMO-V-KLR", "Mr Ramesh Kumar took a bribe");
    expect((await call(none.token, "POST", `/representatives/issues/${held.id}/reply`, { text: TEXT })).status).toBe(404);
    // a politician grant with no constituency reaches nothing
    const unscoped = mk(); grantRole("system", unscoped.id, "politician");
    expect((await call(unscoped.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT })).body.code).toBe("role_required");
  });

  it("validates length and scheme tags against the registry (at most three)", async () => {
    const { id } = await report();
    const rep = politician();
    const post = (b: unknown) => call(rep.token, "POST", `/representatives/issues/${id}/reply`, b);
    expect((await post({ text: "too short" })).body.code).toBe("bad_length");
    expect((await post({ text: TEXT, scheme_tags: ["no_such_scheme"] })).body.code).toBe("unknown_scheme");
    expect((await post({ text: TEXT, scheme_tags: "pm_kisan" })).body.code).toBe("bad_tags");
    const ids = schemeRegistry().map((s) => s.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect((await post({ text: TEXT, scheme_tags: ids.slice(0, 4) })).body.code).toBe("too_many_tags");
    expect((await post({ text: TEXT, scheme_tags: [ids[0], ids[0]] })).body.scheme_tags).toEqual([ids[0]]);
    const reg = await call(null, "GET", "/representatives/schemes");
    expect(reg.body.schemes.length).toBe(ids.length);
    expect(reg.body.max_tags).toBe(3);
  });

  it("one reply per issue; a revision appends a version and keeps the history; only the author revises", async () => {
    const { id } = await report();
    const rep = politician(), colleague = politician();
    expect((await call(rep.token, "POST", `/representatives/issues/${id}/reply/revise`, { text: TEXT })).body.code).toBe("no_reply");
    await call(rep.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT });
    expect((await call(rep.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT + " again" })).body.code).toBe("reply_exists");
    expect((await call(colleague.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT })).body.code).toBe("reply_exists");
    expect((await call(colleague.token, "POST", `/representatives/issues/${id}/reply/revise`, { text: TEXT + " more" })).body.code).toBe("not_author");
    expect((await call(rep.token, "POST", `/representatives/issues/${id}/reply/revise`, { text: TEXT })).body.code).toBe("no_change");
    const v2 = await call(rep.token, "POST", `/representatives/issues/${id}/reply/revise`, { text: "The pipeline repair is scheduled for Friday and the department has confirmed it.", scheme_tags: ["jal_jeevan", "state_scheme"] });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const pub = (await call(null, "GET", `/issues/${id}`)).body.official_reply;
    expect(pub).toMatchObject({ version: 2, edited: true, text: expect.stringContaining("Friday"), posted_at: expect.any(String) });
    expect(pub.history).toEqual([{ version: 1, text: TEXT, at: expect.any(String) }]);
    const rows = getStore("issues").prepare("SELECT version, body, status FROM rep_reply WHERE issue_id = ? ORDER BY version").all(id) as { version: number; body: string; status: string }[];
    expect(rows.map((r) => [r.version, r.body === TEXT || r.body.includes("Friday")])).toEqual([[1, true], [2, true]]); // v1 is untouched
    const mine = await call(rep.token, "GET", `/representatives/issues/${id}/reply/mine`);
    expect(mine.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect((await call(colleague.token, "GET", `/representatives/issues/${id}/reply/mine`)).status).toBe(404);
  });

  it("a flagged reply is held (not public) until a moderator approves it; the earlier version keeps showing while a revision is held", async () => {
    const { id } = await report();
    const rep = politician(), mod = moderator();
    await call(rep.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT });
    const flagged = await call(rep.token, "POST", `/representatives/issues/${id}/reply/revise`, { text: "Mr Ramesh Kumar from the contractor office took money and delayed the work on purpose." });
    expect(flagged.body.status).toBe("held");
    expect(flagged.body.hold_reasons.length).toBeGreaterThan(0);
    expect((await call(null, "GET", `/issues/${id}`)).body.official_reply).toMatchObject({ version: 1, edited: false }); // v1 still shown
    expect((await call(rep.token, "GET", "/representatives/moderation/queue")).status).toBe(403);
    const q = await call(mod.token, "GET", "/representatives/moderation/queue");
    expect(q.body.replies).toHaveLength(1);
    expect(q.body.replies[0]).toMatchObject({ issue_id: id, version: 2, constituency: "DEMO-C-TNL" });
    const rid = q.body.replies[0].id;
    expect((await call(rep.token, "POST", `/representatives/replies/${rid}/review`, { decision: "approve" })).status).toBe(403);
    expect((await call(mod.token, "POST", `/representatives/replies/${rid}/review`, { decision: "maybe" })).body.code).toBe("bad_decision");
    const ok = await call(mod.token, "POST", `/representatives/replies/${rid}/review`, { decision: "approve" });
    expect(ok.body.status).toBe("visible");
    expect((await call(null, "GET", `/issues/${id}`)).body.official_reply).toMatchObject({ version: 2, edited: true });
    // a moderator can pull a visible reply back, with a reason, and remove it; the thread stays in the database
    expect((await call(mod.token, "POST", `/representatives/replies/${rid}/review`, { decision: "hold" })).body.code).toBe("note_required");
    expect((await call(mod.token, "POST", `/representatives/replies/${rid}/review`, { decision: "remove", note: "names a private person" })).body.status).toBe("removed");
    expect((await call(null, "GET", `/issues/${id}`)).body.official_reply).toMatchObject({ version: 1 });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM rep_reply WHERE issue_id = ?").get(id)).toEqual({ c: 2 });
    // every step is in the audit chain, and no reply text is
    const meta = (getStore("audit").prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'representative.%'").all() as { action: string; meta: string }[]);
    expect(meta.map((m) => m.action)).toEqual(expect.arrayContaining(["representative.reply.post", "representative.reply.revise", "representative.reply.review"]));
    expect(JSON.stringify(meta)).not.toContain("Ramesh");
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("a moderator who is also the author cannot moderate their own reply", async () => {
    const { id } = await report();
    const both = politician(); grantRole("system", both.id, "moderator");
    const r = await call(both.token, "POST", `/representatives/issues/${id}/reply`, { text: "Mr Ramesh Kumar will meet the contractor and fix the pipeline this week." });
    expect(r.body.status).toBe("held");
    expect((await call(both.token, "POST", `/representatives/replies/${r.body.id}/review`, { decision: "approve" })).body.code).toBe("own_reply");
  });

  it("is rate limited per person per day", async () => {
    process.env.CIVIC_REP_REPLIES_PER_DAY = "2";
    const a = await report(), b = await report("DEMO-V-BPL");
    const rep = politician();
    expect((await call(rep.token, "POST", `/representatives/issues/${a.id}/reply`, { text: TEXT })).status).toBe(201);
    expect((await call(rep.token, "POST", `/representatives/issues/${a.id}/reply/revise`, { text: TEXT + " Update: work started." })).status).toBe(201);
    const third = await call(rep.token, "POST", `/representatives/issues/${b.id}/reply`, { text: TEXT });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("rate_limited");
  });
});

describe("grievance-system adapter contract (S-145, mock only)", () => {
  it("answers 501 while no adapter is installed", async () => {
    const { id } = await report();
    expect((await call(politician().token, "POST", `/representatives/issues/${id}/grievance`, {})).body.code).toBe("grievance_adapter_unavailable");
  });

  it("forwards only the contract fields, once per issue, tracks status, and surfaces adapter failures without storing a link", async () => {
    const mock = new MockGrievanceAdapter();
    setGrievanceAdapter(mock);
    const { id, reporter } = await report("DEMO-V-KLR", "No drinking water supply in the lane");
    const rep = politician();
    await call(rep.token, "POST", `/representatives/issues/${id}/reply`, { text: TEXT, scheme_tags: ["jal_jeevan"] });
    mock.failNext = true;
    const bad = await call(rep.token, "POST", `/representatives/issues/${id}/grievance`, {});
    expect(bad.status).toBe(502);
    expect(bad.body.code).toBe("grievance_system_error");
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM grievance_link").get()).toEqual({ c: 0 });
    const ok = await call(rep.token, "POST", `/representatives/issues/${id}/grievance`, {});
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ created: true, system: "mock", reference: "MOCK-0001", status: "received" });
    const again = await call(rep.token, "POST", `/representatives/issues/${id}/grievance`, {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, reference: "MOCK-0001" });
    expect(mock.tickets.size).toBe(1);
    const sent = mock.tickets.get("MOCK-0001")!.ticket;
    expect(Object.keys(sent).sort()).toEqual(["category", "constituency_lgd", "department", "issue_id", "scheme_tags", "text_en", "text_te", "village_lgd"]);
    expect(sent).toMatchObject({ issue_id: id, constituency_lgd: "DEMO-C-TNL", village_lgd: "DEMO-V-KLR", scheme_tags: ["jal_jeevan"] });
    expect(JSON.stringify(sent)).not.toContain(reporter.id);
    mock.advance("MOCK-0001", "in_progress");
    expect((await call(rep.token, "GET", `/representatives/issues/${id}/grievance`)).body).toMatchObject({ reference: "MOCK-0001", status: "in_progress" });
    expect((await call(politician("DEMO-C-WGE").token, "POST", `/representatives/issues/${id}/grievance`, {})).body.code).toBe("outside_scope");
    expect((await call(mk().token, "GET", `/representatives/issues/${id}/grievance`)).status).toBe(403);
  });

  it("the contract rejects tickets with fields outside it, and the mock is idempotent per key", async () => {
    expect(GRIEVANCE_CONTRACT).toBe(1);
    expect(() => validateTicket({ issue_id: "i", category: "water", department: "d", village_lgd: "v", constituency_lgd: "c", text_en: null, text_te: null, scheme_tags: [], reporter_phone: "9999999999" })).toThrow(/outside the contract/);
    expect(() => validateTicket({ issue_id: "i", category: "water", department: "", village_lgd: "v", constituency_lgd: "c", text_en: null, text_te: null, scheme_tags: [] })).toThrow(/missing department/);
    const mock = new MockGrievanceAdapter();
    const t = validateTicket({ issue_id: "i", category: "water", department: "d", village_lgd: "v", constituency_lgd: "c", text_en: null, text_te: null, scheme_tags: [] });
    const a = await mock.submit(t, { idempotencyKey: "k" }), b = await mock.submit(t, { idempotencyKey: "k" });
    expect(a).toEqual(b);
    expect(mock.tickets.size).toBe(1);
    await expect(mock.status("nope")).rejects.toThrow();
    expect(() => setGrievanceAdapter({ contract: 2 as unknown as 1, name: "x", submit: async () => a, status: async () => a })).toThrow();
  });
});
