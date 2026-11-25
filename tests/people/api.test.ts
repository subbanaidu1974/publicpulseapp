import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApiRouter } from "../../server/api";
import type { Datasets } from "../../server/api";
import { resetPeopleDbFlag } from "../../server/people-api";
import { createSession, grantRole, migrate, resetDbForTests } from "../../server/civic/core";
import { createPerson } from "../../server/civic/identity/service";
import type { CandidateResult } from "../../src/lib/elections";

const rows = (JSON.parse(readFileSync(resolve(__dirname, "../../data/generated/elections.json"), "utf8")) as { results: CandidateResult[] }).results;
const data: Datasets = { elections: rows, census: [], demo: false, status: [] };

let server: Server, base = "", adminToken = "";
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as any }; };
const post = async (p: string, body: unknown, token?: string) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  process.env.PEOPLE_BLACKOUT = "0";
  process.env.PEOPLE_REQUEST_BURST = "50";
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createApiRouter(data));
  server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => { server.close(); delete process.env.PEOPLE_BLACKOUT; });
beforeEach(() => {
  resetDbForTests(); resetPeopleDbFlag(); migrate();
  const p = createPerson({ phone: "+919876543210", pin: "4821", label: "admin", consentVersion: "t" });
  grantRole("system", p.id, "admin");
  adminToken = createSession(p.id);
});

