import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalJson, createSession, getDb, getStore, grantRole, migrate, resetDbForTests, verifyAuditChain } from "../../../server/civic/core";
import type { RoleName } from "../../../server/civic/core";
import { registryRouter, closeDueSurveys, figuresPublishable, getSurvey } from "../../../server/civic/surveys/registry";
import { registryNow, setRegistryClock } from "../../../server/civic/surveys/types";

let server: Server;
let base = "";
let clock = new Date("2026-12-01T10:00:00Z");
const tick = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const DAY = 86_400_000;
const ENVS = ["CIVIC_ELECTION_CHOICE_SURVEYS", "ELECTION_CALENDAR_FILE", "FORECAST_BLACKOUT"] as const;

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/surveys", registryRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/surveys`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  resetDbForTests(); migrate();
  clock = new Date("2026-12-01T10:00:00Z");
  setRegistryClock(() => clock);
  for (const k of ENVS) delete process.env[k];
});
afterEach(() => { setRegistryClock(null); for (const k of ENVS) delete process.env[k]; });

interface P { id: string; token: string }
function person(role?: RoleName, dept?: string): P {
  const id = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?,?,?)").run(id, now, now);
  if (role) grantRole("system", id, role, null, dept ?? null);
  return { id, token: createSession(id) };
}
async function call(p: P | null, method: string, url: string, body?: unknown) {
  const r = await fetch(base + url, {
    method, headers: { "content-type": "application/json", ...(p ? { authorization: "Bearer " + p.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: (t ? JSON.parse(t) : {}) as Record<string, any> };
}

const opt = (en: string, te = "ఎంపిక " + en, prefer_not = false) => ({ label_en: en, label_te: te, prefer_not });
function draft(over: Record<string, unknown> = {}) {
  return {
    topic_class: "issue_service", title_en: "Drinking water supply in your village", title_te: "మీ గ్రామంలో తాగునీటి సరఫరా",
    scope: { state: "AP", units: { district: ["520"] } },
    opens_at: clock.toISOString(), closes_at: new Date(clock.getTime() + 7 * DAY).toISOString(),
    questions: [{ kind: "single", text_en: "How reliable is the drinking water supply in your village?", text_te: "మీ గ్రామంలో తాగునీటి సరఫరా ఎంత నమ్మదగినది?", options: [opt("Reliable"), opt("Unreliable")] }],
    ...over,
  };
}
const political = (over: Record<string, unknown> = {}) => draft({
  topic_class: "political", title_en: "Opinion on the new road policy", title_te: "కొత్త రహదారి విధానంపై అభిప్రాయం",
  questions: [{ kind: "single", text_en: "How satisfied are you with the new road policy?", text_te: "కొత్త రహదారి విధానంతో మీరు ఎంత సంతృప్తిగా ఉన్నారు?", options: [opt("Satisfied"), opt("Not satisfied"), opt("Prefer not to say", "చెప్పడానికి ఇష్టపడను", true)] }],
  ...over,
});
const electionDraft = (over: Record<string, unknown> = {}) => political({
  topic_class: "election_choice", title_en: "Party preference in your constituency", title_te: "మీ నియోజకవర్గంలో పార్టీ ప్రాధాన్యం",
  questions: [{ kind: "single", text_en: "Which party do you prefer?", text_te: "మీరు ఏ పార్టీని ఇష్టపడతారు?", options: [opt("TDP"), opt("YSRCP"), opt("Prefer not to say", "చెప్పడానికి ఇష్టపడను", true)] }],
  ...over,
});

const party = (code: string) => person("politician", code);
const reviewer = () => person("admin");
async function create(p: P, d: Record<string, unknown> = draft()) { const r = await call(p, "POST", "", d); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string; }
async function submit(p: P, id: string) { return call(p, "POST", `/${id}/submit`); }
async function approve(id: string, n = 2) {
  let last = { status: 0, body: {} as Record<string, any> };
  for (let i = 0; i < n; i++) last = await call(reviewer(), "POST", `/${id}/panel/review`, { decision: "approve", notes: "fine" });
  return last;
}
async function approved(p: P, d: Record<string, unknown> = draft()) {
  const id = await create(p, d);
  const s = await submit(p, id); expect(s.status, JSON.stringify(s.body)).toBe(200);
  const a = await approve(id); expect(a.body.status).toBe("approved");
  return id;
}

function calendar(entries: Record<string, unknown>[]): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cal-")), "cal.json");
  fs.writeFileSync(f, JSON.stringify({ schema: 1, coveredFrom: "2026-01-01", coveredThrough: "2028-01-01", entries }));
  return f;
}
const MCC = { state: "AP", mccStart: "2026-12-10T00:00:00Z", end: "2026-12-20T00:00:00Z", source: "test", verified: true };

describe("registry: creation, public list, frozen wording (S-28)", () => {
  it("@E2E-37 only creator roles may create; drafts are private; the submitted survey is public with a disclaimer", async () => {
    expect((await call(null, "POST", "", draft())).status).toBe(401);
    expect((await call(person(), "POST", "", draft())).status).toBe(403);
    expect((await call(person("moderator"), "POST", "", draft())).status).toBe(403);
    const tdp = party("TDP");
    const id = await create(tdp);
    expect((await call(null, "GET", `/${id}`)).status).toBe(404); // draft: not public
    expect((await call(null, "GET", "")).body.surveys).toHaveLength(0);
    expect((await call(tdp, "GET", "/mine")).body.surveys[0].id).toBe(id);
    expect((await call(party("YSRCP"), "GET", "/mine")).body.surveys).toHaveLength(0);
    expect((await submit(tdp, id)).status).toBe(200);
    const pub = await call(null, "GET", `/${id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe("in_review");
    expect(pub.body.creator).toEqual({ org_kind: "party", org_code: "TDP", department: null });
    expect(pub.body.disclaimer_en).toBe("Opinion survey, not an election and not a forecast");
    expect(pub.body.disclaimer_te).toBeTruthy();
    expect(JSON.stringify(pub.body)).not.toMatch(/creator_pseudonym|person_id/);
    expect(pub.body.questions[0].options).toHaveLength(2);
  });

  it("@E2E-37 the creator is a keyed pseudonym, never persons.id", async () => {
    const tdp = party("TDP");
    const id = await create(tdp);
    const row = getStore("survey").prepare("SELECT creator_pseudonym FROM surveys WHERE id = ?").get(id) as { creator_pseudonym: string };
    expect(row.creator_pseudonym).not.toBe(tdp.id);
    expect(row.creator_pseudonym).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(getStore("survey").prepare("SELECT * FROM surveys").all())).not.toContain(tdp.id);
  });

  it("@E2E-37 a politician role without a party code, and an officer without a department, cannot create", async () => {
    expect((await call(person("politician"), "POST", "", draft())).body.code).toBe("party_scope_missing");
    expect((await call(person("politician", "NOTAPARTY"), "POST", "", draft())).body.code).toBe("party_scope_missing");
    expect((await call(person("officer"), "POST", "", draft({ topic_class: "bill" }))).body.code).toBe("department_required");
  });

  it("@E2E-37 structural validation: up to 10 questions, options 2..8, multi max_select, scale5, dates", async () => {
    const t = party("TDP");
    const q = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "single", text_en: `Question number ${i + 1} here`, options: [opt("Yes"), opt("No")] }));
    expect((await call(t, "POST", "", draft({ questions: q(11) }))).body.code).toBe("too_many_questions");
    expect((await call(t, "POST", "", draft({ questions: q(10) }))).status).toBe(201);
    expect((await call(t, "POST", "", draft({ questions: [{ kind: "single", text_en: "One option only here", options: [opt("Yes")] }] }))).body.code).toBe("option_count_invalid");
    const nine = Array.from({ length: 9 }, (_, i) => opt("Option " + i));
    expect((await call(t, "POST", "", draft({ questions: [{ kind: "single", text_en: "Nine options here", options: nine }] }))).body.code).toBe("option_count_invalid");
    const multi = (max: number | null) => draft({ questions: [{ kind: "multi", text_en: "Which services need work?", max_select: max, options: [opt("Water"), opt("Roads"), opt("Power")] }] });
    expect((await call(t, "POST", "", multi(4))).body.code).toBe("max_select_invalid");
    expect((await call(t, "POST", "", multi(null))).body.code).toBe("max_select_invalid");
    expect((await call(t, "POST", "", multi(2))).status).toBe(201);
    const scale = await call(t, "POST", "", draft({ questions: [{ kind: "scale5", text_en: "Roads in my area are in good repair", text_te: "తెలుగు ప్రశ్న", options: [] }] }));
    expect(scale.status).toBe(201);
    const sid = scale.body.id;
    expect((await submit(t, sid)).status).toBe(200);
    expect((await call(null, "GET", `/${sid}`)).body.questions[0].options).toHaveLength(5);
    expect((await call(t, "POST", "", draft({ opens_at: new Date(clock.getTime() - 2 * DAY).toISOString(), closes_at: new Date(clock.getTime() - DAY).toISOString() }))).body.code).toBe("closes_in_past");
    expect((await call(t, "POST", "", draft({ closes_at: new Date(clock.getTime() + 200 * DAY).toISOString() }))).body.code).toBe("window_too_long");
    expect((await call(t, "POST", "", draft({ topic_class: "weather" }))).body.code).toBe("topic_class_invalid");
    expect((await call(t, "POST", "", draft({ scope: { state: "" } }))).body.code).toBe("scope_state_required");
  });

  it("@E2E-37 wording is FROZEN after approval: PATCH 409, SQL edits blocked, version snapshot hash verifies", async () => {
    const t = party("TDP");
    const id = await create(t);
    const p1 = await call(t, "PATCH", `/${id}`, { title_en: "Drinking water supply: a clearer title" });
    expect(p1.status).toBe(200);
    expect(p1.body.version).toBe(2);
    expect((await submit(t, id)).status).toBe(200);
    expect((await call(t, "PATCH", `/${id}`, { title_en: "Sneaky change" })).status).toBe(409); // in review is frozen too
    expect((await approve(id)).body.status).toBe("approved");
    const frozen = await call(t, "PATCH", `/${id}`, { title_en: "Changed after approval" });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe("wording_frozen");
    const d = getStore("survey");
    expect(() => d.prepare("UPDATE surveys SET title_en = 'x' WHERE id = ?").run(id)).toThrow(/wording_frozen/);
    expect(() => d.prepare("UPDATE surveys SET closes_at = '2030-01-01T00:00:00.000Z' WHERE id = ?").run(id)).toThrow(/wording_frozen/);
    expect(() => d.prepare("UPDATE survey_questions SET text_en = 'x' WHERE survey_id = ?").run(id)).toThrow(/wording_frozen/);
    expect(() => d.prepare("DELETE FROM survey_options WHERE question_id IN (SELECT id FROM survey_questions WHERE survey_id = ?)").run(id)).toThrow(/wording_frozen/);
    expect(() => d.prepare("UPDATE survey_versions SET wording_hash = 'x' WHERE survey_id = ?").run(id)).toThrow(/append_only/);
    expect(() => d.prepare("DELETE FROM surveys WHERE id = ?").run(id)).toThrow(/append_only/);
    const pub = (await call(null, "GET", `/${id}`)).body;
    expect(pub.title_en).toBe("Drinking water supply: a clearer title");
    expect(pub.versions).toHaveLength(1);
    const v = (await call(null, "GET", `/${id}/versions/${pub.versions[0].version}`)).body;
    expect(crypto.createHash("sha256").update(canonicalJson(v.wording)).digest("hex")).toBe(v.wording_hash);
    expect(v.wording_hash).toBe(pub.wording_hash);
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-37 list: filters, cursor pagination, identical payload for every caller", async () => {
    const t = party("TDP"), y = party("YSRCP");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { tick(1000); const id = await create(i % 2 ? y : t, draft({ title_en: `Water survey number ${i}`, topic_class: "issue_service", scope: { state: i < 4 ? "AP" : "TS", units: {} } })); await submit(i % 2 ? y : t, id); ids.push(id); }
    const all = await call(null, "GET", "");
    expect(all.body.surveys.map((s: any) => s.id)).toEqual([...ids].reverse());
    expect(all.body).toEqual((await call(person("admin"), "GET", "")).body);
    expect((await call(null, "GET", "?state=TS")).body.surveys).toHaveLength(1);
    expect((await call(null, "GET", "?q=number 3")).body.surveys.map((s: any) => s.id)).toEqual([ids[3]]);
    expect((await call(null, "GET", "?q=100%25")).body.surveys).toHaveLength(0);
    expect((await call(null, "GET", "?status=approved")).body.surveys).toHaveLength(0);
    expect((await call(null, "GET", "?status=draft")).body.surveys).toHaveLength(0);
    expect((await call(null, "GET", "?topic=bill")).body.surveys).toHaveLength(0);
    expect((await call(null, "GET", "?status=nope")).status).toBe(400);
    const p1 = await call(null, "GET", "?limit=2");
    expect(p1.body.surveys).toHaveLength(2);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await call(null, "GET", `?limit=2&cursor=${p1.body.next_cursor}`);
    const p3 = await call(null, "GET", `?limit=2&cursor=${p2.body.next_cursor}`);
    expect([...p1.body.surveys, ...p2.body.surveys, ...p3.body.surveys].map((s: any) => s.id)).toEqual([...ids].reverse());
    expect(p3.body.next_cursor).toBeNull();
    expect((await call(null, "GET", "?cursor=@@@")).status).toBe(400);
  });
});

describe("registry: wording checks and the independent panel (S-28)", () => {
  it("@E2E-37 banned framing, leading words and double-barrelled questions block submission; Telugu text and prefer-not are mandatory", async () => {
    const t = party("TDP");
    const withQ = (text: string, over: Record<string, unknown> = {}) => draft({ questions: [{ kind: "single", text_en: text, text_te: "తెలుగు ప్రశ్న", options: [opt("Yes"), opt("No")] }], ...over });
    for (const [text, code] of [
      ["Who would you vote for in the next election?", "banned_framing"],
      ["What is your forecast for the next assembly?", "banned_framing"],
      ["Obviously the water supply is poor, do you agree?", "leading"],
      ["Do you support the new road and should the fuel tax be reduced?", "double_barrelled"],
    ] as const) {
      const id = await create(t, withQ(text));
      const r = await submit(t, id);
      expect(r.status, text).toBe(400);
      expect(r.body.code).toBe("wording_check_failed");
      expect(r.body.findings.map((f: any) => f.code)).toContain(code);
    }
    const ok = await create(t, withQ("Are you satisfied with water and sanitation services?"));
    expect((await submit(t, ok)).status).toBe(200);
    const noTe = await create(t, draft({ title_te: undefined }));
    expect((await submit(t, noTe)).body.code).toBe("telugu_required");
    const noPn = await create(t, political({ questions: [{ kind: "single", text_en: "How satisfied are you with the road policy?", text_te: "తెలుగు", options: [opt("Satisfied"), opt("Not satisfied")] }] }));
    const r = await submit(t, noPn);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("prefer_not_required");
    expect(r.body.questions).toEqual([1]);
  });

  it("@E2E-37 needs two DISTINCT approvals; the creator and the creator's organisation cannot review; a rejection needs notes and returns the draft", async () => {
    const t = party("TDP");
    const id = await create(t);
    expect((await call(reviewer(), "POST", `/${id}/panel/review`, { decision: "approve" })).status).toBe(404); // draft
    await submit(t, id);
    expect((await call(person(), "POST", `/${id}/panel/review`, { decision: "approve" })).status).toBe(403);
    expect((await call(t, "POST", `/${id}/panel/review`, { decision: "approve" })).status).toBe(403); // not a panel role
    const sameOrg = person("survey_panel", "TDP");
    const c1 = await call(sameOrg, "POST", `/${id}/panel/review`, { decision: "approve" });
    expect(c1.status).toBe(403);
    expect(c1.body.code).toBe("reviewer_conflict");
    const adminCreator = person("admin");
    const aid = await create(adminCreator, draft({ topic_class: "issue_service" }));
    await submit(adminCreator, aid);
    expect((await call(adminCreator, "POST", `/${aid}/panel/review`, { decision: "approve" })).body.reason).toBe("creator");
    const civil = person("survey_panel", "civil_society");
    const opp = person("survey_panel", "YSRCP");
    const a1 = await call(civil, "POST", `/${id}/panel/review`, { decision: "approve", notes: "balanced wording" });
    expect(a1.status).toBe(200);
    expect(a1.body.status).toBe("in_review");
    expect((await call(civil, "POST", `/${id}/panel/review`, { decision: "approve" })).status).toBe(409); // twice
    expect((await call(opp, "POST", `/${id}/panel/review`, { decision: "reject" })).body.code).toBe("rejection_needs_notes");
    const rej = await call(opp, "POST", `/${id}/panel/review`, { decision: "reject", notes: "Option order favours the first answer." });
    expect(rej.body.status).toBe("draft");
    expect((await call(null, "GET", `/${id}`)).status).toBe(404); // back to draft: private again
    // edit, resubmit: the earlier approval was for another wording and no longer counts
    expect((await call(t, "PATCH", `/${id}`, { questions: [{ kind: "single", text_en: "How reliable is your village water supply?", text_te: "తెలుగు", options: [opt("Unreliable"), opt("Reliable")] }] })).status).toBe(200);
    expect((await submit(t, id)).status).toBe(200);
    const r2 = await call(civil, "POST", `/${id}/panel/review`, { decision: "approve" });
    expect(r2.body.panel.approvals).toBe(1);
    expect(r2.body.status).toBe("in_review");
    const r3 = await call(person("survey_panel", "media"), "POST", `/${id}/panel/review`, { decision: "approve" });
    expect(r3.body.status).toBe("approved");
    const pub = (await call(null, "GET", `/${id}`)).body;
    expect(pub.panel.required_approvals).toBe(2);
    expect(pub.panel.decisions.length).toBe(4);
    expect(JSON.stringify(pub.panel)).not.toMatch(/reviewer|pseudonym/);
    expect(pub.versions.map((v: any) => v.version)).toEqual([1, 2]);
  });
});

describe("registry: equal-access quotas (S-28, A2)", () => {
  it("@E2E-37 each party gets the same political quota: party A cannot exceed while party B is under", async () => {
    const a = party("TDP"), a2 = party("TDP"), b = party("YSRCP");
    const pol = (n: number) => political({ title_en: `Opinion on road policy number ${n}` });
    const q0 = await call(a, "GET", "/quota?topic_class=political");
    expect(q0.body).toMatchObject({ org_kind: "party", org_code: "TDP", limit: 2, used: 0, allowed: true });
    for (let i = 0; i < 2; i++) { const id = await create(i ? a2 : a, pol(i)); expect((await submit(i ? a2 : a, id)).status).toBe(200); }
    const third = await create(a, pol(3));
    const blocked = await submit(a, third);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: "quota_exceeded", limit: 2, used: 2 });
    expect(blocked.body.resets_at).toBeTruthy();
    expect((await call(a, "GET", "/quota?topic_class=political")).body.allowed).toBe(false);
    // party B is untouched by A's usage
    expect((await call(b, "GET", "/quota?topic_class=political")).body).toMatchObject({ used: 0, allowed: true });
    for (let i = 0; i < 2; i++) { const id = await create(b, pol(10 + i)); expect((await submit(b, id)).status).toBe(200); }
    expect((await submit(b, await create(b, pol(12)))).status).toBe(429);
    // rolling window: 31 days later A may submit again
    tick(31 * DAY);
    const later = await create(a, political({ title_en: "Opinion on road policy later", closes_at: new Date(clock.getTime() + 7 * DAY).toISOString(), opens_at: clock.toISOString() }));
    expect((await submit(a, later)).status).toBe(200);
  });

  it("@E2E-37 quota is consumed at submission, once per survey: drafts, rejections and resubmits are free or counted once", async () => {
    const a = party("TDP");
    for (let i = 0; i < 5; i++) await create(a, political({ title_en: `Draft number ${i} on roads` })); // drafts consume nothing
    expect((await call(a, "GET", "/quota?topic_class=political")).body.used).toBe(0);
    const id = await create(a, political());
    await submit(a, id);
    await call(person("survey_panel", "civil_society"), "POST", `/${id}/panel/review`, { decision: "reject", notes: "Please reword the title." });
    expect((await submit(a, id)).status).toBe(200); // resubmit unchanged
    expect((await call(a, "GET", "/quota?topic_class=political")).body.used).toBe(1);
  });

  it("@E2E-37 government: unlimited 'bill' surveys but each needs a department; media and academic: one per month; admin cannot be a party", async () => {
    const officer = person("officer", "Roads and Buildings");
    for (let i = 0; i < 4; i++) { const id = await create(officer, draft({ topic_class: "bill", title_en: `Draft road bill consultation ${i}` })); expect((await submit(officer, id)).status).toBe(200); }
    expect((await call(officer, "GET", "/quota?topic_class=bill")).body).toMatchObject({ org_kind: "government", department: "Roads and Buildings", limit: null, allowed: true });
    expect((await call(officer, "POST", "", political())).body.code).toBe("topic_not_allowed_for_org");
    const j = person("journalist", "The Daily");
    expect((await submit(j, await create(j, draft()))).status).toBe(200);
    const second = await submit(j, await create(j, draft({ title_en: "A second water survey" })));
    expect(second.status).toBe(429);
    tick(31 * DAY);
    const again = await create(j, draft({ opens_at: clock.toISOString(), closes_at: new Date(clock.getTime() + DAY).toISOString() }));
    expect((await submit(j, again)).status).toBe(200);
    const admin = person("admin");
    const acad = await call(admin, "POST", "", draft({ org_kind: "academic", org_code: "IIIT-H" }));
    expect(acad.body.creator).toEqual({ org_kind: "academic", org_code: "IIIT-H", department: null });
    expect((await call(admin, "POST", "", draft({ org_kind: "party", org_code: "TDP" }))).status).toBe(403);
  });
});

describe("registry: lifecycle, cancellation log, closing job (S-28)", () => {
  it("@E2E-37 cancelling needs a public reason; cancelled surveys stay in the registry and the public log", async () => {
    const t = party("TDP");
    const id = await approved(t);
    expect((await call(t, "POST", `/${id}/cancel`, {})).status).toBe(400);
    expect((await call(t, "POST", `/${id}/cancel`, { reason_code: "other" })).status).toBe(400);
    expect((await call(t, "POST", `/${id}/cancel`, { reason_code: "made_up", reason_text: "Not a listed reason code" })).status).toBe(400);
    expect((await call(t, "POST", `/${id}/cancel`, { reason_code: "other", reason_text: "short" })).status).toBe(400);
    expect((await call(party("YSRCP"), "POST", `/${id}/cancel`, { reason_code: "other", reason_text: "Not my survey to cancel" })).status).toBe(403);
    const c = await call(t, "POST", `/${id}/cancel`, { reason_code: "wording_dispute", reason_text: "The panel and we agree the wording needs a new survey." });
    expect(c.status).toBe(200);
    expect((await call(t, "POST", `/${id}/cancel`, { reason_code: "other", reason_text: "Cancelling a second time" })).status).toBe(409);
    const list = (await call(null, "GET", "")).body.surveys;
    expect(list.map((s: any) => s.id)).toContain(id);
    expect(list.find((s: any) => s.id === id).status).toBe("cancelled");
    const det = (await call(null, "GET", `/${id}`)).body;
    expect(det.cancellation).toMatchObject({ reason_code: "wording_dispute", reason_text: expect.stringContaining("new survey") });
    expect(det.questions.length).toBe(1); // wording stays public
    const log = (await call(null, "GET", "/registry/log")).body;
    const kinds = log.entries.map((e: any) => e.kind);
    expect(kinds).toEqual(["registered", "panel_decision", "panel_decision", "approved", "cancelled"]);
    expect((await call(null, "GET", "/registry/log?kind=cancelled")).body.entries).toHaveLength(1);
    expect((await call(null, "GET", "/registry/log?kind=cancelled")).body.entries[0].detail).toMatchObject({ reason_code: "wording_dispute" });
    const d = getStore("survey");
    expect(() => d.prepare("DELETE FROM cancellations").run()).toThrow(/append_only/);
    expect(() => d.prepare("UPDATE survey_registry_log SET kind = 'x'").run()).toThrow(/append_only/);
    expect((await call(person("admin"), "POST", `/${id}/open`)).status).toBe(403);
  });

  it("@E2E-37 an admin may cancel anyone's registered survey (with a reason); drafts cannot be cancelled", async () => {
    const t = party("TDP");
    const dr = await create(t);
    expect((await call(t, "POST", `/${dr}/cancel`, { reason_code: "duplicate", reason_text: "This is a duplicate survey." })).status).toBe(409);
    await submit(t, dr);
    expect((await call(person("admin"), "POST", `/${dr}/cancel`, { reason_code: "legal_advice", reason_text: "Withdrawn after legal advice was received." })).status).toBe(200);
    expect((await call(person("moderator"), "POST", `/${dr}/cancel`, { reason_code: "other", reason_text: "A moderator cannot cancel" })).status).toBe(403);
  });

  it("@E2E-37 open only when approved and inside the window; manual close; the job closes at closes_at", async () => {
    const t = party("TDP");
    const id = await create(t, draft({ opens_at: new Date(clock.getTime() + DAY).toISOString(), closes_at: new Date(clock.getTime() + 3 * DAY).toISOString() }));
    expect((await call(t, "POST", `/${id}/open`)).status).toBe(409); // draft
    await submit(t, id);
    expect((await call(t, "POST", `/${id}/open`)).body.code).toBe("not_approved");
    await approve(id);
    expect((await call(t, "POST", `/${id}/open`)).body.code).toBe("not_yet_open");
    expect((await call(party("YSRCP"), "POST", `/${id}/open`)).status).toBe(403);
    tick(DAY);
    const o = await call(t, "POST", `/${id}/open`);
    expect(o.status).toBe(200);
    expect(o.body.status).toBe("open");
    tick(2 * DAY - 1);
    expect(closeDueSurveys(registryNow())).toEqual({ closed: 0, expired: 0 });
    tick(1); // exactly closes_at
    expect(closeDueSurveys(registryNow())).toEqual({ closed: 1, expired: 0 });
    expect(closeDueSurveys(registryNow())).toEqual({ closed: 0, expired: 0 });
    expect(getSurvey(id)!.status).toBe("closed");
    const log = (await call(null, "GET", "/registry/log")).body.entries.map((e: any) => e.kind);
    expect(log.slice(-2)).toEqual(["opened", "closed"]);
    const id2 = await approved(t, draft({ title_en: "Second water survey in the village" }));
    tick(DAY);
    await call(t, "POST", `/${id2}/open`);
    expect((await call(t, "POST", `/${id2}/close`)).body.status).toBe("closed");
    expect((await call(t, "POST", `/${id2}/close`)).status).toBe(409);
    // an approved survey whose window passes unopened expires
    const id3 = await approved(t, draft({ title_en: "Third water survey in the village", opens_at: clock.toISOString(), closes_at: new Date(clock.getTime() + DAY).toISOString() }));
    tick(2 * DAY);
    expect(closeDueSurveys(registryNow())).toEqual({ closed: 0, expired: 1 });
    expect(getSurvey(id3)!.status).toBe("closed");
    expect(verifyAuditChain().ok).toBe(true);
  });
});

describe("election-choice surveys: off by default, fail closed (S-34)", () => {
  it("@E2E-43 creation is 403 election_choice_disabled by default, with the flag down, and when the calendar is unknown or blackout", async () => {
    const t = party("TDP");
    // flag down (default) even though the calendar says open
    process.env.ELECTION_CALENDAR_FILE = calendar([MCC]);
    const r0 = await call(t, "POST", "", electionDraft());
    expect(r0.status).toBe(403);
    expect(r0.body.code).toBe("election_choice_disabled");
    expect(r0.body.reason).toBe("flag_off");
    // a political survey that ASKS for party preference is the same class
    const r1 = await call(t, "POST", "", political({ questions: [{ kind: "single", text_en: "Which party do you prefer in your area?", text_te: "తెలుగు", options: [opt("A"), opt("B"), opt("Prefer not to say", "చెప్పడానికి ఇష్టపడను", true)] }] }));
    expect(r1.status).toBe(403);
    const r1b = await call(t, "POST", "", political({ asks_party_preference: true }));
    expect(r1b.body.code).toBe("election_choice_disabled");
    // flag up, calendar missing or unreadable: unknown fails closed
    process.env.CIVIC_ELECTION_CHOICE_SURVEYS = "1";
    process.env.ELECTION_CALENDAR_FILE = path.join(os.tmpdir(), "no-such-calendar-" + randomUUID() + ".json");
    const r2 = await call(t, "POST", "", electionDraft());
    expect(r2.status).toBe(403);
    expect(r2.body.reason).toBe("unknown");
    // flag up, calendar covers the date but it is inside a verified blackout
    process.env.ELECTION_CALENDAR_FILE = calendar([{ ...MCC, mccStart: "2026-11-30T00:00:00Z", end: "2026-12-20T00:00:00Z" }]);
    const r3 = await call(t, "POST", "", electionDraft());
    expect(r3.status).toBe(403);
    expect(r3.body.reason).toBe("blackout");
    // an unverified entry never opens or closes anything: flag up + covered + no verified blackout = open
    process.env.ELECTION_CALENDAR_FILE = calendar([{ ...MCC, mccStart: "2026-11-30T00:00:00Z", verified: false }]);
    expect((await call(t, "POST", "", electionDraft())).status).toBe(201);
    // issue and service surveys are never affected by the flag
    delete process.env.CIVIC_ELECTION_CHOICE_SURVEYS;
    expect((await call(t, "POST", "", draft())).status).toBe(201);
  });

  it("@E2E-43 a different state's blackout does not affect an open state; FORECAST_BLACKOUT=1 forces blackout", async () => {
    const t = party("TDP");
    process.env.CIVIC_ELECTION_CHOICE_SURVEYS = "1";
    process.env.ELECTION_CALENDAR_FILE = calendar([{ ...MCC, state: "TS", mccStart: "2026-11-30T00:00:00Z" }]);
    expect((await call(t, "POST", "", electionDraft())).status).toBe(201); // AP is open
    expect((await call(t, "POST", "", electionDraft({ scope: { state: "TS", units: {} } }))).status).toBe(403);
    process.env.FORECAST_BLACKOUT = "1";
    expect((await call(t, "POST", "", electionDraft())).body.reason).toBe("blackout");
  });

  it("@E2E-43 an open election-choice survey auto-hides in blackout/unknown (registry says why) and cannot be opened or answered; boundary instants", async () => {
    const t = party("TDP");
    process.env.CIVIC_ELECTION_CHOICE_SURVEYS = "1";
    process.env.ELECTION_CALENDAR_FILE = calendar([MCC]); // blackout [2026-12-10T00:00Z, 2026-12-20T00:00Z)
    const id = await approved(t, electionDraft({ closes_at: new Date("2027-01-15T00:00:00Z").toISOString() }));
    const plain = await approved(t, draft({ title_en: "Water supply, always visible" }));
    expect((await call(t, "POST", `/${id}/open`)).status).toBe(200);
    await call(t, "POST", `/${plain}/open`);
    const seen = async () => (await call(null, "GET", "")).body.surveys.map((s: any) => s.id);
    expect(await seen()).toEqual(expect.arrayContaining([id, plain]));
    expect(getSurvey(id)!.election_choice).toBe(1);

    // one millisecond before the blackout starts: still visible
    clock = new Date(Date.parse(MCC.mccStart) - 1);
    expect(await seen()).toContain(id);
    expect((await call(null, "GET", `/${id}`)).body.hidden_reason).toBeNull();
    // exactly mccStart: hidden
    clock = new Date(Date.parse(MCC.mccStart));
    expect(await seen()).not.toContain(id);
    expect(await seen()).toContain(plain);
    const hiddenList = (await call(null, "GET", "?include_hidden=1")).body.surveys.find((s: any) => s.id === id);
    expect(hiddenList.hidden_reason).toBe("election_window");
    const det = (await call(null, "GET", `/${id}`)).body;
    expect(det.hidden_reason).toBe("election_window");
    expect(det.questions).toEqual([]);
    expect(det.disclaimer_en).toBe("Opinion survey, not an election and not a forecast");
    expect(figuresPublishable(getSurvey(id)!, clock)).toEqual({ ok: false, reason: "election_window" });
    expect(figuresPublishable(getSurvey(plain)!, clock).ok).toBe(true);
    expect((await call(null, "GET", `/${id}/versions/1`)).status).toBe(404);
    // the response module's lookup reports a hold, so it cannot be answered
    const { getSurveyForResponse } = await import("../../../server/civic/surveys/source");
    expect(getSurveyForResponse(id)!.status).toBe("election_window_hold");
    expect(getSurveyForResponse(plain)!.status).toBe("open");
    // last millisecond of the blackout: still hidden; exactly `end`: visible again
    clock = new Date(Date.parse(MCC.end) - 1);
    expect(await seen()).not.toContain(id);
    clock = new Date(Date.parse(MCC.end));
    expect(await seen()).toContain(id);
    expect(figuresPublishable(getSurvey(id)!, clock).ok).toBe(true);
    // unknown (outside the calendar's coverage) hides too
    clock = new Date("2028-02-01T00:00:00Z");
    expect(await seen()).not.toContain(id);
    // flag down hides as well, even in an open window
    clock = new Date("2026-12-25T00:00:00Z");
    expect(await seen()).toContain(id);
    delete process.env.CIVIC_ELECTION_CHOICE_SURVEYS;
    expect(await seen()).not.toContain(id);
    expect((await call(null, "GET", `/${id}`)).body.hidden_reason).toBe("election_window");
    // closed surveys of the class stay visible (history), cancellation is always visible
    process.env.CIVIC_ELECTION_CHOICE_SURVEYS = "1";
    expect((await call(t, "POST", `/${id}/close`)).status).toBe(200);
    delete process.env.CIVIC_ELECTION_CHOICE_SURVEYS;
    expect(await seen()).toContain(id);
  });

  it("@E2E-43 an approved election-choice survey cannot be opened in blackout or unknown, and opens in an open window", async () => {
    const t = party("TDP");
    process.env.CIVIC_ELECTION_CHOICE_SURVEYS = "1";
    process.env.ELECTION_CALENDAR_FILE = calendar([MCC]);
    const id = await approved(t, electionDraft({ closes_at: new Date("2027-01-15T00:00:00Z").toISOString() }));
    clock = new Date(MCC.mccStart);
    const b = await call(t, "POST", `/${id}/open`);
    expect(b.status).toBe(403);
    expect(b.body).toMatchObject({ code: "election_choice_disabled", reason: "blackout" });
    clock = new Date("2028-03-01T00:00:00Z"); // unknown, and past closes_at
    process.env.ELECTION_CALENDAR_FILE = calendar([]);
    clock = new Date("2026-12-26T00:00:00Z");
    process.env.ELECTION_CALENDAR_FILE = path.join(os.tmpdir(), "missing-" + randomUUID() + ".json");
    expect((await call(t, "POST", `/${id}/open`)).body.reason).toBe("unknown");
    delete process.env.ELECTION_CALENDAR_FILE;
    process.env.ELECTION_CALENDAR_FILE = calendar([MCC]);
    expect((await call(t, "POST", `/${id}/open`)).status).toBe(200);
  });

  it("@E2E-43 election-choice counts against the political quota and is audited without wording", async () => {
    const t = party("TDP");
    process.env.CIVIC_ELECTION_CHOICE_SURVEYS = "1";
    process.env.ELECTION_CALENDAR_FILE = calendar([MCC]);
    for (let i = 0; i < 2; i++) { const id = await create(t, electionDraft({ title_en: `Preference survey number ${i}` })); expect((await submit(t, id)).status).toBe(200); }
    expect((await submit(t, await create(t, political()))).status).toBe(429);
    const acts = (getStore("audit").prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'survey.%'").all() as { action: string; meta: string }[]);
    expect(acts.some((a) => a.action === "survey.create")).toBe(true);
    expect(acts.map((a) => a.meta).join("")).not.toMatch(/Which party/);
  });
});
