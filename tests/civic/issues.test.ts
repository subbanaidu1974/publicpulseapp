import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getDb, migrate, resetDbForTests } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createIssuesRouter, issuesRouter } from "../../server/civic/issues/routes";
import { clock, grantRole, sweep, CONFIRM_WINDOW_HOURS, ME_TOO_PER_DAY } from "../../server/civic/issues/service";

let server: Server, base: string, realBase: string, server2: Server;
const T0 = new Date("2026-03-01T10:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);

async function call(method: string, p: string, who?: string, body?: unknown) {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", ...(who ? { "x-person": who } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
const report = (who: string, b: object) => call("POST", "/", who, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply", ...b });
const audits = (action: string) => (getDb().prepare("SELECT * FROM audit_log WHERE action=?").all(action) as any[]);

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
  const app2 = express(); app2.use(express.json()); app2.use("/issues", issuesRouter);
  server2 = app2.listen(0);
  realBase = `http://127.0.0.1:${(server2.address() as AddressInfo).port}/issues`;
});
afterAll(() => { server.close(); server2.close(); });
beforeEach(() => {
  resetDbForTests(); migrate(); loadDemoGeo();
  clock.now = () => T0;
  grantRole("off-kolluru", "officer", "Rural Water Supply", "DEMO-M-KLP", "RWS Kolluru");
  grantRole("off-roads", "officer", "Roads and Buildings", "DEMO-D-GNT", "R&B Guntur");
  grantRole("off-district", "officer", "Rural Water Supply", "DEMO-D-GNT", "RWS Guntur");
  grantRole("mod-1", "moderator", null, null, "Moderator");
});

describe("report, dedupe, me-too (S-24)", () => {
  it("requires authentication", async () => {
    const r = await fetch(realBase + "/", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });

  it("@E2E-33 reports in Telugu with photo and GPS, merges a nearby similar report, me-too counts once and is rate limited", async () => {
    const a = await report("p1", { description_en: undefined, description_te: "మా వీధిలో తాగునీరు రావడం లేదు", photo_ref: "uploads/abc123.jpg", lat: 16.2400, lon: 80.1500 });
    expect(a.status).toBe(201);
    expect(a.body.merged).toBe(false);
    // ~50 m away, different wording -> merged into the first issue
    const b = await report("p2", { description_en: "Tap water stopped near the temple", lat: 16.2404, lon: 80.1501 });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ merged: true, id: a.body.id, me_too_counted: true });
    // same person again via me-too: not counted twice
    const again = await call("POST", `/${a.body.id}/me-too`, "p2");
    expect(again.body.counted).toBe(false);
    expect(again.body.support).toBe(2);
    // far away (different village) does not merge
    const far = await report("p3", { village_lgd: "DEMO-V-BPL", description_en: "No drinking water supply" });
    expect(far.body.merged).toBe(false);

    // rate limit: one person, ME_TOO_PER_DAY per day
    const cats = ["roads", "electricity", "health", "education", "agriculture", "welfare", "law_order"];
    const ids: string[] = [];
    for (const c of cats) ids.push((await report("p9", { category: c, description_en: `unique issue ${c} zzz${c}` })).body.id);
    let ok = 0, limited = 0;
    for (const id of ids) {
      const r = await call("POST", `/${id}/me-too`, "p5");
      if (r.status === 200 && r.body.counted) ok++;
      if (r.status === 429) limited++;
    }
    expect(ok).toBe(ME_TOO_PER_DAY);
    expect(limited).toBe(cats.length - ME_TOO_PER_DAY);
    // next day the quota resets
    clock.now = () => at(25);
    // (routes read the clock at call time)
    const next = await call("POST", `/${ids[cats.length - 1]}/me-too`, "p5");
    expect(next.status).toBe(200);
  });

  it("validates input", async () => {
    expect((await report("p1", { category: "nope" })).status).toBe(400);
    expect((await report("p1", { village_lgd: "DEMO-M-KLP" })).status).toBe(400);
    expect((await report("p1", { description_en: "  " })).status).toBe(400);
    expect((await report("p1", { lat: 99, lon: 0 })).status).toBe(400);
  });
});

