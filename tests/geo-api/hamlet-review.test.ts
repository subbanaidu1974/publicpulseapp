import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createSession, getDb, grantRole, migrate, resetDbForTests, verifyAuditChain, getStore } from "../../server/civic/core";
import { geoRouter } from "../../server/civic/geo/routes";
import { ensureGeo, importGeo, loadDemoGeo, search } from "../../server/civic/geo/service";
import type { GeoDataset } from "../../server/civic/geo/service";

let server: Server, base: string;
const call = async (method: string, p: string, token?: string, body?: unknown) => {
  const r = await fetch(base + p, {
    method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(() => {
  const app = express(); app.use("/geo", geoRouter);
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/geo`;
});
afterAll(() => { server.close(); });

const mkPerson = (id: string) => getDb().prepare("INSERT INTO persons (id, tier, created_at, eligible_from) VALUES (?,'T1','2026-01-01','2026-01-15')").run(id);
const real = (): GeoDataset => ({
  units: [
    { lgd: "S-36", level: "state", en: "Telangana", parent: null, from: "2026-01-01", to: null },
    { lgd: "V-1", level: "village", en: "Karanji", te: "కరంజి", parent: "S-36", from: "2026-01-01", to: null },
  ],
  hamlets: [{ id: "H-1", en: "Ambedkar Nagar", te: "అంబేడ్కర్ నగర్", village: "V-1" }, { id: "H-2", en: "Gollagudem", village: "V-1" }],
  villageConstituency: [],
});

let mod = "", plain = "";
beforeEach(() => {
  resetDbForTests(); migrate();
  importGeo(real());
  mkPerson("mod1"); mkPerson("user1");
  grantRole("system", "mod1", "moderator");
  mod = createSession("mod1"); plain = createSession("user1");
});
const envKeys = ["NODE_ENV", "CIVIC_ENV", "CIVIC_ALLOW_DEMO"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of envKeys) saved[k] = process.env[k];
afterEach(() => { for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("@E2E-116 hamlet gazetteer review", () => {
  it("imported hamlets are unreviewed and hidden from public search until approved", async () => {
    expect(search("ambedkar")).toEqual([]);
    expect(search("gollagudem")).toEqual([]);
    expect(search("karanji").map(h => h.village.lgd)).toEqual(["V-1"]); // the village itself is still searchable
    const approved = await call("POST", "/hamlets/H-1/approve", mod);
    expect(approved.status).toBe(200);
    expect(approved.body.hamlet).toMatchObject({ id: "H-1", status: "approved", path: ["Telangana", "Karanji"] });
    expect(search("ambedkar").map(h => h.hamlet?.id)).toEqual(["H-1"]);
    expect(search("అంబేడ్కర్")).toHaveLength(1);
    expect(search("gollagudem")).toEqual([]); // sibling stays hidden
  });

  it("lists by status and rejected hamlets stay hidden", async () => {
    const q = await call("GET", "/hamlets/review", mod);
    expect(q.body.total).toBe(2);
    expect(q.body.items.map((h: any) => h.id)).toEqual(["H-1", "H-2"]);
    await call("POST", "/hamlets/H-2/reject", mod, { note: "duplicate of H-1" });
    expect((await call("GET", "/hamlets/review", mod)).body.total).toBe(1);
    expect((await call("GET", "/hamlets/review?status=rejected", mod)).body.items[0]).toMatchObject({ id: "H-2", status: "rejected" });
    expect(search("gollagudem")).toEqual([]);
    expect((await call("GET", "/hamlets/review?status=bogus", mod)).status).toBe(400);
  });

  it("only moderators or admins can review: 401 anonymous, 403 ordinary user, 404 unknown hamlet", async () => {
    expect((await call("GET", "/hamlets/review")).status).toBe(401);
    expect((await call("GET", "/hamlets/review", plain)).status).toBe(403);
    expect((await call("POST", "/hamlets/H-1/approve", plain)).status).toBe(403);
    expect((await call("POST", "/hamlets/NOPE/approve", mod)).status).toBe(404);
    mkPerson("adm1"); grantRole("system", "adm1", "admin");
    expect((await call("GET", "/hamlets/review", createSession("adm1"))).status).toBe(200);
  });

  it("approve and reject write audit entries and the chain still verifies", async () => {
    await call("POST", "/hamlets/H-1/approve", mod);
    await call("POST", "/hamlets/H-2/reject", mod, { note: "not a place" });
    const rows = getStore("audit").prepare("SELECT action, object, actor FROM audit_log WHERE action LIKE 'geo.hamlet.%' ORDER BY seq").all() as any[];
    expect(rows.map(r => r.action)).toEqual(["geo.hamlet.approve", "geo.hamlet.reject"]);
    expect(rows.map(r => r.object)).toEqual(["hamlet:H-1", "hamlet:H-2"]);
    expect(rows[0].actor).toBe("mod1");
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("re-importing a gazetteer does not un-review an approved hamlet", async () => {
    await call("POST", "/hamlets/H-1/approve", mod);
    importGeo(real());
    expect(search("ambedkar")).toHaveLength(1);
  });

  it("DEMO geography is refused in production, by seed and by import; allowed in dev", () => {
    resetDbForTests(); migrate();
    process.env.NODE_ENV = "production";
    ensureGeo();
    expect((getStore("issues").prepare("SELECT COUNT(*) c FROM admin_unit").get() as { c: number }).c).toBe(0);
    expect(() => loadDemoGeo()).toThrow(/DEMO geography in production/);
    expect(() => importGeo({ ...real(), hamlets: [{ id: "DEMO-H-1", en: "x", village: "V-1" }] })).toThrow(/DEMO/);
    expect(() => importGeo(real())).not.toThrow(); // real data is fine
    process.env.NODE_ENV = "test";
    expect(() => loadDemoGeo()).not.toThrow();
    // the labelled DEMO fixture is pre-reviewed so dev search keeps working
    expect(search("harijanawada").length).toBeGreaterThan(0);
  });
});
