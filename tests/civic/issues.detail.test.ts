import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getDb, migrate, resetDbForTests, getStore } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createIssuesRouter } from "../../server/civic/issues/routes";
import { clock, grantRole, sweep } from "../../server/civic/issues/service";
import { resetExportRate, sanitizeDescription } from "../../server/civic/issues/public";
import { CATEGORY_LIST } from "../../server/civic/issues/categories";

let server: Server, base: string;
const T0 = new Date("2026-03-01T10:00:00Z");

async function call(method: string, p: string, who?: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(who ? { "x-person": who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const report = (who: string, b: object) => call("POST", "/", who, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply", ...b });

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
afterAll(() => { server.close(); });
beforeEach(() => {
  resetDbForTests(); migrate(); loadDemoGeo(); resetExportRate();
  clock.now = () => T0;
  grantRole("off-kolluru", "officer", "Rural Water Supply", "DEMO-M-KLP", "RWS Kolluru");
  grantRole("mod-1", "moderator", null, null, "Moderator");
});

describe("public issue detail, filters, pagination, export (S-139)", () => {
  it("@E2E-154 GET /issues/:id returns the public view: units, timeline, counts, sanitised text, no reporter identity", async () => {
    const a = await report("reporter-secret-id", { description_en: "Pump broken near the temple", lat: 16.24049, lon: 80.15049 });
    await call("POST", `/${a.body.id}/me-too`, "p2");
    await call("POST", `/${a.body.id}/transition`, "off-kolluru", { to: "Verified" });
    const d = await call("GET", `/${a.body.id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      id: a.body.id, category: "water", status: "Verified", department: "Rural Water Supply",
      village: { lgd: "DEMO-V-KLR" }, mandal: { lgd: "DEMO-M-KLP" }, district: { lgd: "DEMO-D-GNT" }, constituency: { lgd: "DEMO-C-TNL" },
      counts: { support: 2 },
    });
    expect(d.body.timeline.map((e: any) => e.type)).toEqual(["reported", "status"]);
    expect(d.body.description_en).toBe("Pump broken near the temple");
    expect(d.text).not.toContain("reporter-secret-id");
    expect(d.text).not.toMatch(/reporter_id|gps_enc/);
    expect(d.headers.get("cache-control")).toMatch(/public/);
    // identical for an anonymous caller and an authenticated one
    const d2 = await call("GET", `/${a.body.id}`, "someone-else");
    expect(d2.text).toBe(d.text);
  });

  it("detail is 404 for unknown and held issues", async () => {
    expect((await call("GET", "/does-not-exist")).status).toBe(404);
    const h = await report("p1", { description_en: "Mr Ramesh Kumar took a bribe" });
    expect(h.body.held).toBe(true);
    expect((await call("GET", `/${h.body.id}`)).status).toBe(404);
  });

  it("sanitizeDescription masks phone, aadhaar-like numbers and e-mail and strips control characters", () => {
    const s = sanitizeDescription("call 9876543210 / +91 98765-43210, id 1234 5678 9012 mail a.b@x.in \u0007ok")!;
    expect(s).not.toMatch(/\d{5}|@/);
    expect(s).toContain("ok");
    expect(s).not.toContain("\u0007");
  });

  it("@E2E-154 feed filters by village, mandal, district and constituency with cursor pagination", async () => {
    const ids: Record<string, string> = {};
    ids.klr = (await report("p1", { description_en: "klr water zzaa" })).body.id;
    ids.bpl = (await report("p2", { village_lgd: "DEMO-V-BPL", category: "roads", description_en: "bpl road pothole qqbb" })).body.id;
    ids.hnk = (await report("p3", { village_lgd: "DEMO-V-HNK", description_en: "hnk water ttcc" })).body.id;
    ids.anm = (await report("p4", { village_lgd: "DEMO-V-ANM", category: "health", description_en: "anm clinic closed uudd" })).body.id;
    const issuesOf = (b: any) => b.events.map((e: any) => e.issue_id).sort();
    const f = async (q: string) => (await call("GET", `/feed?${q}`)).body;
    expect(issuesOf(await f("village=DEMO-V-KLR"))).toEqual([ids.klr]);
    expect(issuesOf(await f("mandal=DEMO-M-KLP"))).toEqual([ids.klr, ids.bpl].sort());
    expect(issuesOf(await f("district=DEMO-D-GNT"))).toEqual([ids.klr, ids.bpl, ids.anm].sort());
    expect(issuesOf(await f("district=DEMO-D-WGL"))).toEqual([ids.hnk]);
    // constituency link data: KLR and BPL are in TNL; BPL is also in PTR; ANM moved to PTR in 2026
    expect(issuesOf(await f("constituency=DEMO-C-TNL"))).toEqual([ids.klr, ids.bpl].sort());
    expect(issuesOf(await f("constituency=DEMO-C-PTR"))).toEqual([ids.bpl, ids.anm].sort());
    expect(issuesOf(await f("district=DEMO-D-GNT&category=roads"))).toEqual([ids.bpl]);
    expect((await call("GET", "/feed?mandal=DEMO-D-GNT")).status).toBe(400); // wrong level
    expect((await call("GET", "/feed?village=nope")).status).toBe(400);

    // cursor pagination: walk two at a time, no duplicates, no gaps
    const seen: number[] = [];
    let cursor: string | number | null = 0, pages = 0;
    while (cursor !== null && pages++ < 10) {
      const p: any = await f(`limit=2&cursor=${cursor}`);
      expect(p.events.length).toBeLessThanOrEqual(2);
      seen.push(...p.events.map((e: any) => e.seq));
      cursor = p.next_cursor;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    const all = (await f("")).events as any[];
    expect(all[0]).toHaveProperty("mandal_lgd");
  });

  it("@E2E-154 list endpoint: filters, newest first, opaque cursor, summaries without reporter", async () => {
    for (let k = 0; k < 5; k++) {
      clock.now = () => new Date(T0.getTime() + k * 60_000);
      await report(`p${k}`, { description_en: ['broken handpump lever', 'sewage overflowing street', 'streetlight dark junction', 'garbage heap burning', 'canal bund breached'][k] });
    }
    clock.now = () => T0;
    const p1 = await call("GET", "/?mandal=DEMO-M-KLP&limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.has_more).toBe(true);
    expect(p1.body.items[0].created_at > p1.body.items[1].created_at).toBe(true);
    const p2 = await call("GET", `/?mandal=DEMO-M-KLP&limit=2&cursor=${p1.body.next_cursor}`);
    const p3 = await call("GET", `/?mandal=DEMO-M-KLP&limit=2&cursor=${p2.body.next_cursor}`);
    expect(p3.body.items).toHaveLength(1);
    expect(p3.body.has_more).toBe(false);
    expect(p3.body.next_cursor).toBeNull();
    const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(5);
    expect(p1.text).not.toMatch(/reporter|"p[0-4]"/);
    expect((await call("GET", "/?cursor=!!!")).status).toBe(400);
  });

  it("@E2E-154 export is NDJSON or CSV, identical for every caller, has no personal fields, and is rate limited", async () => {
    await report("p1", { description_en: "Pump broken near the temple" });
    await report("p2", { village_lgd: "DEMO-V-BPL", category: "roads", description_en: "tarred surface collapsed entirely" });
    const nd = await call("GET", "/export?district=DEMO-D-GNT");
    expect(nd.status).toBe(200);
    expect(nd.headers.get("content-type")).toMatch(/ndjson/);
    const rows = nd.text.trim().split("\n").map(l => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0])).toEqual(["id", "category", "department", "status", "village_lgd", "mandal_lgd", "district_lgd", "constituency_lgd", "created_at", "updated_at", "resolved_at", "support", "esc_level"]);
    expect(nd.text).not.toMatch(/"p1"|"p2"|reporter|desc/);
    const authed = await call("GET", "/export?district=DEMO-D-GNT", "p1");
    expect(authed.text).toBe(nd.text);
    const csv = await call("GET", "/export?format=csv");
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.text.split("\n")[0]).toBe("id,category,department,status,village_lgd,mandal_lgd,district_lgd,constituency_lgd,created_at,updated_at,resolved_at,support,esc_level");
    expect(csv.text.trim().split("\n")).toHaveLength(3);
    process.env.CIVIC_EXPORT_PER_HOUR = "3";
    try {
      const last = await call("GET", "/export");
      expect(last.status).toBe(429);
      expect(last.headers.get("retry-after")).toBeTruthy();
    } finally { delete process.env.CIVIC_EXPORT_PER_HOUR; }
  });

  it("@E2E-154 export continues with X-Next-Cursor when the row cap is hit", async () => {
    for (let k = 0; k < 3; k++) { clock.now = () => new Date(T0.getTime() + k * 1000); await report(`p${k}`, { description_en: ['handpump lever snapped', 'sewage overflowing lane', 'garbage burning daily'][k] }); }
    process.env.CIVIC_EXPORT_MAX_ROWS = "2";
    try {
      const a = await call("GET", "/export");
      expect(a.text.trim().split("\n")).toHaveLength(2);
      const cur = a.headers.get("x-next-cursor")!;
      expect(cur).toBeTruthy();
      const b = await call("GET", `/export?cursor=${cur}`);
      expect(b.text.trim().split("\n")).toHaveLength(1);
      expect(b.headers.get("x-next-cursor")).toBeNull();
    } finally { delete process.env.CIVIC_EXPORT_MAX_ROWS; }
  });
});

describe("categories and trust tiers (S-148)", () => {
  it("@E2E-163 GET /issues/categories lists the nine canonical categories with EN/TE labels, icons and IVR digits, plus trust tiers", async () => {
    const r = await call("GET", "/categories");
    expect(r.status).toBe(200);
    expect(r.body.categories.map((c: any) => c.id)).toEqual(["water", "roads", "electricity", "health", "education", "agriculture", "welfare", "law_order", "other"]);
    for (const c of r.body.categories) {
      expect(c.label_en).toBeTruthy();
      expect(c.label_te).toMatch(/[ఀ-౿]/);
      expect(c.icon).toMatch(/^[a-z-]+$/);
      expect(c.ivr_digit).toMatch(/^[1-9]$/);
    }
    expect(new Set(r.body.categories.map((c: any) => c.ivr_digit)).size).toBe(9);
    expect(r.body.trust_tiers.map((t: any) => t.tier)).toEqual(["T0", "T1", "T2"]);
    expect(r.body.trust_tiers[0].label_te).toMatch(/[ఀ-౿]/);
    // every category is reportable (single source of truth with the workflow)
    for (const c of CATEGORY_LIST) expect((await report(`cat-${c.id}`, { category: c.id, description_en: `issue for ${c.id} zz${c.id}` })).status).toBe(201);
  });
});

describe("GPS rounding policy (S-147)", () => {
  it("@E2E-162 public coordinates are rounded to about 100 m; the exact point is kept encrypted and expires", async () => {
    const a = await report("p1", { lat: 16.240493, lon: 80.150517 });
    const pub = await call("GET", `/${a.body.id}`);
    expect(pub.body.lat).toBe(16.24);
    expect(pub.body.lon).toBe(80.151);
    const row = getStore("issues").prepare("SELECT lat, lon, gps_enc, gps_exact_until FROM issue WHERE id=?").get(a.body.id) as any;
    expect(row.gps_enc).toMatch(/^v1\./);
    expect(row.gps_enc).not.toContain("16.2404");
    expect(row.gps_exact_until).toBe(new Date(T0.getTime() + 30 * 86400_000).toISOString());
    clock.now = () => new Date(T0.getTime() + 31 * 86400_000);
    sweep();
    const after = getStore("issues").prepare("SELECT lat, gps_enc FROM issue WHERE id=?").get(a.body.id) as any;
    expect(after.gps_enc).toBeNull();
    expect(after.lat).toBe(16.24); // the rounded public point stays
  });
});
