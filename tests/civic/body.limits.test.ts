import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, migrate, resetDbForTests } from "../../server/civic/core";
import { createPerson } from "../../server/civic/identity/service";
import { createCivicRouter } from "../../server/civic/index";

process.env.CIVIC_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "civic-lim-"));
let server: Server, base = "", token = "";

const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
const jpeg = (pad: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.alloc(pad, 0x11), Buffer.from([0xff, 0xd9])]);

beforeAll(async () => {
  resetDbForTests(); migrate();
  token = createSession(createPerson({ phone: "+919876500401", pin: "4821", consentVersion: "v1" }).id);
  const app = express(); // deliberately no global parser: the civic router owns its limits (S-57)
  app.use("/api/v1/civic", createCivicRouter());
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic`;
});
afterAll(() => { server.close(); });

const auth = () => ({ authorization: "Bearer " + token, "content-type": "application/json" });

describe("per-router body limits (S-57)", () => {
  it("@E2E-72 a 1 MB photo sent as base64 JSON (about 1.4 MB) goes through the civic router", async () => {
    const b64 = jpeg(1024 * 1024).toString("base64");
    expect(b64.length).toBeGreaterThan(1_300_000);
    const r = await fetch(base + "/issues/media", { method: "POST", headers: auth(), body: JSON.stringify({ data_base64: b64, mime: "image/jpeg" }) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { ref: string }).ref).toMatch(/^media:/);
  });

  it("@E2E-72 other JSON routes keep a small default cap", async () => {
    const big = JSON.stringify({ category: "roads", description_en: "x".repeat(100_000) });
    expect((await fetch(base + "/issues", { method: "POST", headers: auth(), body: big })).status).toBe(413);
    const idr = await fetch(base + "/identity/signup/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "x".repeat(50_000) }) });
    expect(idr.status).toBe(413);
  });

  it("@E2E-72 an oversized media upload is rejected with 413", async () => {
    const r = await fetch(base + "/issues/media", { method: "POST", headers: auth(), body: JSON.stringify({ data_base64: "A".repeat(4_000_000) }) });
    expect(r.status).toBe(413);
  });
});
