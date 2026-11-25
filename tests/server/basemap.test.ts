import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basemapRouter, BASEMAP_NAME } from "../../server/basemap";

// S-191: the self-hosted background map file is served from this server only, by one fixed name, with Range support.
describe("basemap route (S-191)", () => {
  let server: Server, base: string, dir: string;
  const bytes = Buffer.concat([Buffer.from("PMTiles"), Buffer.alloc(993, 7)]);
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "basemap-"));
    fs.writeFileSync(path.join(dir, BASEMAP_NAME), bytes);
    fs.writeFileSync(path.join(dir, "secret.txt"), "not for the web");
    process.env.BASEMAP_FILE = path.join(dir, BASEMAP_NAME);
    const app = express(); app.use(basemapRouter());
    server = await new Promise<Server>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.BASEMAP_FILE;
    await new Promise<void>((ok) => server.close(() => ok()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves the whole file with range support and caching headers", async () => {
    const r = await fetch(`${base}/basemap/${BASEMAP_NAME}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("cache-control")).toContain("max-age");
    expect(Buffer.from(await r.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("answers a byte range with 206 and only those bytes (how a PMTiles reader fetches tiles)", async () => {
    const r = await fetch(`${base}/basemap/${BASEMAP_NAME}`, { headers: { Range: "bytes=0-6" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 0-6/${bytes.length}`);
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("PMTiles");
  });

  it("serves nothing but the one fixed name", async () => {
    for (const p of ["/basemap/secret.txt", "/basemap/../secret.txt", "/basemap/%2e%2e/secret.txt", "/basemap/", "/basemap"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      expect(await r.text(), p).not.toContain("not for the web");
    }
  });

  it("answers 404 with a plain error when the file is not installed", async () => {
    const keep = process.env.BASEMAP_FILE;
    process.env.BASEMAP_FILE = path.join(dir, "missing.pmtiles");
    try {
      const r = await fetch(`${base}/basemap/${BASEMAP_NAME}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "basemap_not_installed" });
    } finally { process.env.BASEMAP_FILE = keep; }
  });
});