describe("@E2E-122 office holders", () => {
  it("every record has role, person, party, start date, >=2 source URLs, asOf and confidence", async () => {
    const { body } = await get("/office-holders");
    expect(body.officeHolders.length).toBeGreaterThanOrEqual(16);
    for (const o of body.officeHolders) {
      expect(o.role && o.person && o.party && /^\d{4}-\d{2}-\d{2}$/.test(o.start) && o.asOf && o.confidence).toBeTruthy();
      expect(o.sources.length).toBeGreaterThanOrEqual(2);
      for (const u of o.sources) expect(u).toMatch(/^https:\/\//);
    }
    const names = body.officeHolders.map((o: any) => `${o.state}:${o.role}:${o.person}`);
    expect(names).toContain("AP:Chief Minister:N. Chandrababu Naidu");
    expect(names).toContain("TG:Chief Minister:A. Revanth Reddy");
    expect(names).toContain("TG:Deputy Speaker of the Legislative Assembly:Jatoth Ram Chander Naik");
    const ids = body.officeHolders.map((o: any) => o.id);
    for (const id of ["YSRCP-president", "BRS-president", "INC-AP-president", "INC-TG-president", "BJP-AP-president", "BJP-TG-president", "AIMIM-president"]) expect(ids).toContain(id);
  });
  it("council of ministers: every minister has a state, party, start date, portfolio list, 2 distinct https sources, asOf and confidence", async () => {
    const { body } = await get("/office-holders");
    const mins = body.officeHolders.filter((o: any) => o.role === "Minister");
    expect(mins.filter((o: any) => o.state === "AP").length).toBeGreaterThanOrEqual(20);
    expect(mins.filter((o: any) => o.state === "TG").length).toBeGreaterThanOrEqual(12);
    for (const o of mins) {
      expect(["AP", "TG"]).toContain(o.state);
      expect(Array.isArray(o.portfolio) && o.portfolio.length > 0 && o.portfolio.every((x: string) => x.trim().length > 0)).toBe(true);
      expect(o.portfolioAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Set(o.sources).size).toBeGreaterThanOrEqual(2);
      expect(["high", "medium", "low", "unverified"]).toContain(o.confidence);
      if (o.wikidata !== null) expect(o.wikidata).toMatch(/^Q\d+$/);
      if (o.constituency !== undefined) expect(o.constituency.trim().length).toBeGreaterThan(0);
    }
    const ids = new Set(body.officeHolders.map((o: any) => o.id));
    expect(ids.size).toBe(body.officeHolders.length);
    const names = mins.map((o: any) => `${o.state}:${o.person}`);
    expect(names).toContain("AP:Nara Lokesh");
    expect(names).toContain("TG:Duddilla Sridhar Babu");
    expect(names).not.toContain("TG:Konda Surekha"); // dropped from the council on 2026-09-03
  });
  it("every record's wikidata id is well formed and never shared by two different people", async () => {
    const { body } = await get("/office-holders");
    const byQid = new Map<string, Set<string>>();
    for (const o of body.officeHolders) if (o.wikidata) { expect(o.wikidata).toMatch(/^Q\d+$/); (byQid.get(o.wikidata) ?? byQid.set(o.wikidata, new Set()).get(o.wikidata)!).add(o.person); }
    for (const [, people] of byQid) expect(people.size).toBe(1);
  });
  it("publishes no biography, family, caste, contact or date-of-birth fields", async () => {
    const { body } = await get("/office-holders");
    const keys = new Set(body.officeHolders.flatMap((o: any) => Object.keys(o)));
    for (const bad of ["dob", "birth", "family", "caste", "religion", "phone", "email", "address", "bio"]) expect([...keys].some(k => String(k).toLowerCase().includes(bad))).toBe(false);
  });
});

describe("@E2E-123 members roster", () => {
  it("lists a member for every seat and applies only confirmed overlay changes (Jubilee Hills by-election)", async () => {
    const tg = await get("/members/TG?type=assembly");
    expect(tg.status).toBe(200);
    expect(tg.body.members).toHaveLength(119);
    const jh = tg.body.members.find((m: any) => m.acName === "JUBILEE HILLS");
    expect(jh.member.name).toBe("Naveen Yadav");
    expect(jh.member.party.code).toBe("INC");
    expect(jh.member.basis).toBe("overlay");
    expect(jh.notes.length).toBeGreaterThanOrEqual(2);
    for (const n of jh.notes) expect(n.sources.length).toBeGreaterThanOrEqual(1);
    expect(jh.photo).toBeNull(); // the matched photo is of the previous member and must not carry over
    const ap = await get("/members/AP");
    expect(ap.body.members).toHaveLength(175);
    expect((await get("/members/AP?type=ls")).body.members).toHaveLength(25);
  });
  it("single-seat endpoint and validation", async () => {
    expect((await get("/members/TG/assembly/61")).body.member.name).toBe("Naveen Yadav");
    expect((await get("/members/XX")).status).toBe(404);
    expect((await get("/members/AP?type=zz")).status).toBe(400);
    expect((await get("/members/AP/assembly/9999")).status).toBe(404);
  });
});

describe("@E2E-124 contestant profile", () => {
  it("searches by name alphabetically and returns a fixed-shape profile without turncoat or criminal-case fields", async () => {
    const s = await get("/contestants?q=revanth&state=TG");
    expect(s.status).toBe(200);
    expect(s.body.results.length).toBeGreaterThan(0);
    const names = s.body.results.map((r: any) => r.name);
    expect([...names].sort((a: string, b: string) => a.localeCompare(b))).toEqual(names.slice().sort((a: string, b: string) => a.localeCompare(b)));
    const p = await get("/contestants/" + s.body.results[0].id);
    expect(p.status).toBe(200);
    expect(p.body.links.some((l: any) => l.url.startsWith("https://www.myneta.info/search_myneta.php?q="))).toBe(true);
    const txt = JSON.stringify(p.body).toLowerCase();
    for (const bad of ["turncoat", "criminal", "assets", "cases", "rank"]) expect(txt).not.toContain(bad);
    expect(Object.keys(p.body.attributes).sort()).toEqual(["age", "incumbent", "sex"]);
  });
  it("rejects short queries and unknown ids", async () => {
    expect((await get("/contestants?q=a")).status).toBe(400);
    expect((await get("/contestants/AP-assembly-2024-9999-1")).status).toBe(404);
    expect((await get("/contestants/not-an-id")).status).toBe(404);
  });
});

describe("@E2E-121 party profile", () => {
  it("shows seats and vote share per election and alliance kind labels", async () => {
    const { status, body } = await get("/parties/TDP");
    expect(status).toBe(200);
    const ap24 = body.elections.find((e: any) => e.state === "AP" && e.year === 2024 && e.type === "assembly");
    expect(ap24.seatsWon).toBe(135);
    expect(ap24.totalSeats).toBe(175);
    expect(ap24.voteSharePct).toBeGreaterThan(30);
    expect(ap24.alliances.length).toBeGreaterThan(0);
    for (const a of ap24.alliances) expect(["pre-poll", "post-hoc"]).toContain(a.kind);
    expect(body.wikidata.url).toContain("wikidata.org");
    expect(body.leaders.some((l: any) => l.person === "N. Chandrababu Naidu")).toBe(true);
    expect((await get("/parties/NOPE")).status).toBe(404);
  });
});

describe("@E2E-128 correction and takedown channel", () => {
  it("accepts a request without login, honours the honeypot, rate limits, and hides a photo immediately", async () => {
    const hp = await post("/people/requests", { reason: "spam spam spam spam", page: "/x", website: "http://bot" });
    expect(hp.status).toBe(202);
    expect((await post("/people/requests", { reason: "short", page: "/x" })).status).toBe(400);
    const before = (await get("/members/TG?type=assembly")).body.members.find((m: any) => m.acNo === 114);
    const key = "TG-assembly-" + before.acNo;
    const r = await post("/people/requests", { kind: "takedown", page: "/people/member/TG/assembly/114", targetKind: "photo", targetKey: key, reason: "Please remove this photo of me.", contact: "me@example.com" });
    expect(r.status).toBe(201);
    expect(r.body.slaDays).toBe(7);
    expect(r.body.hiddenPendingReview).toBe(true);
    const after = (await get("/members/TG?type=assembly")).body.members.find((m: any) => m.acNo === 114);
    expect(after.photo).toBeNull();
  });
  it("limits bursts from one address", async () => {
    process.env.PEOPLE_REQUEST_BURST = "3";
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter(data));
    const s = app.listen(0, "127.0.0.1");
    await new Promise(r => s.once("listening", r));
    process.env.PEOPLE_REQUEST_BURST = "50";
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1/people/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: "/p", reason: "a long enough reason " + i }) });
        codes.push(r.status);
      }
      expect(codes.slice(0, 3)).toEqual([201, 201, 201]);
      expect(codes).toContain(429);
    } finally { s.close(); }
  });
  it("admin list/resolve require the admin role; contact is not exposed publicly and takedown can be lifted", async () => {
    expect((await get("/people/admin/requests")).status).toBe(401);
    const key = "TG-assembly-72";
    const r = await post("/people/requests", { kind: "takedown", page: "/p", targetKind: "photo", targetKey: key, reason: "Remove it please now.", contact: "a@b.example" });
    expect(r.status).toBe(201);
    const list = await fetch(base + "/people/admin/requests", { headers: { authorization: `Bearer ${adminToken}` } }).then(x => x.json() as any);
    expect(list.requests[0].contact).toBe("a@b.example");
    expect(list.requests[0].contact_enc).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("a@b.example");
    const res = await post(`/people/admin/requests/${r.body.id}/resolve`, { status: "rejected", hide: false, resolution: "not the person" }, adminToken);
    expect(res.status).toBe(200);
    const t = await post("/people/admin/takedowns", { kind: "field", key: "TG-assembly-2023-1-1#age", active: true }, adminToken);
    expect(t.status).toBe(200);
    const bad = await post("/people/admin/takedowns", { kind: "nope", key: "x" }, adminToken);
    expect(bad.status).toBe(400);
  });
});

