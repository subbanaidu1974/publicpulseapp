import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getDb, listSessions, migrate, resetDbForTests } from "../../server/civic/core";
import {
  devAttestationToken, hashPin, hashPinAsync, identityRouter, verifyPin, verifyPinAsync, weakPinReason, setAttestationVerifier,
} from "../../server/civic/identity/routes";

let server: Server;
let base = "";
const PHONE = "+919876543210";

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/identity", identityRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/identity`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  process.env.CIVIC_EXPOSE_DEV_OTP = "1";
  resetDbForTests();
  migrate();
});
afterEach(() => {
  for (const k of ["CIVIC_LOGIN_SOURCE_LIMIT", "CIVIC_LOGIN_PHONE_CEILING", "CIVIC_TRUSTED_EDGE_IPS", "CIVIC_EDGE_SECRET", "CIVIC_OTP_NET_LIMIT", "CIVIC_UNVERIFIED_CAP_FACTOR", "CIVIC_SESSION_TTL_DAYS"]) delete process.env[k];
  setAttestationVerifier(null);
});

async function call(method: string, p: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}
async function signup(phone: string, pin = "4821") {
  const rq = await call("POST", "/signup/request", { phone });
  const v = await call("POST", "/signup/verify", { phone, otp: rq.json.dev_otp, pin });
  expect(v.status).toBe(201);
  return { token: v.json.token as string, id: v.json.person.id as string };
}