describe("workflow, SLA, confirmation (S-25)", () => {
  async function resolved(reporter = "rep") {
    const a = await report(reporter, { description_en: `Handpump broken ${reporter} unique-${reporter}`, village_lgd: reporter === "rep3" ? "DEMO-V-BPL" : "DEMO-V-KLR" });
    const id = a.body.id as string;
    for (const to of ["Verified", "Assigned", "InProgress", "Resolved"]) {
      const t = await call("POST", `/${id}/transition`, "off-kolluru", { to });
      expect(t.status).toBe(200);
    }
    return id;
  }

  it("@E2E-34 reporter silent past the window: sampled neighbours decide", async () => {
    const a = await report("rep", { description_en: "Handpump broken" });
    const id = a.body.id as string;
    const neighbours = ["n1", "n2", "n3"];
    for (const n of neighbours) await call("POST", `/${id}/me-too`, n);
    // skipping a step is refused
    expect((await call("POST", `/${id}/transition`, "off-kolluru", { to: "Resolved" })).status).toBe(409);
    for (const to of ["Verified", "Assigned", "InProgress", "Resolved"]) await call("POST", `/${id}/transition`, "off-kolluru", { to });
    const sample = (getDb().prepare("SELECT person_id FROM issue_sample WHERE issue_id=?").all(id) as any[]).map(r => r.person_id);
    expect(sample.sort()).toEqual(neighbours);
    // an outsider cannot vote; two neighbours confirm, one says reopen; reporter says nothing
    expect((await call("POST", `/${id}/confirm`, "stranger", { vote: "confirm" })).status).toBe(403);
    await call("POST", `/${id}/confirm`, "n1", { vote: "confirm" });
    await call("POST", `/${id}/confirm`, "n2", { vote: "confirm" });
    await call("POST", `/${id}/confirm`, "n3", { vote: "reopen" });
    expect(sweep(at(CONFIRM_WINDOW_HOURS - 1)).confirmed).toEqual([]); // window still open
    expect(sweep(at(CONFIRM_WINDOW_HOURS + 1)).confirmed).toEqual([id]);
    const row = getDb().prepare("SELECT status, confirm_basis FROM issue WHERE id=?").get(id) as any;
    expect(row).toMatchObject({ status: "Confirmed", confirm_basis: "neighbours" });
    expect(audits("issue.confirmation_closed")).toHaveLength(1);
  });

  it("@E2E-34 a reporter who reopens decides immediately; no votes at all is flagged lapsed, not counted as resolved", async () => {
    const id = await resolved("rep2");
    const r = await call("POST", `/${id}/confirm`, "rep2", { vote: "reopen" });
    expect(r.body.status).toBe("Reopened");
    const id2 = await resolved("rep3");
    sweep(at(CONFIRM_WINDOW_HOURS + 1));
    expect(getDb().prepare("SELECT confirm_basis b FROM issue WHERE id=?").get(id2)).toMatchObject({ b: "lapsed_unverified" });
  });

  it("@E2E-34 out-of-jurisdiction issue is re-routed to the right department", async () => {
    const a = await report("rep", { description_en: "Pothole on road" , category: "roads" });
    const id = a.body.id as string;
    // water officer cannot work a roads issue
    expect((await call("POST", `/${id}/transition`, "off-kolluru", { to: "Verified" })).status).toBe(403);
    // officer outside the village jurisdiction
    grantRole("off-other", "officer", "Roads and Buildings", "DEMO-M-HNK");
    expect((await call("POST", `/${id}/transition`, "off-other", { to: "Verified" })).body.hint).toBe("out_of_jurisdiction");
    // a water issue mis-filed under roads is rerouted by an officer covering the village
    const w = await report("rep", { description_en: "Canal overflow flooding fields", category: "roads" });
    const rr = await call("POST", `/${w.body.id}/transition`, "off-roads", { action: "out_of_jurisdiction", department: "Rural Water Supply" });
    expect(rr.body).toMatchObject({ status: "Verified", department: "Rural Water Supply" });
    expect((await call("POST", `/${w.body.id}/transition`, "off-kolluru", { to: "Assigned" })).status).toBe(200);
    expect(audits("issue.reroute")).toHaveLength(1);
  });

  it("@E2E-34 SLA breach escalates up the hierarchy and is audited", async () => {
    const id = (await report("rep", {})).body.id as string;
    expect(sweep(at(10)).escalated).toEqual([]);
    expect(sweep(at(73)).escalated).toEqual([id]); // water SLA 72h: village -> mandal
    expect(getDb().prepare("SELECT jurisdiction_lgd j FROM issue WHERE id=?").get(id)).toMatchObject({ j: "DEMO-M-KLP" });
    const where = () => getDb().prepare("SELECT jurisdiction_lgd j, esc_level l FROM issue WHERE id=?").get(id);
    sweep(at(73 + 73));
    expect(where()).toMatchObject({ j: "DEMO-D-GNT", l: 2 });
    sweep(at(73 + 146)); // district -> constituency liaison (Kolluru is in Tenali)
    expect(where()).toMatchObject({ j: "DEMO-C-TNL", l: 3 });
    sweep(at(73 + 220)); sweep(at(73 + 300)); sweep(at(73 + 400)); // state, then stays at the top
    expect(where()).toMatchObject({ j: "DEMO-S-AP", l: 4 });
    expect(audits("issue.escalate").length).toBe(4);
    expect(audits("issue.escalate").map((r) => JSON.parse(r.meta).to_level)).toEqual(["mandal", "district", "constituency", "state"]);
    // district-level officer can act on an escalated issue
    expect((await call("POST", `/${id}/transition`, "off-district", { to: "Verified" })).status).toBe(200);
  });
});

