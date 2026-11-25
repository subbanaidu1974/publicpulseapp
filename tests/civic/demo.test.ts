import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getDb, hasRole, migrate, resetDbForTests } from "../../server/civic/core";
import { DEMO_PERSONAS, createDemoRouter, demoEnabled } from "../../server/civic/demo";
import { identityRouter } from "../../server/civic/identity/routes";
import { productionProblems } from "../../server/civic/guards";

let server: Server;
let base = "";
const KEYS = ["NODE_ENV", "CIVIC_ENV", "CIVIC_DEMO_PERSONAS"];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/demo", createDemoRouter());
  app.use("/api/v1/civic/identity", identityRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic`;
});
afterAll(() => { server.close(); });
beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; resetDbForTests(); migrate(); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function call(method: string, p: string, body?: unknown, token?: string) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}

describe("demo personas, no registration (S-166)", () => {
  it("@E2E-191 is off unless CIVIC_DEMO_PERSONAS=1: both routes answer 404", async () => {
    delete process.env.CIVIC_DEMO_PERSONAS;
    expect(demoEnabled()).toBe(false);
    expect((await call("GET", "/demo/personas")).status).toBe(404);
    expect((await call("POST", "/demo/login", { persona: "admin" })).status).toBe(404);
  });

  it("@E2E-191 is never on in production, even with the flag set", async () => {
    process.env.CIVIC_DEMO_PERSONAS = "1";
    process.env.NODE_ENV = "production";
    expect(demoEnabled()).toBe(false);
    expect((await call("GET", "/demo/personas")).status).toBe(404);
    expect(productionProblems().join(" ")).toContain("CIVIC_DEMO_PERSONAS");
  });

  it("@E2E-191 lists the personas and signs in as each one with the right roles and no phone, email or PIN", async () => {
    process.env.CIVIC_DEMO_PERSONAS = "1"; process.env.NODE_ENV = "test";
    const list = await call("GET", "/demo/personas");
    expect(list.status).toBe(200);
    expect(list.json.personas.map((p: { key: string }) => p.key)).toEqual(DEMO_PERSONAS.map((p) => p.key));
    for (const p of DEMO_PERSONAS) {
      const r = await call("POST", "/demo/login", { persona: p.key });
      expect(r.status).toBe(200);
      expect((await call("GET", "/identity/me", undefined, r.json.token)).status).toBe(200);
      for (const g of p.roles) expect(hasRole(r.json.person.id, g.role)).toBe(true);
      const row = getDb().prepare("SELECT phone_hash, email_hash, pin_hash FROM persons WHERE id = ?").get(r.json.person.id) as Record<string, string | null>;
      expect({ ...row }).toEqual({ phone_hash: null, email_hash: null, pin_hash: null });
      expect(r.json.person.flags).toContain("demo");
    }
  });

  it("@E2E-191 reuses the same account on every sign-in and rejects unknown personas", async () => {
    process.env.CIVIC_DEMO_PERSONAS = "1"; process.env.NODE_ENV = "test";
    const a = await call("POST", "/demo/login", { persona: "admin" });
    const b = await call("POST", "/demo/login", { persona: "admin" });
    expect(a.json.person.id).toBe(b.json.person.id);
    expect(a.json.token).not.toBe(b.json.token);
    expect((await call("POST", "/demo/login", { persona: "root" })).status).toBe(400);
    expect((await call("POST", "/demo/login", {})).status).toBe(400);
  });

  it("@E2E-191 the verified resident can take surveys, the new and email-only residents cannot, and a demo account cannot sign in by phone", async () => {
    process.env.CIVIC_DEMO_PERSONAS = "1"; process.env.NODE_ENV = "test";
    const ver = await call("POST", "/demo/login", { persona: "resident_verified" });
    expect(ver.json.person.survey_eligible).toBe(true);
    expect(ver.json.person.tier).toBe("T1");
    expect((await call("POST", "/demo/login", { persona: "resident_new" })).json.person.survey_eligible).toBe(false);
    expect((await call("POST", "/demo/login", { persona: "resident_email_only" })).json.person.survey_eligible).toBe(false);
    expect((await call("POST", "/identity/login", { phone: "+919876543210", pin: "4821" })).status).toBe(401);
  });
});
