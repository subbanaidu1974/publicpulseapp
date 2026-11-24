/**
 * Internal red-team regression suite (INTERNAL SELF-ASSESSMENT, NOT INDEPENDENT; it does not satisfy RELEASE_GATE row 2).
 * Attack classes: OTP replay and cross-purpose use, rate-limit bypass by header spoofing, IDOR on issues / media / consultations,
 * role escalation, CSRF and CORS, CSP, SSRF in the recording fetcher, path traversal, blind-token reuse is in surveys/credential.test.ts.
 * Report: docs/gate/evidence/internal-redteam-self-assessment.md. Tag: @E2E-RT.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApiApp } from "../../../server/security";
import { createApiRouter } from "../../../server/api";
import { createCivicRouter } from "../../../server/civic";
import { getDb, getStore } from "../../../server/civic/core";
import { allowedRecordingUrl } from "../../../server/civic/channels/routes";
import { admin, citizen, endWorld, freshWorld, openConsultation, officer, startServer, stopServer, call as consultCall } from "../consultations/helpers";

let server: Server, base = "", prod: Server, prodBase = "";
const CIVIC = () => base + "/api/v1/civic";
let seq = 0;
const nextPhone = () => `+9199${String(10000000 + ++seq)}`;

async function req(method: string, p: string, o: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}, root = base) {
  const r = await fetch(root + p, {
    method, redirect: "manual",
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: "Bearer " + o.token } : {}), ...(o.headers ?? {}) },
    body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
  });
  const text = await r.text();
  let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}
const civic = (method: string, p: string, o: Parameters<typeof req>[2] = {}) => req(method, "/api/v1/civic" + p, o);

async function signup(phone = nextPhone(), pin = "4821") {
  const rq = await civic("POST", "/identity/signup/request", { body: { phone } });
  expect(rq.status, rq.text).toBe(200);
  const v = await civic("POST", "/identity/signup/verify", { body: { phone, otp: rq.json.dev_otp, pin } });
  expect(v.status, v.text).toBe(201);
  return { phone, pin, token: v.json.token as string, id: v.json.person.id as string };
}

beforeAll(async () => {
  process.env.CIVIC_EXPOSE_DEV_OTP = "1";
  const mk = (dev: boolean, env: NodeJS.ProcessEnv = {}) => buildApiApp({ dev, apiRouter: createApiRouter({ elections: [], census: [], demo: true, status: [] }), civicRouter: createCivicRouter(), env, rateLimit: { burst: 100000, perSecond: 100000 } });
  server = await new Promise<Server>((r) => { const s = mk(true).listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  prod = await new Promise<Server>((r) => { const s = mk(false, { CORS_ORIGINS: "https://app.example.test" }).listen(0, "127.0.0.1", () => r(s)); });
  prodBase = `http://127.0.0.1:${(prod.address() as AddressInfo).port}`;
  await startServer();
});
afterAll(() => { server.close(); prod.close(); stopServer(); });
beforeEach(() => { process.env.CIVIC_EXPOSE_DEV_OTP = "1"; freshWorld(); });
afterEach(() => { endWorld(); for (const k of ["CIVIC_OTP_IP_LIMIT", "CIVIC_OTP_NET_LIMIT"]) delete process.env[k]; });

describe("OTP: replay, cross-purpose use, guessing @E2E-RT", () => {
  it("a consumed sign-up OTP cannot be replayed to create or take over an account", async () => {
    const phone = nextPhone();
    const rq = await civic("POST", "/identity/signup/request", { body: { phone } });
    const first = await civic("POST", "/identity/signup/verify", { body: { phone, otp: rq.json.dev_otp, pin: "4821" } });
    expect(first.status).toBe(201);
    const replay = await civic("POST", "/identity/signup/verify", { body: { phone, otp: rq.json.dev_otp, pin: "7345" } });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.json.token).toBeUndefined();
    expect(getDb().prepare("SELECT COUNT(*) c FROM persons").get()).toMatchObject({ c: 1 });
  });

  it("a recovery code does not work as a sign-up code, and a sign-up code does not reset a PIN", async () => {
    const victim = await signup();
    const rec = await civic("POST", "/identity/pin/recover/request", { body: { phone: victim.phone } });
    expect(rec.status).toBe(200);
    const asSignup = await civic("POST", "/identity/signup/verify", { body: { phone: victim.phone, otp: rec.json.dev_otp, pin: "9051" } });
    expect(asSignup.json.token).toBeUndefined();
    // purpose smuggled through the sign-up request endpoint must not hand a signup code the recovery power
    const other = nextPhone();
    const su = await civic("POST", "/identity/signup/request", { body: { phone: other } });
    const bad = await civic("POST", "/identity/pin/recover", { body: { phone: victim.phone, otp: su.json.dev_otp, new_pin: "9051", person_id: victim.id } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const still = await civic("POST", "/identity/login", { body: { phone: victim.phone, pin: victim.pin, person_id: victim.id } });
    expect(still.status).toBe(200);
  });

  it("an OTP is bound to its phone: a code for one number is useless for another", async () => {
    const a = nextPhone(), b = nextPhone();
    const ra = await civic("POST", "/identity/signup/request", { body: { phone: a } });
    await civic("POST", "/identity/signup/request", { body: { phone: b } });
    const x = await civic("POST", "/identity/signup/verify", { body: { phone: b, otp: ra.json.dev_otp, pin: "4821" } });
    expect(x.json.token).toBeUndefined();
  });

  it("guessing: repeated wrong codes burn or lock the code (the right code stops working after the allowance)", async () => {
    const phone = nextPhone();
    const rq = await civic("POST", "/identity/signup/request", { body: { phone } });
    const wrong = rq.json.dev_otp === "000000" ? "000001" : "000000";
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await civic("POST", "/identity/signup/verify", { body: { phone, otp: wrong, pin: "4821" } })).status);
    const after = await civic("POST", "/identity/signup/verify", { body: { phone, otp: rq.json.dev_otp, pin: "4821" } });
    expect(after.status, `statuses ${codes.join(",")}`).toBeGreaterThanOrEqual(400); // 12 wrong guesses kill the code: no 10^6 brute force
  });

  it("phone-format tricks do not mint a second identity or a second OTP allowance", async () => {
    const base10 = "9899000001";
    for (const phone of [base10, "+91 " + base10, "091" + base10, "+91-" + base10 + " ", "+9198990000010", "+91" + base10 + "\u0000", "+91" + base10.replace("9", "９")]) {
      const r = await civic("POST", "/identity/signup/request", { body: { phone } });
      expect(r.status, JSON.stringify(phone)).toBe(400);
    }
    expect((await civic("POST", "/identity/signup/request", { body: { phone: "+91" + base10 } })).status).toBe(200);
  });
});

describe("rate-limit bypass @E2E-RT", () => {
  it("rotating X-Forwarded-For / X-Real-IP / Forwarded does not reset the per-phone OTP cap or the per-IP cap (TRUST_PROXY unset)", async () => {
    process.env.CIVIC_OTP_IP_LIMIT = "6";
    const phone = nextPhone();
    const spoof = (i: number) => ({ "x-forwarded-for": `203.0.113.${i}`, "x-real-ip": `198.51.100.${i}`, forwarded: `for=192.0.2.${i}`, "x-client-ip": `10.9.8.${i}` });
    const phoneCodes: number[] = [];
    // the same phone: 3 per 10 minutes whatever the claimed address
    for (let i = 0; i < 6; i++) phoneCodes.push((await civic("POST", "/identity/pin/recover/request", { body: { phone }, headers: spoof(i) })).status);
    expect(phoneCodes.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    // different phones from one socket: the per-IP cap still bites although every request claims a new address
    const ipCodes: number[] = [];
    for (let i = 0; i < 10; i++) ipCodes.push((await civic("POST", "/identity/signup/request", { body: { phone: nextPhone() }, headers: spoof(100 + i) })).status);
    expect(ipCodes).toContain(429);
  });

  it("forged device and ASN hints are ignored: rotating X-Device-Id does not lift the per-phone cap", async () => {
    const phone = nextPhone();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await civic("POST", "/identity/pin/recover/request", { body: { phone }, headers: { "x-device-id": "dev-" + i, "x-asn": "AS" + i, "x-edge-verified": "1" } })).status);
    expect(codes.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
  });

  it("the public export endpoint rate-limits per socket address, not per spoofed header", async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await civic("GET", "/issues/export", { headers: { "x-forwarded-for": `203.0.113.${i}` } });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("IDOR on issues and media @E2E-RT", () => {
  const report = (token: string, over: object = {}) => civic("POST", "/issues", { token, body: { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply near the school", ...over } });

  it("another resident cannot read, appeal, rebut, transition or moderate someone else's report", async () => {
    const alice = await signup(), bob = await signup();
    const held = await report(alice.token, { description_en: "Mr Ramesh the MRO took a bribe for my pension", category: "roads" });
    expect(held.status).toBeLessThan(300);
    const id = held.json.id as string;
    expect((await civic("GET", `/issues/mine/${id}`, { token: bob.token })).status).toBe(404);
    expect((await civic("GET", `/issues/mine/${id}`, { token: alice.token })).status).toBe(200);
    expect((await civic("GET", `/issues/${id}`)).status).toBe(404); // held report is not public
    for (const [m, p, body] of [
      ["POST", `/issues/${id}/appeal`, { reason: "please publish" }],
      ["POST", `/issues/${id}/rebuttal`, { text: "I am the official" }],
      ["POST", `/issues/${id}/transition`, { to: "Resolved" }],
      ["POST", `/issues/${id}/moderate`, { decision: "release" }],
      ["POST", `/issues/${id}/escalate`, {}],
    ] as const) {
      const r = await civic(m, p, { token: bob.token, body });
      expect(r.status, `${p} -> ${r.text}`).toBeGreaterThanOrEqual(400);
      expect(r.status, p).not.toBe(500);
    }
    expect((await civic("GET", `/issues/mine/${id}`, { token: alice.token })).json.moderation).toBe("held"); // still held: nothing above changed it
    expect((await civic("GET", "/issues/mine", { token: bob.token })).json.items).toEqual([]);
  });

  it("reports never expose the reporter: public list, detail and export carry no person id, phone or pseudonym", async () => {
    const alice = await signup();
    const ok = await report(alice.token);
    const pub = await civic("GET", `/issues/${ok.json.id}`);
    const list = await civic("GET", "/issues");
    const exp = await civic("GET", "/issues/export");
    for (const t of [pub.text, list.text, exp.text]) {
      expect(t).not.toContain(alice.id);
      expect(t).not.toContain(alice.phone);
      expect(t).not.toMatch(/reporter|phone|person_id|pseudonym/i);
    }
  });

  it("a private upload is not readable by another resident until attached to a visible issue; ids are not guessable by traversal", async () => {
    const alice = await signup(), bob = await signup();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const up = await fetch(CIVIC() + "/issues/media", { method: "POST", headers: { authorization: "Bearer " + alice.token, "content-type": "image/png" }, body: png });
    expect(up.status, await up.clone().text()).toBeLessThan(300);
    const ref = ((await up.json()) as { ref: string }).ref; // media:<id>
    const id = ref.replace(/^media:/, "");
    expect((await civic("GET", `/issues/media/${id}`, { token: alice.token })).status).toBe(200);
    expect((await civic("GET", `/issues/media/${id}`, { token: bob.token })).status).toBe(404);
    expect((await civic("GET", `/issues/media/${id}`)).status).toBe(401);
    for (const bad of ["..%2F..%2Fpackage.json", "%2e%2e%2f%2e%2e%2fpackage.json", "..%5C..%5Cpackage.json", "%00", "....//....//etc/passwd", encodeURIComponent("../".repeat(6) + "windows/win.ini")]) {
      const r = await civic("GET", `/issues/media/${bad}`, { token: alice.token });
      expect(r.status, bad).toBeGreaterThanOrEqual(400);
      expect(r.text, bad).not.toMatch(/"name"\s*:\s*"react-example"|\[fonts\]|root:/);
    }
    // a reference to someone else's upload cannot be attached to your own report
    const stolen = await report(bob.token, { photo_ref: ref });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
  });
});

describe("IDOR and role gates on consultations and surveys @E2E-RT", () => {
  it("feedback is private to its author; citizens cannot reach held comments, analyst data, panel review or staff audio upload", async () => {
    const { id } = await openConsultation();
    const a = citizen(), b = citizen();
    expect((await consultCall(a, "POST", `/${id}/feedback`, { clause: 1, stance: "oppose", comment: "The yard fee is too high for small farmers." })).status).toBeLessThan(300);
    const bMine = await consultCall(b, "GET", `/${id}/mine`);
    expect(bMine.body.feedback).toEqual([]);
    const aMine = JSON.stringify((await consultCall(a, "GET", `/${id}/mine`)).body);
    expect(aMine).toContain("yard fee");
    const figs = JSON.stringify((await consultCall(null, "GET", `/${id}/figures`)).body) + JSON.stringify((await consultCall(null, "GET", `/${id}/comments`)).body);
    expect(figs).not.toContain(a.id);
    for (const [m, u, body] of [
      ["GET", `/${id}/comments/held`], ["POST", `/${id}/comments/x/moderate`, { verdict: "ok" }], ["GET", `/${id}/analyst`], ["POST", `/${id}/review/run`, {}],
      ["POST", `/${id}/panel/review`, { decision: "approve" }], ["POST", `/${id}/closing-report/publish`, {}], ["POST", `/${id}/publish`, {}], ["POST", `/${id}/close`, {}],
      ["PATCH", `/${id}`, { title_en: "hijack" }], ["POST", `/${id}/corrections`, {}], ["POST", `/${id}/complete`, {}],
    ] as const) {
      const r = await consultCall(b, m, u, body);
      expect(r.status, `${m} ${u}`).toBeGreaterThanOrEqual(401);
      expect([401, 403, 404, 409, 400, 422], `${m} ${u} -> ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
    }
    // an officer from another department cannot edit this consultation either
    const other = officer("Revenue");
    expect((await consultCall(other, "PATCH", `/${id}`, { title_en: "hijack" })).status).toBeGreaterThanOrEqual(400);
    // path-like group / clause parameters on the audio route never touch the filesystem
    for (const g of ["..%2F..%2Fpackage.json", "farmers%00.wav", "..%5C..%5Cpackage.json"]) {
      const r = await consultCall(null, "GET", `/${id}/clauses/1/audio/${g}`);
      expect(r.status, g).toBeGreaterThanOrEqual(400);
    }
  });

  it("survey registry and credential endpoints refuse citizens and anonymous callers where a role or session is required", async () => {
    const c = await signup();
    const sid = "00000000-0000-4000-8000-000000000001";
    for (const [m, p] of [["POST", "/surveys"], ["GET", "/surveys/mine"], ["GET", "/surveys/quota"], ["POST", `/surveys/${sid}/panel/review`]] as const) {
      const bd = m === "GET" ? undefined : {};
      const r = await civic(m, p, { token: c.token, body: bd });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect((await civic(m, p, { body: bd })).status, `${m} ${p} anon`).toBe(401);
    }
    expect((await civic("GET", `/surveys/${sid}/credential/eligibility`)).status).toBe(401);
    expect((await civic("POST", `/surveys/${sid}/credential/request`, { body: { blinded: "AA", nonce: "n", key_class: "T1" } })).status).toBe(401);
  });
});

describe("role escalation @E2E-RT", () => {
  it("a citizen cannot grant themselves a role through headers, body fields, query strings or profile endpoints", async () => {
    const c = await signup();
    const me0 = await civic("GET", "/identity/me", { token: c.token });
    expect(me0.json.roles ?? []).toEqual([]);
    const tries = [
      civic("GET", "/identity/me?role=admin&roles=admin", { token: c.token, headers: { "x-user-role": "admin", "x-role": "admin", "x-admin": "1", "x-person": "someone-else", "x-forwarded-user": "admin" } }),
      civic("POST", "/identity/residence", { token: c.token, body: { village_lgd: "DEMO-V-KLR", tier: "T2", roles: ["admin"], role: "admin", flags: [], person_id: "x" } }),
      civic("POST", "/identity/pin/change", { token: c.token, body: { old_pin: c.pin, new_pin: "7345", roles: ["admin"], tier: "T2" } }),
    ];
    await Promise.all(tries);
    const me1 = await civic("GET", "/identity/me", { token: c.token });
    expect(me1.json.roles ?? []).toEqual([]);
    const row = getDb().prepare("SELECT tier FROM persons WHERE id = ?").get(c.id) as { tier: string };
    expect(row.tier).not.toBe("T2");
    expect(getDb().prepare("SELECT COUNT(*) c FROM roles WHERE person_id = ?").get(c.id)).toMatchObject({ c: 0 });
    for (const [m, p] of [["GET", "/ops/jobs"], ["GET", "/ops/providers"], ["GET", "/admin/roles"], ["POST", "/admin/roles/requests"], ["GET", "/admin/roles/requests"], ["POST", "/admin/breakglass/requests"], ["GET", "/admin/me"], ["GET", "/issues/moderation/queue"], ["GET", "/issues/officer/queue"], ["GET", "/audit/verify"]] as const) {
      const r = await civic(m, p, { token: c.token, body: m === "GET" ? undefined : {}, headers: { "x-user-role": "admin" } });
      if (p === "/audit/verify") { expect(r.status, p).toBeLessThan(500); continue; } // public verify endpoint by design
      expect(r.status, `${m} ${p} -> ${r.text.slice(0, 120)}`).toBeGreaterThanOrEqual(401);
      expect(r.status, p).toBeLessThan(500);
    }
    expect((await req("GET", "/api/admin/config?role=Super%20Admin", { headers: { "x-user-role": "Super Admin" } })).status).toBe(404);
  });

  it("an admin cannot grant roles (even to themselves) without MFA and a second admin", async () => {
    const a1 = admin();
    const r = await civic("POST", "/admin/roles/requests", { token: a1.token, body: { action: "grant", person_id: a1.id, role: "politician", reason: "self" } });
    expect(r.status, r.text).toBeGreaterThanOrEqual(400); // MFA is required before any dual-control request: no silent grant
    expect(getDb().prepare("SELECT COUNT(*) c FROM roles WHERE person_id = ? AND role = 'politician'").get(a1.id)).toMatchObject({ c: 0 });
  });
});

describe("CSRF, CORS, CSP and cookies @E2E-RT", () => {
  it("authentication is a bearer header only: a cookie-only request is anonymous and no response sets a cookie", async () => {
    const c = await signup();
    const viaCookie = await civic("GET", "/identity/me", { headers: { cookie: `token=${c.token}; session=${c.token}; authorization=Bearer ${c.token}` } });
    expect(viaCookie.status).toBe(401);
    const login = await civic("POST", "/identity/login", { body: { phone: c.phone, pin: c.pin, person_id: c.id } });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toBeNull();
    // a cross-site form post (urlencoded, no JSON content type) cannot act as the user
    const form = await civic("POST", "/identity/pin/change", { token: undefined, headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: `token=${c.token}` }, raw: `old_pin=${c.pin}&new_pin=9051` });
    expect([400, 401, 415]).toContain(form.status);
    const pinStillWorks = await civic("POST", "/identity/login", { body: { phone: c.phone, pin: c.pin, person_id: c.id } });
    expect(pinStillWorks.status).toBe(200);
  });

  it("CORS: a foreign origin gets no allow header, preflight is not approved, credentials are never allowed; an allow-listed origin is echoed exactly", async () => {
    for (const root of [base, prodBase]) {
      const evil = await req("GET", "/api/v1/civic/degraded", { headers: { origin: "https://evil.example" } }, root);
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
      expect(evil.headers.get("access-control-allow-credentials")).toBeNull();
      const pre = await req("OPTIONS", "/api/v1/civic/identity/login", { headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } }, root);
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
      const nul = await req("GET", "/api/v1/civic/degraded", { headers: { origin: "null" } }, root);
      expect(nul.headers.get("access-control-allow-origin")).toBeNull();
    }
    const ok = await req("GET", "/api/v1/civic/degraded", { headers: { origin: "https://app.example.test" } }, prodBase);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const lookalike = await req("GET", "/api/v1/civic/degraded", { headers: { origin: "https://app.example.test.evil.example" } }, prodBase);
    expect(lookalike.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("CSP and framing headers on the production app: no inline script, no eval, no framing, no sniffing, no powered-by", async () => {
    const r = await req("GET", "/api/v1/civic/degraded", {}, prodBase);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).not.toMatch(/unsafe-eval/);
    const script = /script-src([^;]*)/.exec(csp)?.[1] ?? "";
    expect(script).not.toMatch(/unsafe-inline|\*|https?:\/\/(?!.*\.example)/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("error responses do not leak stack traces or file paths", async () => {
    for (const r of [
      await civic("POST", "/identity/login", { raw: "{not json", headers: { "content-type": "application/json" } }),
      await civic("GET", "/issues/%E0%A4%A"),
      await civic("POST", "/issues", { raw: "x".repeat(70_000), headers: { "content-type": "application/json" } }),
    ]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.text).not.toMatch(/at .*\.(ts|js):\d+|node_modules|[A-Z]:\\|\/Users\/|SQLITE|SyntaxError/);
    }
  });
});

describe("SSRF in the recording fetcher @E2E-RT", () => {
  const saved = process.env.CIVIC_IVR_RECORDING_HOSTS;
  afterEach(() => { if (saved === undefined) delete process.env.CIVIC_IVR_RECORDING_HOSTS; else process.env.CIVIC_IVR_RECORDING_HOSTS = saved; });

  it("refuses everything when no host is configured and every non-allow-listed destination when one is", () => {
    delete process.env.CIVIC_IVR_RECORDING_HOSTS;
    expect(allowedRecordingUrl("https://rec.aggregator.example/a.wav")).toBeNull();
    process.env.CIVIC_IVR_RECORDING_HOSTS = "rec.aggregator.example,*.cdn.aggregator.example";
    const ok = ["https://rec.aggregator.example/a.wav", "https://eu.cdn.aggregator.example/x/a.wav"];
    for (const u of ok) expect(allowedRecordingUrl(u), u).not.toBeNull();
    const bad = [
      "http://rec.aggregator.example/a.wav", "https://127.0.0.1/a.wav", "https://[::1]/a.wav", "https://169.254.169.254/latest/meta-data/", "https://localhost/a.wav",
      "https://2130706433/a.wav", "https://0x7f000001/a.wav", "https://rec.aggregator.example@evil.example/a.wav", "https://rec.aggregator.example:8443/a.wav",
      "https://user:pw@rec.aggregator.example/a.wav", "https://rec.aggregator.example.evil.example/a.wav", "https://evilrec.aggregator.example/a.wav",
      "https://cdn.aggregator.example/a.wav", "https://evil.example/?u=https://rec.aggregator.example/a.wav", "file:///etc/passwd", "ftp://rec.aggregator.example/a.wav",
      "gopher://rec.aggregator.example/", "https://rec.aggregator.example/" + "a".repeat(700), "//rec.aggregator.example/a.wav", "",
    ];
    for (const u of bad) expect(allowedRecordingUrl(u), u.slice(0, 80)).toBeNull();
  });

  it("the default fetcher does not follow redirects (a redirect could leave the allow-list)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "server/civic/channels/routes.ts"), "utf8");
    expect(src).toMatch(/redirect:\s*"manual"/);
    expect(src).not.toMatch(/redirect:\s*"follow"/);
  });
});

describe("path traversal on static serving @E2E-RT", () => {
  it("the production static layout (express.static over dist, as in server.ts) never serves files outside its root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-static-"));
    const dist = path.join(root, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
    fs.writeFileSync(path.join(dist, "assets", "a.js"), "console.log(1)");
    fs.writeFileSync(path.join(root, "secret.txt"), "TOP-SECRET-OUTSIDE");
    const app = express();
    app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y" }));
    app.use(express.static(dist));
    app.get("*", (_req, res) => { res.sendFile(path.join(dist, "index.html")); });
    const s = await new Promise<Server>((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/assets/../../secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/..%5csecret.txt", "/assets/..%5c..%5csecret.txt", "/%252e%252e/secret.txt", "/assets/a.js%00.txt"]) {
        const r = await req("GET", p, {}, b);
        expect(r.text, p).not.toContain("TOP-SECRET-OUTSIDE");
      }
      expect((await req("GET", "/assets/a.js", {}, b)).status).toBe(200);
    } finally { s.close(); fs.rmSync(root, { recursive: true, force: true }); }
    const src = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
    expect(src).not.toMatch(/sendFile\([^)]*req\./); // no request-derived path ever reaches sendFile
  });

  it("API id parameters shaped like paths or SQL are rejected or not found, never a 500", async () => {
    const c = await signup();
    for (const id of ["..%2F..%2Fetc%2Fpasswd", "%00", "1%27%20OR%20%271%27%3D%271", "%E0%A4%A", "a".repeat(5000)]) {
      for (const p of [`/issues/${id}`, `/issues/mine/${id}`, `/consultations/${id}`, `/surveys/${id}`, `/surveys/${id}/results`]) {
        const r = await civic("GET", p, { token: c.token });
        expect(r.status, p.slice(0, 60)).toBeLessThan(500);
      }
    }
  });
});

describe("personal data in API responses @E2E-RT", () => {
  it("no response, to the owner, another resident or the public, contains the stored phone, hashes, ciphertext, salts or session hashes; others never see the person id", async () => {
    const alice = await signup(), bob = await signup();
    await civic("POST", "/identity/residence", { token: alice.token, body: { village_lgd: "DEMO-V-KLR" } });
    const rep = await civic("POST", "/issues", { token: alice.token, body: { category: "water", village_lgd: "DEMO-V-KLR", description_en: "Water tank leaking near the school" } });
    expect(rep.status, rep.text).toBeLessThan(300);
    await civic("POST", `/issues/${rep.json.id}/me-too`, { token: bob.token });
    const { id: cid } = await openConsultation();
    await consultCall({ id: alice.id, token: alice.token }, "POST", `/${cid}/feedback`, { clause: 1, stance: "support", comment: "Good proposal for small farmers." });
    const row = getDb().prepare("SELECT phone_hash, phone_enc, pin_hash, pin_salt, residence_enc FROM persons WHERE id = ?").get(alice.id) as Record<string, string | null>;
    const sess = getDb().prepare("SELECT token_hash FROM sessions WHERE person_id = ?").get(alice.id) as { token_hash: string };
    const secrets = [alice.phone, alice.phone.slice(3), row.phone_hash, row.phone_enc, row.pin_hash, row.pin_salt, row.residence_enc, sess.token_hash].filter((x): x is string => !!x && x.length >= 6);
    expect(secrets.length).toBeGreaterThanOrEqual(5);
    const publicGets = ["/issues", "/issues/feed", "/issues/categories", "/issues/export", `/issues/${rep.json.id}`, "/issues/metrics", "/geo/states", "/surveys", "/surveys/registry/log", "/consultations", `/consultations/${cid}`, `/consultations/${cid}/figures`, `/consultations/${cid}/comments`, `/consultations/${cid}/log`,
      "/audit/head", "/audit/entries", "/audit/summary", "/households/grievance-officer", "/degraded"];
    const ownerGets = ["/identity/me", "/identity/sessions", "/issues/mine", `/issues/mine/${rep.json.id}`, "/admin/me", `/consultations/${cid}/mine`, "/households/mine"];
    const seen: string[] = [];
    const sweep = async (who: string | undefined, paths: string[], forbidIds: string[]) => {
      for (const p of paths) {
        const r = await civic("GET", p, { token: who });
        seen.push(`${p}:${r.status}`);
        expect(r.status, p).toBeLessThan(500);
        for (const sct of secrets) expect(r.text.includes(sct), `${p} leaks a stored personal value`).toBe(false);
        for (const id of forbidIds) expect(r.text.includes(id), `${p} leaks a person id`).toBe(false);
      }
    };
    await sweep(undefined, publicGets, [alice.id, bob.id]);
    await sweep(bob.token, [...publicGets, ...ownerGets.filter((p) => !p.includes(rep.json.id))], [alice.id]);
    await sweep(alice.token, ownerGets, []);
    const reached = seen.filter((x) => x.endsWith(":200")).length;
    expect(reached, seen.join(" ")).toBeGreaterThan(15); // the sweep reached real handlers, not only 404s
    // login and sign-up bodies carry the session token (by design) but never the stored identifiers
    const login = await civic("POST", "/identity/login", { body: { phone: alice.phone, pin: alice.pin, person_id: alice.id } });
    for (const sct of secrets) expect(login.text.includes(sct), "login leaks").toBe(false);
    expect(login.text).not.toMatch(/scrypt|"otp"|"salt"/i);
  });

  it("server logs and audit rows carry no phone, PIN or OTP after real flows", async () => {
    const lines: string[] = [];
    const orig = [process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr)];
    process.stdout.write = ((c: unknown) => { lines.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => { lines.push(String(c)); return true; }) as typeof process.stderr.write;
    let alice: Awaited<ReturnType<typeof signup>>;
    try {
      alice = await signup();
      await civic("POST", "/identity/login", { body: { phone: alice.phone, pin: "0000", person_id: alice.id } }); // wrong PIN path
      await civic("POST", "/identity/pin/recover/request", { body: { phone: alice.phone } });
    } finally { process.stdout.write = orig[0]; process.stderr.write = orig[1]; }
    const logs = lines.join("");
    expect(logs).not.toContain(alice.phone);
    expect(logs).not.toContain(alice.phone.slice(3));
    expect(logs).not.toContain(alice.token);
    const audit = JSON.stringify(getStore("audit").prepare("SELECT * FROM audit_log").all());
    expect(audit).not.toContain(alice.phone.slice(3));
    expect(audit).not.toContain(alice.token);
  });
});

describe("blind-signature token reuse (pointer) @E2E-RT", () => {
  it("is covered by tests/civic/surveys/credential.test.ts and blind.test.ts (replay, cross-survey, forged, key-class, retry window)", () => {
    for (const f of ["tests/civic/surveys/credential.test.ts", "tests/civic/surveys/blind.test.ts"]) expect(fs.existsSync(path.join(process.cwd(), f)), f).toBe(true);
    expect(fs.readFileSync(path.join(process.cwd(), "tests/civic/surveys/credential.test.ts"), "utf8")).toMatch(/a replayed token is rejected, and a token cannot be redeemed at another survey/);
  });
});