describe("metrics, rebuttal, feed (S-26)", () => {
  function bulk(n: number, village: string, dept = "Rural Water Supply", extra: Partial<{ officer: string; status: string }> = {}) {
    const ins = getDb().prepare(`INSERT INTO issue (id,category,desc_en,village_lgd,department,status,moderation,reporter_id,created_at,updated_at,assigned_officer,resolved_at,confirm_basis)
      VALUES (?,?,?,?,?,?,'ok',?,?,?,?,?,?)`);
    for (let i = 0; i < n; i++) {
      const done = extra.status === "Confirmed";
      ins.run(`bulk-${village}-${dept}-${i}-${Math.random()}`, "water", "x", village, dept, extra.status ?? "Reported", `bulk-person-${i}`, T0.toISOString(), T0.toISOString(),
        extra.officer ?? null, done ? at(24).toISOString() : null, done ? "reporter" : null);
    }
  }

  it("@E2E-35 department-level metrics roll small cells up to the parent and mask what stays under 30", async () => {
    bulk(31, "DEMO-V-ANM");                       // published at village level
    bulk(20, "DEMO-V-KLR"); bulk(15, "DEMO-V-BPL"); // each < 30, mandal total 35 -> published at mandal
    bulk(5, "DEMO-V-HNK");                        // 5 in all -> never published
    const m = (await call("GET", "/metrics?level=department")).body;
    const cells = m.cells as any[];
    expect(cells.find(c => c.unit_lgd === "DEMO-V-ANM")).toMatchObject({ unit_level: "village", total: 31, includes_rolled_up: false });
    expect(cells.find(c => c.unit_lgd === "DEMO-M-KLP")).toMatchObject({ unit_level: "mandal", total: 35, includes_rolled_up: true });
    expect(cells.some(c => c.unit_lgd === "DEMO-V-KLR" || c.unit_lgd === "DEMO-V-BPL" || c.unit_lgd === "DEMO-V-HNK")).toBe(false);
    expect(cells.every(c => c.total >= 30)).toBe(true);
    expect(JSON.stringify(m)).not.toContain("bulk-person");
    // default is the department view
    expect((await call("GET", "/metrics")).body.level).toBe("department");
  });

  it("@E2E-35 officer view needs role plus a jurisdiction tag, and carries the rebuttal field", async () => {
    bulk(32, "DEMO-V-KLR", "Rural Water Supply", { officer: "RWS Kolluru", status: "Confirmed" });
    expect((await call("GET", "/metrics?level=officer&jurisdiction=DEMO-M-KLP")).status).toBe(401);
    expect((await call("GET", "/metrics?level=officer&jurisdiction=DEMO-M-KLP", "citizen")).status).toBe(403);
    expect((await call("GET", "/metrics?level=officer", "off-kolluru")).status).toBe(400);
    expect((await call("GET", "/metrics?level=officer&jurisdiction=DEMO-M-HNK", "off-kolluru")).status).toBe(403);
    // officer posts a rebuttal on an issue assigned to them
    const id = (await report("rep", { description_en: "Handpump broken again" })).body.id;
    await call("POST", `/${id}/transition`, "off-kolluru", { to: "Verified" });
    await call("POST", `/${id}/transition`, "off-kolluru", { to: "Assigned" });
    expect((await call("POST", `/${id}/rebuttal`, "citizen", { text: "x" })).status).toBe(403);
    expect((await call("POST", `/${id}/rebuttal`, "off-kolluru", { text: "Spare part delayed by supplier, not by staff." })).status).toBe(201);
    const o = (await call("GET", "/metrics?level=officer&jurisdiction=DEMO-M-KLP", "off-kolluru")).body;
    const row = o.officers.find((x: any) => x.officer_tag === "RWS Kolluru");
    expect(row.jurisdiction.lgd).toBe("DEMO-M-KLP");
    expect(row.rebuttals[0].text).toContain("Spare part");
    expect(row).toHaveProperty("rebuttal_field");
    expect(row.masked).toBe(false); // 33 reports >= 30
    expect(row.resolution_rate).toBeGreaterThan(0.9);
    bulk(4, "DEMO-V-BPL", "Rural Water Supply", { officer: "Small Officer" });
    const o2 = (await call("GET", "/metrics?level=officer&jurisdiction=DEMO-M-KLP", "off-kolluru")).body;
    const small = o2.officers.find((x: any) => x.officer_tag === "Small Officer");
    expect(small.masked).toBe(true);
    expect(small).not.toHaveProperty("total");
  });

  it("@E2E-35 bulk feed is identical for every caller and never exposes reporter identity", async () => {
    const id = (await report("secret-reporter-77", { description_en: "Drain blocked" })).body.id;
    await call("POST", `/${id}/transition`, "off-kolluru", { to: "Verified" });
    const anon = await call("GET", "/feed");
    const citizen = await call("GET", "/feed", "someone");
    const officer = await call("GET", "/feed", "off-kolluru");
    expect(JSON.stringify(citizen.body)).toBe(JSON.stringify(anon.body));
    expect(JSON.stringify(officer.body)).toBe(JSON.stringify(anon.body));
    expect(anon.body.events.length).toBe(2);
    expect(JSON.stringify(anon.body)).not.toContain("secret-reporter-77");
    expect(JSON.stringify(anon.body)).not.toContain("reporter");
    const since = await call("GET", `/feed?since=${anon.body.events[0].seq}`);
    expect(since.body.events).toHaveLength(1);
  });
});

