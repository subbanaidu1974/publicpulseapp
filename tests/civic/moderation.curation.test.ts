import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getDb, grantRole as grantCoreRole, migrate, resetDbForTests, verifyAuditChain, getStore } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createPerson } from "../../server/civic/identity/service";
import { createIssuesRouter } from "../../server/civic/issues/routes";
import { clock, grantRole } from "../../server/civic/issues/service";
import { assessText, loadLexicon, resetLexiconCache } from "../../server/civic/issues/moderation";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "civic-lex-"));
const lexFile = path.join(tmp, "lexicon.json");
process.env.CIVIC_LEXICON_FILE = lexFile;

let server: Server, base: string;
const T0 = new Date("2026-03-01T10:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);

async function call(method: string, p: string, who?: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(who ? { "x-person": who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, text };
}
const report = (who: string, b: object) => call("POST", "/", who, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply", ...b });
const audits = (action: string) => getStore("audit").prepare("SELECT * FROM audit_log WHERE action=?").all(action) as any[];
const HELD = (n: string) => ({ description_en: `Mr Ramesh Kumar took a bribe ${n}` });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/issues", createIssuesRouter((req, res, next) => {
    const p = req.header("x-person");
    if (!p) return void res.status(401).json({ error: "auth" });
    req.person = { id: p, tier: "T1" }; next();
  }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/issues`;
});
afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  fs.copyFileSync(path.resolve("data/civic/moderation-lexicon.json"), lexFile);
  resetLexiconCache();
  resetDbForTests(); migrate(); loadDemoGeo();
  clock.now = () => T0;
  grantRole("mod-1", "moderator", null, null, "Moderator 1");
  grantRole("mod-2", "moderator", null, null, "Moderator 2");
  grantRole("mod-3", "moderator", null, null, "Moderator 3");
});

describe("held queue and decisions (S-142)", () => {
  it("@E2E-157 the queue is moderator-only, lists rule-id reasons and never the reporter", async () => {
    const h = await report("reporter-9", HELD("a"));
    expect(h.body.held).toBe(true);
    expect((await call("GET", "/moderation/queue")).status).toBe(401);
    expect((await call("GET", "/moderation/queue", "citizen")).status).toBe(403);
    expect((await call("GET", "/moderation/metrics", "citizen")).status).toBe(403);
    const q = await call("GET", "/moderation/queue", "mod-1");
    expect(q.status).toBe(200);
    expect(q.body.items).toHaveLength(1);
    expect(q.body.items[0].id).toBe(h.body.id);
    expect(q.body.items[0].reasons.length).toBeGreaterThan(0);
    expect(q.body.items[0].reasons.every((r: string) => /^[a-z_]+$/.test(r))).toBe(true);
    expect(q.text).not.toContain("reporter-9");
    expect(audits("read.sensitive").length).toBe(1);
  });

  it("@E2E-157 approve, reject and escalate are audited; escalated items need an admin", async () => {
    const a = (await report("r1", HELD("one"))).body.id;
    const b = (await report("r2", { ...HELD("two"), category: "roads" })).body.id;
    const c = (await report("r3", { ...HELD("three"), category: "health" })).body.id;
    expect((await call("POST", `/${a}/moderate`, "citizen", { decision: "approve" })).status).toBe(403);
    expect((await call("POST", `/${a}/moderate`, "mod-1", { decision: "approve", note: "false positive" })).body).toMatchObject({ decision: "release" });
    expect((await call("GET", `/${a}`)).status).toBe(200); // visible now
    expect((await call("POST", `/${b}/moderate`, "mod-1", { decision: "reject" })).body.decision).toBe("takedown");
    expect((await call("POST", `/${c}/moderate`, "mod-1", { decision: "escalate" })).body.decision).toBe("escalate");
    expect(audits("issue.release")).toHaveLength(1);
    expect(audits("issue.takedown")).toHaveLength(1);
    expect(audits("issue.moderation_escalate")).toHaveLength(1);
    const esc = await call("GET", "/moderation/queue?status=escalated", "mod-1");
    expect(esc.body.items.map((i: any) => i.id)).toEqual([c]);
    expect(esc.body.items[0].escalated).toBe(true);
    // a plain moderator cannot decide an escalated item; an admin can
    expect((await call("POST", `/${c}/moderate`, "mod-2", { decision: "approve" })).status).toBe(403);
    const admin = createPerson({ phone: "+919876511111", pin: "4821", consentVersion: "v1" });
    grantCoreRole("system", admin.id, "admin");
    expect((await call("POST", `/${c}/moderate`, admin.id, { decision: "reject" })).body.decision).toBe("takedown");
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM moderation_action").get()).toMatchObject({ c: 4 });
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("@E2E-157 metrics: hold rate, false-positive rate and appeal turnaround", async () => {
    await report("r0", { description_en: "Broken tap near school gate" });
    const a = (await report("r1", HELD("one"))).body.id;
    const b = (await report("r2", { ...HELD("two"), category: "roads" })).body.id;
    await report("r3", { description_en: "Street light out", category: "electricity" });
    await call("POST", `/${a}/appeal`, "r1", { reason: "this is about the post, not a person" });
    clock.now = () => at(5);
    await call("POST", `/${a}/moderate`, "mod-1", { decision: "approve" });
    await call("POST", `/${b}/moderate`, "mod-1", { decision: "reject" });
    const m = (await call("GET", "/moderation/metrics", "mod-1")).body;
    expect(m).toMatchObject({ reports: 4, held: 2, hold_rate: 0.5, approved_after_hold: 1, rejected_after_hold: 1, false_positive_rate: 0.5, still_waiting: 0 });
    expect(m.appeals).toMatchObject({ total: 1, decided: 1, pending: 0, mean_turnaround_hours: 5, median_turnaround_hours: 5 });
    expect(Object.keys(m.held_by_rule).length).toBeGreaterThan(0);
    expect(m.lexicon_version).toBe(1);
  });
});

describe("lexicon curation (S-142)", () => {
  const term = "zorbleflax";
  const probe = (t = term) => assessText(`The ${t} situation at the pump is bad`, { lexicon: loadLexicon() });

  it("@E2E-157 the lexicon carries a version and changelog", async () => {
    const lx = loadLexicon();
    expect(lx.version).toBe(1);
    expect(lx.changelog?.[0]).toMatchObject({ version: 1, op: "initial" });
    const info = await call("GET", "/moderation/lexicon", "mod-1");
    expect(info.body).toMatchObject({ version: 1, approvals_needed: { add: 1, retire: 2 } });
    expect(info.body.lists).toContain("abuse.en");
    expect((await call("GET", "/moderation/lexicon", "citizen")).status).toBe(403);
  });

  it("@E2E-157 adding a term needs an independent reviewer, bumps the version, writes the changelog and changes moderation", async () => {
    expect(probe().verdict).toBe("ok");
    const p = await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "add", list: "abuse.en", term, note: "seen in reports" });
    expect(p.status).toBe(201);
    expect(probe().verdict).toBe("ok"); // a proposal changes nothing
    expect((await call("POST", `/moderation/lexicon/changes/${p.body.id}/review`, "mod-1", { decision: "approve" })).status).toBe(403); // not your own
    expect((await call("POST", "/moderation/lexicon/changes", "mod-2", { op: "add", list: "abuse.en", term })).status).toBe(409); // identical pending
    const done = await call("POST", `/moderation/lexicon/changes/${p.body.id}/review`, "mod-2", { decision: "approve" });
    expect(done.body).toMatchObject({ status: "applied", version: 2 });
    const lx = loadLexicon();
    expect(lx.version).toBe(2);
    expect(lx.abuse.en).toContain(term);
    expect(lx.changelog?.at(-1)).toMatchObject({ version: 2, op: "add", list: "abuse.en", term, approvals: 1 });
    expect(JSON.stringify(lx.changelog)).not.toMatch(/mod-1|mod-2/); // counts only, no person ids
    resetLexiconCache();
    const held = await report("r1", { description_en: `The ${term} situation at the pump is bad` });
    expect(held.body.held).toBe(true);
    expect(audits("lexicon.propose")).toHaveLength(1);
    expect(audits("lexicon.apply")).toHaveLength(1);
    expect((await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "add", list: "abuse.en", term })).status).toBe(409); // already present
  });

  it("@E2E-157 retiring a term is two-person: two distinct approvers other than the proposer", async () => {
    const seed = await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "add", list: "abuse.en", term });
    await call("POST", `/moderation/lexicon/changes/${seed.body.id}/review`, "mod-2", { decision: "approve" });
    const p = await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "retire", list: "abuse.en", term, note: "false positives on a place name" });
    expect(p.body.approvals_needed).toBe(2);
    const first = await call("POST", `/moderation/lexicon/changes/${p.body.id}/review`, "mod-2", { decision: "approve" });
    expect(first.body).toMatchObject({ status: "pending", approvals: 1 });
    expect(probe().verdict).toBe("hold"); // not retired yet
    expect((await call("POST", `/moderation/lexicon/changes/${p.body.id}/review`, "mod-2", { decision: "approve" })).status).toBe(409); // same person twice
    const second = await call("POST", `/moderation/lexicon/changes/${p.body.id}/review`, "mod-3", { decision: "approve" });
    expect(second.body).toMatchObject({ status: "applied", version: 3 });
    expect(probe().verdict).toBe("ok");
    expect(loadLexicon().changelog?.at(-1)).toMatchObject({ version: 3, op: "retire", approvals: 2 });
    expect((await call("POST", `/moderation/lexicon/changes/${p.body.id}/review`, "mod-3", { decision: "approve" })).status).toBe(409); // closed
  });

  it("@E2E-157 one rejection closes a proposal; bad input is refused", async () => {
    const p = await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "add", list: "abuse.en", term: "plainword" });
    expect((await call("POST", `/moderation/lexicon/changes/${p.body.id}/review`, "mod-2", { decision: "reject" })).body.status).toBe("rejected");
    expect(loadLexicon().abuse.en).not.toContain("plainword");
    expect((await call("GET", "/moderation/lexicon/changes?status=rejected", "mod-3")).body.items).toHaveLength(1);
    expect((await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "add", list: "nope.en", term: "word" })).status).toBe(400);
    expect((await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "add", list: "abuse.en", term: "x" })).status).toBe(400);
    expect((await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "add", list: "abuse.en", term: "9876543210" })).status).toBe(400);
    expect((await call("POST", "/moderation/lexicon/changes", "mod-1", { op: "retire", list: "abuse.en", term: "notpresentatall" })).status).toBe(404);
    expect((await call("POST", "/moderation/lexicon/changes", "citizen", { op: "add", list: "abuse.en", term: "word2" })).status).toBe(403);
  });
});
