import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { Router } from "express";
import fs from "fs";
import path from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { buildApiApp } from "../../server/security";
import { createApiRouter } from "../../server/api";
import type { Datasets } from "../../server/api";

const data: Datasets = { elections: [], census: [], demo: true, status: [] };

function civicStub(): Router {
  const r = Router();
  r.post("/media", express.json({ limit: "2mb" }), (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  return r;
}

async function start(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const close = (s: Server) => new Promise<void>(r => { s.close(() => r()); });

describe("main app", () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    ({ server, base } = await start(buildApiApp({
      dev: false, apiRouter: createApiRouter(data), civicRouter: civicStub(), env: {}, rateLimit: { burst: 15, perSecond: 0.001 },
    })));
  });
  afterAll(() => close(server));

  it("@E2E-66 spoofed admin header gets 404 and no secret leaks; admin config routes are gone", async () => {
    process.env.SMTP_PASS = "super-secret-smtp-pass";
    for (const m of ["GET", "POST"]) {
      const res = await fetch(`${base}/api/admin/config?role=Super%20Admin`, { method: m, headers: { "x-user-role": "Super Admin", "content-type": "application/json" }, body: m === "POST" ? JSON.stringify({ SMTP_PASS: "x" }) : undefined });
      expect(res.status).toBe(404);
      const t = await res.text();
      expect(t).not.toContain("super-secret-smtp-pass");
      expect(t).not.toMatch(/SMTP|WEB3FORMS/);
    }
    delete process.env.SMTP_PASS;
    expect(fs.existsSync(path.join(process.cwd(), "config-settings.json"))).toBe(false);
    const src = read("server.ts") + read("server/api.ts") + read("server/security.ts");
    expect(src).not.toMatch(/x-user-role/i);
    expect(read("server.ts")).not.toMatch(/config-settings|writeFileSync|WEB3FORMS|SMTP_/);
  });

  it("@E2E-67 /api/send-otp is a 404 and server.ts has no mail code or otp/phone logging", async () => {
    const res = await fetch(`${base}/api/send-otp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.c", otp: "123456" }) });
    expect(res.status).toBe(404);
    const src = read("server.ts");
    expect(src).not.toMatch(/nodemailer|web3forms|rejectUnauthorized|send-otp/i);
    for (const line of src.split("\n").filter(l => /console\.(log|info|warn|error)/.test(l))) {
      expect(line).not.toMatch(/otp|phone/i);
    }
  });

  it("@E2E-69 security headers are present and geolocation is not requested", async () => {
    const res = await fetch(`${base}/api/v1/health`, { headers: { "x-forwarded-proto": "https" } });
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://server.arcgisonline.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("@E2E-69 CORS is same-origin by default", async () => {
    const res = await fetch(`${base}/api/v1/health`, { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("@E2E-72 civic body limit is not capped by the global 16 KB parser", async () => {
    const big = JSON.stringify({ data_base64: "A".repeat(1_000_000), mime: "image/jpeg" });
    const ok = await fetch(`${base}/api/v1/civic/media`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(ok.status).toBe(200);
  });

  it("@E2E-72 global parser is small for other routes and mounted after civic", async () => {
    const app = buildApiApp({ dev: false, apiRouter: createApiRouter(data), civicRouter: civicStub(), env: {} });
    app.post("/echo", (_req, res) => res.json({ ok: true }));
    const { server: s, base: b } = await start(app);
    try {
      const res = await fetch(`${b}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "A".repeat(20_000) }) });
      expect(res.status).toBe(413);
    } finally { await close(s); }
    const src = read("server/security.ts");
    expect(src.indexOf("\"/api/v1/civic\"")).toBeLessThan(src.indexOf("express.json({ limit: \"16kb\" })"));
    expect(read("server.ts")).not.toMatch(/express\.json\(/);
  });

  it("@E2E-69 burst gets 429 with Retry-After; health is exempt", async () => {
    let limited: Response | null = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await fetch(`${base}/api/v1/states`);
      if (r.status === 429) limited = r;
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
  });
});

describe("cache and compression", () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    ({ server, base } = await start(buildApiApp({ dev: false, apiRouter: createApiRouter(data), env: {}, rateLimit: { burst: 1000, perSecond: 1000 } })));
  });
  afterAll(() => close(server));

  it("@E2E-69 read-only GETs carry Cache-Control and ETag and honour If-None-Match", async () => {
    const a = await fetch(`${base}/api/v1/states`);
    expect(a.headers.get("cache-control")).toMatch(/max-age/);
    const etag = a.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const b = await fetch(`${base}/api/v1/states`, { headers: { "if-none-match": etag } });
    expect(b.status).toBe(304);
  });

  it("@E2E-69 gzip is applied to large JSON", async () => {
    const big: Datasets = { ...data, status: Array.from({ length: 200 }, (_, i) => ({ name: `d${i}`, rows: i, provenance: "demo", generatedAt: null })) };
    const { server: s, base: b } = await start(buildApiApp({ dev: false, apiRouter: createApiRouter(big), env: {} }));
    try {
      const res = await fetch(`${b}/api/v1/data-status`, { headers: { "accept-encoding": "gzip" } });
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect((await res.json()).datasets).toHaveLength(200);
    } finally { await close(s); }
  });
});