describe("identity hardening (S-59)", () => {
  it("@E2E-74 weak PINs are refused with code weak_pin at sign-up, recovery and PIN change", async () => {
    for (const pin of ["0000", "1234", "1111", "4321", "1212", "123456", "1998", "2005", "150490"]) expect(weakPinReason(pin), pin).not.toBeNull();
    for (const pin of ["4821", "7345", "905173"]) expect(weakPinReason(pin), pin).toBeNull();
    const rq = await call("POST", "/signup/request", { phone: PHONE });
    const weak = await call("POST", "/signup/verify", { phone: PHONE, otp: rq.json.dev_otp, pin: "1234" });
    expect(weak.status).toBe(400); expect(weak.json.code).toBe("weak_pin");
    const v = await call("POST", "/signup/verify", { phone: PHONE, otp: rq.json.dev_otp, pin: "4821" }); // the refused PIN did not burn the code
    expect(v.status).toBe(201);
    const a = { id: v.json.person.id as string, token: v.json.token as string };
    const rec = await call("POST", "/pin/recover/request", { phone: PHONE });
    const bad = await call("POST", "/pin/recover", { phone: PHONE, otp: rec.json.dev_otp, new_pin: "0000", person_id: a.id });
    expect(bad.json.code).toBe("weak_pin");
    const ch = await call("POST", "/pin/change", { old_pin: "4821", new_pin: "1111" }, a.token);
    expect(ch.json.code).toBe("weak_pin");
  });

  it("@E2E-74 a valid OTP is not replaced by another request, and per-purpose codes coexist", async () => {
    const first = await call("POST", "/signup/request", { phone: PHONE });
    const again = await call("POST", "/signup/request", { phone: PHONE });
    expect(again.json.already_sent).toBe(true);
    expect(again.json.dev_otp).toBeUndefined();
    const rec = await call("POST", "/pin/recover/request", { phone: PHONE });
    expect(rec.json.already_sent).toBeUndefined();
    expect(getDb().prepare("SELECT purpose FROM otps ORDER BY purpose").all()).toEqual([{ purpose: "recovery" }, { purpose: "signup" }]);
    expect((await call("POST", "/signup/verify", { phone: PHONE, otp: first.json.dev_otp, pin: "4821" })).status).toBe(201); // signup code still valid
  });

  it("@E2E-74 flooding a phone from one source does not lock out the owner on another source", async () => {
    process.env.CIVIC_LOGIN_SOURCE_LIMIT = "4";
    process.env.CIVIC_TRUSTED_EDGE_IPS = "127.0.0.1,::1";
    const a = await signup(PHONE);
    const hdr = (dev: string) => ({ "x-device-id": dev, "x-edge-verified": "1" });
    const login = (dev: string, pin: string) => call("POST", "/login", { phone: PHONE, pin, person_id: a.id }, undefined, hdr(dev));
    expect((await login("owner", "4821")).status).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await login("attacker", "9031")).status);
    expect(codes).toContain(429); // the attacker's own source is rate limited
    expect((await login("owner", "4821")).status).toBe(200); // the owner is untouched
    expect((await login("owner-second-device", "4821")).status).toBe(200); // so is a brand-new source of the owner
  });

  it("@E2E-74 the global per-phone ceiling only rate-limits unknown sources", async () => {
    process.env.CIVIC_LOGIN_PHONE_CEILING = "3";
    process.env.CIVIC_TRUSTED_EDGE_IPS = "127.0.0.1,::1";
    const a = await signup(PHONE);
    const hdr = (dev: string) => ({ "x-device-id": dev, "x-edge-verified": "1" });
    const login = (dev: string, pin: string) => call("POST", "/login", { phone: PHONE, pin, person_id: a.id }, undefined, hdr(dev));
    expect((await login("owner", "4821")).status).toBe(200); // owner source becomes known
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login("rot" + i, "9031")).status);
    expect(codes).toContain(429);
    expect((await login("owner", "4821")).status).toBe(200);
  });

  it("@E2E-74 logout revokes the server session; sessions can be listed and revoked by id; recovery and PIN change sign out everywhere", async () => {
    const a = await signup(PHONE);
    const l2 = await call("POST", "/login", { phone: PHONE, pin: "4821" }, undefined, { "x-device-name": "Pixel 7" });
    const list = await call("GET", "/sessions", undefined, a.token);
    expect(list.json.sessions).toHaveLength(2);
    expect(list.json.sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(a.token);
    expect(list.json.sessions.map((s: any) => s.device)).toContain("Pixel 7");
    const other = list.json.sessions.find((s: any) => !s.current);
    expect((await call("POST", `/sessions/${other.id}/revoke`, {}, a.token)).status).toBe(200);
    expect((await call("GET", "/me", undefined, l2.json.token)).status).toBe(401);
    expect((await call("DELETE", `/sessions/${other.id}`, undefined, a.token)).status).toBe(404);
    expect((await call("POST", "/logout", {}, a.token)).status).toBe(200);
    expect((await call("GET", "/me", undefined, a.token)).status).toBe(401);
    // PIN change: every session dies, a fresh token comes back
    const s1 = (await call("POST", "/login", { phone: PHONE, pin: "4821" })).json.token;
    const s2 = (await call("POST", "/login", { phone: PHONE, pin: "4821" })).json.token;
    const ch = await call("POST", "/pin/change", { old_pin: "4821", new_pin: "7345" }, s1);
    expect(ch.status).toBe(200);
    expect((await call("GET", "/me", undefined, s1)).status).toBe(401);
    expect((await call("GET", "/me", undefined, s2)).status).toBe(401);
    expect((await call("GET", "/me", undefined, ch.json.token)).status).toBe(200);
    // recovery
    const rq = await call("POST", "/pin/recover/request", { phone: PHONE });
    expect((await call("POST", "/pin/recover", { phone: PHONE, otp: rq.json.dev_otp, new_pin: "2468" })).status).toBe(200);
    expect((await call("GET", "/me", undefined, ch.json.token)).status).toBe(401);
  });

  it("@E2E-74 sessions expire after the configured TTL (default 7 days) and refresh while in use", async () => {
    const a = await signup(PHONE);
    const exp = () => new Date((getDb().prepare("SELECT expires_at FROM sessions").get() as { expires_at: string }).expires_at).getTime();
    const days = (exp() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9); expect(days).toBeLessThanOrEqual(7);
    getDb().prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ?").run(new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() - 3600_000).toISOString());
    expect((await call("GET", "/me", undefined, a.token)).status).toBe(200); // sliding refresh
    expect((exp() - Date.now()) / 86400000).toBeGreaterThan(6.9);
    getDb().prepare("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await call("GET", "/me", undefined, a.token)).status).toBe(401);
    expect(listSessions(a.id)).toHaveLength(0);
  });

  it("citizens have an empty roles array on /me", async () => {
    const a = await signup(PHONE);
    const me = await call("GET", "/me", undefined, a.token);
    expect(me.json.roles).toEqual([]);
    expect(me.json.person.role).toBe("resident");
  });
});