describe("moderation and appeals (S-27)", () => {
  it("@E2E-36 report naming an individual is held, appealable, and takedown is audited", async () => {
    const h = await report("rep", { description_en: "Mr Ramesh the MRO took a bribe for my pension" });
    expect(h.body.held).toBe(true);
    const id = h.body.id as string;
    // held items are invisible publicly and cannot be supported or worked
    expect((await call("GET", "/feed")).body.events).toHaveLength(0);
    expect((await call("POST", `/${id}/me-too`, "other")).status).toBe(404);
    expect((await call("POST", `/${id}/transition`, "off-kolluru", { to: "Verified" })).status).toBe(409);
    // only the reporter can appeal; only a moderator can decide
    expect((await call("POST", `/${id}/appeal`, "other", { reason: "x" })).status).toBe(404);
    const ap = await call("POST", `/${id}/appeal`, "rep", { reason: "I describe the failure, not the person" });
    expect(ap.status).toBe(201);
    expect((await call("POST", `/${id}/appeal`, "rep", {})).status).toBe(409);
    expect((await call("POST", `/${id}/moderate`, "rep", { decision: "release" })).status).toBe(403);
    expect((await call("POST", `/${id}/moderate`, "mod-1", { decision: "release" })).status).toBe(200);
    expect((await call("GET", "/feed")).body.events.map((e: any) => e.type)).toEqual(["reported"]);
    // a second held report is taken down
    const h2 = await report("rep", { category: "roads", description_te: "శ్రీ రాజు గారు రోడ్డు పని చేయలేదు" });
    expect(h2.body.held).toBe(true);
    expect((await call("POST", `/${h2.body.id}/moderate`, "mod-1", { decision: "takedown" })).status).toBe(200);
    expect(audits("issue.takedown")).toHaveLength(1);
    expect(audits("issue.appeal")).toHaveLength(1);
    expect(audits("issue.release")).toHaveLength(1);
    const types = (await call("GET", "/feed")).body.events.map((e: any) => e.type);
    expect(types).toContain("taken_down");
  });
});