describe("@E2E-129 blackout", () => {
  it("hides photos and leader pages and shows a neutral notice when PEOPLE_BLACKOUT=1", async () => {
    process.env.PEOPLE_BLACKOUT = "1";
    try {
      const o = await get("/office-holders");
      expect(o.body.officeHolders).toEqual([]);
      expect(o.body.notice.en).toMatch(/neutral/i);
      const m = await get("/members/TG?type=assembly");
      expect(m.body.members.every((x: any) => x.photo === null)).toBe(true);
      expect((await get("/parties/TDP")).body.leaders).toEqual([]);
      expect((await get("/people/status")).body.blackout).toBe(true);
    } finally { process.env.PEOPLE_BLACKOUT = "0"; }
  });
});

describe("@E2E-122 Telugu portfolio names (S-107)", () => {
  it("every portfolio in the office-holder file has a Telugu name, and the file says whether it was reviewed", async () => {
    const fs = await import("node:fs");
    const oh = JSON.parse(fs.readFileSync("data/reference/people/office-holders.json", "utf8")).records as { portfolio?: string[] }[];
    const te = JSON.parse(fs.readFileSync("data/reference/people/portfolio-te.json", "utf8")) as { reviewed: boolean; terms: Record<string, string> };
    expect(typeof te.reviewed).toBe("boolean");
    const used = new Set(oh.flatMap(r => r.portfolio ?? []));
    for (const t of used) expect(te.terms[t], `missing Telugu name for "${t}"`).toMatch(/[\u0C00-\u0C7F]/);
    expect(Object.keys(te.terms).filter(k => !used.has(k))).toEqual([]);
  });
});