describe("trusted proxy and device attestation (S-60)", () => {
  it("@E2E-75 spoofed X-Device-Id / X-Asn do not change limits or lockout scoping", async () => {
    const a = await signup("+919876543499");
    process.env.CIVIC_OTP_NET_LIMIT = "3";
    const send = (phone: string, i: number) => call("POST", "/signup/request", { phone }, undefined, { "x-asn": "AS" + i, "x-device-id": "dev" + i, "x-forwarded-for": "10.9.9." + i });
    expect((await send("+919876543401", 1)).status).toBe(200);
    expect((await send("+919876543402", 2)).status).toBe(200);
    expect((await send("+919876543403", 3)).status).toBe(429); // rotating headers never opened a fresh bucket
    // lockout: the same IP with rotating device ids is ONE source
    const st: number[] = [];
    for (let i = 0; i < 5; i++) st.push((await call("POST", "/login", { phone: "+919876543499", pin: "9031", person_id: a.id }, undefined, { "x-device-id": "spoof" + i })).status);
    expect(st).toEqual([401, 401, 401, 401, 423]);
  });

  it("@E2E-75 a valid attestation token (dev stub) or the trusted edge makes the device id count; a forged token does not", async () => {
    const a = await signup(PHONE);
    const attempt = (headers: Record<string, string>, pin = "9031") => call("POST", "/login", { phone: PHONE, pin, person_id: a.id }, undefined, headers);
    // attested device ids are separate lockout sources
    const tokenA = devAttestationToken("devA");
    for (let i = 0; i < 5; i++) await attempt({ "x-attestation": tokenA });
    expect((await attempt({ "x-attestation": tokenA })).status).toBe(423);
    expect((await attempt({ "x-attestation": devAttestationToken("devB") }, "4821")).status).toBe(200); // other attested device unaffected
    const forged = devAttestationToken("devC").slice(0, -4) + "0000";
    // a forged token is treated as unverified = same source as plain requests, which are now the (unrelated) "no device" source
    expect((await attempt({ "x-attestation": forged }, "4821")).status).toBe(200);
    // trusted edge: only when the peer address is listed AND the edge header is present (and the shared secret matches when set)
    process.env.CIVIC_TRUSTED_EDGE_IPS = "127.0.0.1,::1";
    process.env.CIVIC_EDGE_SECRET = "edge-s3cret";
    const edge = { "x-device-id": "E1", "x-edge-verified": "1", "x-civic-edge": "edge-s3cret" };
    for (let i = 0; i < 5; i++) await attempt(edge);
    expect((await attempt(edge)).status).toBe(423);
    expect((await attempt({ ...edge, "x-device-id": "E2" }, "4821")).status).toBe(200); // believed: a different device
    expect((await attempt({ ...edge, "x-civic-edge": "wrong", "x-device-id": "E3" }, "4821")).status).toBe(200); // not believed: unverified source, not locked
  });

  it("@E2E-75 not-verified clients can be capped lower than verified ones (caps weighting only)", async () => {
    process.env.CIVIC_OTP_NET_LIMIT = "4";
    process.env.CIVIC_UNVERIFIED_CAP_FACTOR = "0.5";
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await call("POST", "/signup/request", { phone: "+91987654350" + i })).status);
    expect(codes).toEqual([200, 200, 429, 429]);
    resetDbForTests(); migrate();
    const ok: number[] = [];
    for (let i = 0; i < 4; i++) ok.push((await call("POST", "/signup/request", { phone: "+91987654360" + i }, undefined, { "x-attestation": devAttestationToken("dd") })).status);
    expect(ok).toEqual([200, 200, 200, 200]);
  });
});

