import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { migrate, resetDbForTests } from "../../server/civic/core";
import { geoRouter } from "../../server/civic/geo/routes";
import { loadDemoGeo } from "../../server/civic/geo/service";

let server: Server, base: string;
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as any }; };

beforeAll(async () => {
  const app = express();
  app.use("/geo", geoRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/geo`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); loadDemoGeo(); });

describe("geography (S-23)", () => {
  it("@E2E-32 hamlet search in English and Telugu resolves to the village and its hierarchy", async () => {
    const en = await get("/search?q=harijanawada");
    expect(en.body.results).toHaveLength(1);
    expect(en.body.results[0].village.lgd).toBe("DEMO-V-ANM");
    expect(en.body.results[0].path).toEqual(["Andhra Pradesh", "Guntur", "Tenali", "Angalakuduru"]);
    const te = await get("/search?q=" + encodeURIComponent("అంబేడ్కర్"));
    expect(te.body.results.map((r: any) => r.village.lgd).sort()).toEqual(["DEMO-V-ANM", "DEMO-V-HNK"]);
    // same hamlet name in AP and TG stays distinguishable by path
    expect(te.body.results.some((r: any) => r.path[0] === "Telangana")).toBe(true);
  });

  it("@E2E-32 village to constituency is correct at two boundary versions and many-to-many", async () => {
    const before = await get("/village/DEMO-V-ANM/constituency?asOf=2025-06-01");
    expect(before.body.constituencies.map((c: any) => c.lgd)).toEqual(["DEMO-C-TNL"]);
    const after = await get("/village/DEMO-V-ANM/constituency?asOf=2026-06-01");
    expect(after.body.constituencies.map((c: any) => c.lgd)).toEqual(["DEMO-C-PTR"]);
    // validity end is exclusive: the change date already belongs to the new version
    const edge = await get("/village/DEMO-V-ANM/constituency?asOf=2026-01-01");
    expect(edge.body.constituencies.map((c: any) => c.lgd)).toEqual(["DEMO-C-PTR"]);
    const split = await get("/village/DEMO-V-BPL/constituency?asOf=2025-01-01");
    expect(split.body.constituencies.map((c: any) => c.lgd).sort()).toEqual(["DEMO-C-PTR", "DEMO-C-TNL"]);
  });

  it("returns units with ancestors and rejects bad input", async () => {
    const u = await get("/units/DEMO-V-HNK");
    expect(u.body.ancestors.map((a: any) => a.level)).toEqual(["village", "mandal", "district", "state"]);
    expect((await get("/units/NOPE")).status).toBe(404);
    expect((await get("/search?q=a")).status).toBe(400);
    expect((await get("/village/DEMO-M-TNL/constituency")).status).toBe(404);
  });
});
