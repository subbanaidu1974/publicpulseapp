import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter, loadDatasets } from "../../server/api";

let server: Server, base: string;
const get = async (p: string, headers: Record<string, string> = {}) => {
  const r = await fetch(base + p, { headers });
  const text = await r.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* not JSON (304) */ }
  return { status: r.status, headers: r.headers, body, text };
};

beforeAll(() => {
  const app = express();
  app.use("/api/v1", createApiRouter(loadDatasets()));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => { server.close(); });

describe("@E2E-115 boundary files", () => {
  it("serves ac, pc and district geojson with ETag and Cache-Control, and 304 on revalidation", async () => {
    for (const [file, n] of [["ac", 175], ["pc", 25], ["district", 28]] as const) {
      const r = await get(`/geo/AP/${file}.geojson`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/geo\+json/);
      expect(r.headers.get("cache-control")).toMatch(/public, max-age=\d+/);
      expect(JSON.parse(r.text).features).toHaveLength(n);
      const etag = r.headers.get("etag")!;
      expect(etag).toBeTruthy();
      expect((await get(`/geo/AP/${file}.geojson`, { "If-None-Match": etag })).status).toBe(304);
    }
    expect(JSON.parse((await get("/geo/tg/ac.geojson")).text).features).toHaveLength(119);
  });
  it("404s for an unknown state (JSON error with code)", async () => {
    const r = await get("/geo/XX/ac.geojson");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("unknown_state");
  });
});

describe("@E2E-115 units tree", () => {
  it("lists districts, mandals of a district and villages of a mandal with Telugu names only where the gazetteer has them", async () => {
    const d = await get("/geo/TG/units?level=district&limit=200");
    expect(d.body.total).toBe(33);
    const adilabad = d.body.items.find((x: any) => x.code === "501");
    expect(adilabad.nameEn).toBe("Adilabad");
    expect(adilabad.nameTe).toBeUndefined(); // ambiguous in Wikidata: left blank, never guessed
    expect(d.body.items.filter((x: any) => x.nameTe).length).toBe(32);
    expect(adilabad.href).toBe("#/place/TG/district/501");
    const m = await get("/geo/TG/units?level=mandal&parent=501");
    expect(m.body.parent).toMatchObject({ level: "district", code: "501" });
    expect(m.body.items.every((x: any) => x.parent === "501")).toBe(true);
    const tamsi = m.body.items.find((x: any) => x.code === "4305");
    expect(tamsi.villages).toBeGreaterThan(0);
    const v = await get("/geo/TG/units?level=village&parent=4305&limit=5");
    expect(v.body.items.length).toBeLessThanOrEqual(5);
    expect(v.body.items.some((x: any) => x.nameTe)).toBe(true);
    expect(v.body.source).toBeTruthy();
    // AP villages mostly lack a Telugu name: never invented
    const ap = await get("/geo/AP/units?level=village&limit=200");
    expect(ap.body.items.some((x: any) => !x.nameTe)).toBe(true);
  });
  it("paginates deterministically without overlap", async () => {
    const p1 = await get("/geo/AP/units?level=mandal&limit=100&page=1");
    const p2 = await get("/geo/AP/units?level=mandal&limit=100&page=2");
    expect(p1.body.total).toBe(688);
    expect(p1.body.pages).toBe(7);
    expect(p1.body.items).toHaveLength(100);
    const a = new Set(p1.body.items.map((x: any) => x.code));
    expect(p2.body.items.some((x: any) => a.has(x.code))).toBe(false);
    expect((await get("/geo/AP/units?level=mandal&limit=9999")).body.limit).toBe(200);
    expect((await get("/geo/AP/units?level=mandal&page=999")).body.items).toEqual([]);
  });
  it("rejects bad level / parent and unknown state", async () => {
    expect((await get("/geo/AP/units?level=ward")).status).toBe(400);
    expect((await get("/geo/AP/units?level=mandal&parent=nope")).status).toBe(404);
    expect((await get("/geo/AP/units?level=village&parent=nope")).body.code).toBe("unknown_parent");
    expect((await get("/geo/AP/units?level=district&parent=1")).status).toBe(400);
    expect((await get("/geo/ZZ/units")).status).toBe(404);
  });
});

describe("@E2E-115 search", () => {
  it("finds English names by prefix and contains, ranking exact and prefix first", async () => {
    const r = await get("/geo/TG/search?q=adilabad");
    expect(r.status).toBe(200);
    expect(r.body.results.length).toBeLessThanOrEqual(20);
    expect(r.body.results[0].nameEn.toLowerCase()).toBe("adilabad");
    expect(new Set(r.body.results.map((x: any) => x.kind)).size).toBeGreaterThan(1);
    expect(r.body.results.find((x: any) => x.kind === "ac")).toMatchObject({ href: expect.stringMatching(/^#\/constituency\/TG\/\d+$/) });
    expect(r.headers.get("cache-control")).toMatch(/max-age/);
  });
  it("finds Telugu names", async () => {
    const r = await get("/geo/AP/search?q=" + encodeURIComponent("శ్రీకాకుళం"));
    expect(r.body.results.length).toBeGreaterThan(0);
    expect(r.body.results.every((x: any) => x.nameTe?.includes("శ్రీకాకుళం"))).toBe(true);
    expect(r.body.results.some((x: any) => x.kind === "district")).toBe(true);
  });
  it("matches villages and limits to 20", async () => {
    const r = await get("/geo/AP/search?q=pa");
    expect(r.body.results).toHaveLength(20);
    expect(r.body.total).toBeGreaterThan(20);
    const v = await get("/geo/TG/search?q=" + encodeURIComponent("కరంజి"));
    expect(v.body.results.some((x: any) => x.kind === "village")).toBe(true);
  });
  it("validates q and state", async () => {
    expect((await get("/geo/AP/search")).status).toBe(400);
    expect((await get("/geo/AP/search?q=a")).body.code).toBe("query_too_short");
    expect((await get("/geo/QQ/search?q=abc")).status).toBe(404);
    expect((await get("/geo/AP/search?q=zzzzqqqq")).body.results).toEqual([]);
  });
});

describe("@E2E-115 constituency profile", () => {
  it("returns history across elections, units, PC and caching headers", async () => {
    const r = await get("/constituencies/TG/1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "TG", acNo: 1, nameEn: "Sirpur", reservation: "GEN", lgdCode: "3165" });
    expect(r.body.district).toMatchObject({ nameEn: "Kumuram Bheem Asifabad" });
    expect(r.body.pc).toMatchObject({ pcNo: 1, nameEn: "Adilabad" });
    expect(r.body.history.map((h: any) => h.year)).toEqual([2014, 2018, 2023]);
    for (const h of r.body.history) {
      expect(h.winner).toBeTruthy();
      expect(h.candidates.length).toBeGreaterThan(0);
      expect(h.candidates[0].position).toBe(1);
    }
    expect(r.body.pc.history.map((h: any) => h.year)).toEqual([2019, 2024]);
    expect(r.body.units.villages).toBeGreaterThan(0);
    expect(r.body.links.boundary).toBe("/api/v1/geo/TG/ac.geojson");
    expect(r.body.source).toBeTruthy();
    expect(r.headers.get("cache-control")).toMatch(/public/);
    expect(r.headers.get("etag")).toBeTruthy();
  });
  it("404s for unknown constituency / state, 400 for a bad number", async () => {
    expect((await get("/constituencies/TG/999")).body.code).toBe("unknown_constituency");
    expect((await get("/constituencies/XX/1")).body.code).toBe("unknown_state");
    expect((await get("/constituencies/TG/abc")).status).toBe(400);
  });
});

describe("@E2E-113 @E2E-114 place profiles", () => {
  it("village profile joins Census 2011 by census code and links the constituency", async () => {
    const r = await get("/geo/TG/places/village/568945");
    expect(r.status).toBe(200);
    expect(r.body.census).toMatchObject({ available: true, population: 2232, scPop: 258, stPop: 795, literacyPct: null });
    expect(r.body.census.stPct).toBeCloseTo(35.6, 1);
    expect(r.body.nameTe).toBeTruthy();
    expect(r.body.path.map((p: any) => p.level)).toEqual(["state", "district", "mandal"]);
    expect(r.body.constituency?.href).toMatch(/^#\/constituency\/TG\//);
  });
  it("mandal and district profiles; unknown codes 404", async () => {
    const m = await get("/geo/TG/places/mandal/4305");
    expect(m.body.census).toMatchObject({ available: true, population: 39631 });
    expect(m.body.constituencies.length).toBeGreaterThan(0);
    const d = await get("/geo/TG/places/district/501");
    expect(d.body.mandals).toBeGreaterThan(0);
    expect((await get("/geo/TG/places/village/99999999")).status).toBe(404);
    expect((await get("/geo/TG/places/ward/1")).status).toBe(400);
  });
  it("reports census as unavailable (not zero) for a village with no census row", async () => {
    const items = (await get("/geo/AP/units?level=village&limit=200")).body.items as any[];
    let unavailable: any = null;
    for (const v of items) { const p = await get(`/geo/AP/places/village/${v.code}`); if (!p.body.census.available) { unavailable = p.body; break; } }
    if (unavailable) { expect(unavailable.census.reason).toMatch(/No Census/); expect(unavailable.census.population).toBeUndefined(); }
  });
});