describe("async scrypt (S-73)", () => {
  it("@E2E-88 keeps the stored format and constant-time verification", async () => {
    const s = hashPin("4821");
    expect((await hashPinAsync("4821", s.salt)).hash).toBe(s.hash);
    expect(await verifyPinAsync("4821", s.salt, s.hash)).toBe(true);
    expect(await verifyPinAsync("4822", s.salt, s.hash)).toBe(false);
    expect(verifyPin("4821", s.salt, s.hash)).toBe(true);
  });

  it("@E2E-88 the event loop stays responsive while 20 PINs hash", async () => {
    const s = hashPin("4821");
    let ticks = 0, maxGap = 0, last = Date.now();
    const timer = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 5);
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => verifyPinAsync(i % 2 ? "4821" : "0000", s.salt, s.hash)));
    const took = Date.now() - t0;
    clearInterval(timer);
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(ticks).toBeGreaterThan(Math.min(10, took / 40)); // timers kept firing during the work (sync scrypt would give ~0)
    expect(maxGap).toBeLessThan(Math.max(150, took / 2)); // no single multi-hash stall
  });
});

describe("volunteer enrolment over /identity (S-136)", () => {
  it("@E2E-151 /volunteer/enrol takes {phone, context}, /activate takes {code, otp, pin}; /attest/requests lists residents; shared SIM login lists members", async () => {
    const vol = await signup("+919000000001", "7391");
    getDb().prepare("UPDATE persons SET role='volunteer', org='orgQ' WHERE id=?").run(vol.id);
    expect((await call("POST", "/volunteer/enrol", { phone: "9111111111", context: "household", pin: "4821" }, vol.token)).json.code).toBe("pin_not_allowed");
    expect((await call("POST", "/volunteer/enrol", { phone: "9111111111", context: "village" }, vol.token)).status).toBe(400);
    const en = await call("POST", "/volunteer/enrol", { phone: "9111111111", context: "household" }, vol.token);
    expect(en.status).toBe(201); expect(en.json.status).toBe("pending");
    const { smsOutbox } = await import("../../server/civic/core");
    const text = smsOutbox.at(-1)!.text;
    const code = /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)![1], otp = /OTP: (\d{6})/.exec(text)![1];
    const act = await call("POST", "/activate", { code, otp, pin: "4821" });
    expect(act.status).toBe(201);
    expect(act.json.person.role).toBe("resident");
    expect((await call("GET", "/me", undefined, act.json.token)).status).toBe(200);
    expect((await call("GET", "/volunteer/enrolments", undefined, vol.token)).json.enrolments[0].status).toBe("activated");
    // attest queue: a resident who declared a residence shows up for another volunteer, never for the enroller
    await call("POST", "/residence", { residence: "Rayavaram", unit_id: "v-1" }, act.json.token);
    const v2 = await signup("+919000000002", "7391");
    getDb().prepare("UPDATE persons SET role='volunteer', org='orgR' WHERE id=?").run(v2.id);
    expect((await call("GET", "/attest/requests", undefined, v2.token)).json.requests).toEqual([{ person_id: act.json.person.id, label: null, village: "v-1" }]);
    expect((await call("GET", "/attest/requests", undefined, vol.token)).json.requests).toEqual([]);
    expect((await call("GET", "/attest/requests", undefined, act.json.token)).status).toBe(403);
    // shared SIM: person_required carries the member list
    await call("POST", "/sim/link", { pin: "7345", label: "Appa", consent_version: "v1" }, vol.token);
    const need = await call("POST", "/login", { phone: "+919000000001", pin: "7391" });
    expect(need.status).toBe(400);
    expect(need.json.code).toBe("person_required");
    expect(need.json.members).toHaveLength(2);
    expect(Object.keys(need.json.members[0]).sort()).toEqual(["label", "locked", "person_id"]);
  });
});
