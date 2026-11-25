import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter, loadDatasets } from "../../server/api";

// S-198/S-199: winner and party-head photos follow the same pause (model code of conduct) and takedown rules as the people pages.
let server: Server, base = "";
const get = async (p: string) => { const r = await fetch(base + p); const t = await r.text(); let body: any = null; try { body = JSON.parse(t); } catch { /* image */ } return { status: r.status, body }; };
beforeAll(async () => {
  process.env.PEOPLE_BLACKOUT = "0";
  const app = express();
  app.use("/api/v1", createApiRouter(loadDatasets()));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => { server.close(); delete process.env.PEOPLE_BLACKOUT; });

describe("photo routes honour the pause and takedowns (S-198, S-199)", () => {
  it("serves listed photos normally", async () => {
    const idx = await get("/photos/index.json");
    expect(idx.body.photos.length).toBeGreaterThan(20);
    expect(idx.body.blackout).toEqual({ AP: false, TG: false });
    expect((await get(`/photos/${idx.body.photos[0].file}`)).status).toBe(200);
    expect((await get("/photos/leaders.json")).body.photos.length).toBeGreaterThan(5);
  });
  it("sends no photo, and 404s the file itself, while the pause is on", async () => {
    const file = (await get("/photos/index.json")).body.photos[0].file;
    process.env.PEOPLE_BLACKOUT = "1";
    try {
      const idx = await get("/photos/index.json");
      expect(idx.body.photos).toEqual([]);
      expect(idx.body.blackout).toEqual({ AP: true, TG: true });
      expect((await get(`/photos/${file}`)).status).toBe(404);
      expect((await get("/photos/leaders.json")).body).toMatchObject({ photos: [], blackout: true });
    } finally { process.env.PEOPLE_BLACKOUT = "0"; }
  });
  it("hides a photo at once after a photo takedown request for it", async () => {
    const p = (await get("/photos/index.json")).body.photos.find((x: any) => x.state === "TG");
    const key = `TG-assembly-${p.acNo}`;
    const r = await fetch(`${base}/people/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "takedown", page: "/test", targetKind: "photo", targetKey: key, reason: "automated test of the takedown path" }) });
    expect(r.status).toBe(201);
    const after = await get("/photos/index.json");
    expect(after.body.photos.some((x: any) => x.state === "TG" && x.acNo === p.acNo)).toBe(false);
    expect((await get(`/photos/${p.file}`)).status).toBe(404);
  });
});
