import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reporterPseudonym } from "../../server/civic/core/pseudonyms";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getDb, migrate, resetDbForTests, smsOutbox, getStore } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { issuesRouter } from "../../server/civic/issues/routes";
import { createPerson, isLockedAnywhere } from "../../server/civic/identity/service";
import { createChannelsRouter } from "../../server/civic/channels/routes";

/** Shared SIM over IVR: which adult, then the personal PIN (5-attempt lockout shared with app sign-in). Real issues + identity modules. */
let issuesServer: Server, chanServer: Server, chan = "";
const PHONE = "+919876500123", LOCAL = "9876500123";
const PIN_A = "4821", PIN_B = "7345";
let a: { id: string }, b: { id: string };

const post = async (p: string, body: unknown) => {
  const r = await fetch(chan + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const fails = (id: string) => ((getDb().prepare("SELECT COALESCE(SUM(failed),0) f FROM pin_failures WHERE person_id=?").get(id) as any).f as number);
const issueCount = () => (getStore("issues").prepare("SELECT COUNT(*) c FROM issue").get() as any).c as number;
async function newCall(from = LOCAL) {
  const { body } = await post("/missed-call", { from });
  return body.callId as string;
}
async function toWho(callId: string) {
  await post("/ivr", { callId });
  return post("/ivr", { callId, digits: "1" });
}

beforeAll(async () => {
  resetDbForTests(); migrate(); loadDemoGeo();
  const app = express();
  app.use("/api/v1/civic/issues", express.json(), issuesRouter);
  issuesServer = app.listen(0, "127.0.0.1");
  await new Promise((r) => issuesServer.once("listening", r));
  process.env.CIVIC_INTERNAL_BASE = `http://127.0.0.1:${(issuesServer.address() as AddressInfo).port}`;
});
afterAll(() => { issuesServer.close(); delete process.env.CIVIC_IVR_PIN_ALWAYS; });
afterEach(() => { chanServer.close(); });
beforeEach(async () => {
  // a fresh router per test: the missed-call limiter is per router instance
  const c = express();
  c.use("/channels", createChannelsRouter());
  chanServer = c.listen(0, "127.0.0.1");
  await new Promise((r) => chanServer.once("listening", r));
  chan = `http://127.0.0.1:${(chanServer.address() as AddressInfo).port}/channels`;
  resetDbForTests(); migrate(); loadDemoGeo();
  smsOutbox.length = 0;
  a = createPerson({ phone: PHONE, pin: PIN_A, label: "Amma", consentVersion: "v1" });
  b = createPerson({ phone: PHONE, pin: PIN_B, label: "Appa", consentVersion: "v1" });
  getDb().prepare("UPDATE persons SET created_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", a.id); // fixed order: Amma is adult 1
  getDb().prepare("UPDATE persons SET created_at=? WHERE id=?").run("2026-01-02T00:00:00.000Z", b.id);
  const set = getDb().prepare("UPDATE persons SET residence_unit=?, residence_declared_at=? WHERE id=?");
  set.run("DEMO-V-KLR", new Date().toISOString(), a.id);
  set.run("DEMO-V-BPL", new Date().toISOString(), b.id);
  delete process.env.CIVIC_IVR_PIN_ALWAYS;
});

describe("IVR on a shared SIM: which adult, then personal PIN (S-45)", () => {
  it("@E2E-55 asks who, then the PIN, then files the issue as that adult in their own village", async () => {
    const callId = await newCall();
    const who = await toWho(callId);
    expect(who.body).toMatchObject({ state: "who", expect: "digit", adults: 2 });
    expect(who.body.prompts[0].textTe).toMatch(/[ఀ-౿]/);

    const pin = await post("/ivr", { callId, digits: "2" });
    expect(pin.body).toMatchObject({ state: "pin", expect: "digit", sensitive: true });
    expect(pin.body.xml).toContain('numDigits="6"');
    expect(pin.body.xml).toContain('secret="true"');

    const wrong = await post("/ivr", { callId, digits: PIN_A }); // the other adult's PIN does not open Appa's identity
    expect(wrong.body.state).toBe("pin");
    expect(wrong.body.prompts.map((p: any) => p.id)).toEqual(["pinWrong", "pin"]);
    const ok = await post("/ivr", { callId, digits: PIN_B });
    expect(ok.body.state).toBe("category");
    expect(issueCount()).toBe(0); // nothing filed before verification

    await post("/ivr", { callId, digits: "2" });
    const done = await post("/ivr", { callId, recording: "voice/shared-1.wav" });
    expect(done.body.state).toBe("done");
    const row = getStore("issues").prepare("SELECT reporter_id, village_lgd, category FROM issue WHERE id=?").get(done.body.referenceId) as any;
    expect(row).toMatchObject({ reporter_id: reporterPseudonym(done.body.referenceId, b.id), village_lgd: "DEMO-V-BPL", category: "roads" });
    expect(smsOutbox.at(-1)!.text).toContain(done.body.referenceId);
  });

  it("the first adult uses their own PIN; positions outside 1..n are re-asked", async () => {
    const callId = await newCall();
    await toWho(callId);
    expect((await post("/ivr", { callId, digits: "3" })).body.prompts.map((p: any) => p.id)).toEqual(["invalid", "who"]);
    expect((await post("/ivr", { callId, digits: "0" })).body.state).toBe("who");
    expect((await post("/ivr", { callId, digits: "1" })).body.state).toBe("pin");
    expect((await post("/ivr", { callId, digits: PIN_A })).body.state).toBe("category");
    await post("/ivr", { callId, digits: "1" });
    const done = await post("/ivr", { callId, recording: "voice/shared-2.wav" });
    expect((getStore("issues").prepare("SELECT reporter_id FROM issue WHERE id=?").get(done.body.referenceId) as any).reporter_id).toBe(reporterPseudonym(done.body.referenceId, a.id));
  });

  it("cannot skip the steps: a recording before the PIN files nothing", async () => {
    const callId = await newCall();
    await toWho(callId);
    expect((await post("/ivr", { callId, recording: "voice/sneaky.wav" })).body.state).toBe("who");
    await post("/ivr", { callId, digits: "1" });
    expect((await post("/ivr", { callId, recording: "voice/sneaky.wav" })).body.state).toBe("pin");
    expect(issueCount()).toBe(0);
  });

  it("malformed PINs are re-asked without counting as an attempt; 4 wrong then right resets the counter", async () => {
    const callId = await newCall();
    await toWho(callId); await post("/ivr", { callId, digits: "1" });
    expect((await post("/ivr", { callId, digits: "12" })).body.prompts[0].id).toBe("invalid");
    expect(fails(a.id)).toBe(0);
    for (const bad of ["1111", "2222", "3333", "4444"]) expect((await post("/ivr", { callId, digits: bad })).body.prompts[0].id).toBe("pinWrong");
    expect(fails(a.id)).toBe(4);
    expect((await post("/ivr", { callId, digits: PIN_A })).body.state).toBe("category");
    expect(fails(a.id)).toBe(0);
  });

  it("locks after 5 wrong PINs across calls, tells the SIM holder; never echoes a PIN", async () => {
    let last: any;
    for (let call = 0; call < 2; call++) {
      const callId = await newCall();
      await toWho(callId); await post("/ivr", { callId, digits: "1" });
      for (const bad of call === 0 ? ["1111", "2222", "3333"] : ["4444", "5555"]) last = await post("/ivr", { callId, digits: bad });
    }
    expect(last.body).toMatchObject({ state: "goodbye", error: "pin_locked" });
    expect(last.body.prompts.map((p: any) => p.id)).toEqual(["locked", "goodbye"]);
    expect(isLockedAnywhere(a.id)).toBe(true);
    expect(smsOutbox.some((m) => m.to === PHONE && /locked/i.test(m.text))).toBe(true);
    // even the correct PIN is refused on this source while locked
    const callId = await newCall();
    await toWho(callId); await post("/ivr", { callId, digits: "1" });
    const refused = await post("/ivr", { callId, digits: PIN_A });
    expect(refused.body).toMatchObject({ state: "goodbye", error: "pin_locked" });
    expect(issueCount()).toBe(0);
    // the other adult on the same SIM is unaffected
    chanServer.close(); // fresh router (the missed-call limiter is per instance)
    const c2 = express(); c2.use("/channels", createChannelsRouter());
    chanServer = c2.listen(0, "127.0.0.1");
    await new Promise((r) => chanServer.once("listening", r));
    chan = `http://127.0.0.1:${(chanServer.address() as AddressInfo).port}/channels`;
    const other = await newCall();
    await toWho(other); await post("/ivr", { callId: other, digits: "2" });
    expect((await post("/ivr", { callId: other, digits: PIN_B })).body.state).toBe("category");
    // no PIN digits anywhere in outgoing texts or replies
    for (const m of smsOutbox) for (const pin of [PIN_A, PIN_B, "1111", "2222", "3333", "4444", "5555"]) expect(m.text).not.toContain(pin);
    expect(JSON.stringify(refused.body)).not.toMatch(/4821|7345/);
    const audits = getStore("audit").prepare("SELECT meta, object, action FROM audit_log WHERE action LIKE 'ivr_pin%' OR action='pin.lockout'").all() as any[];
    expect(JSON.stringify(audits)).not.toMatch(/4821|7345|1111|2222|3333|4444|5555/);
  });

  it("never sends or reads out an OTP: no code-bearing SMS, no OTP prompt, and the welcome says it never asks", async () => {
    const callId = await newCall();
    await toWho(callId); await post("/ivr", { callId, digits: "2" }); await post("/ivr", { callId, digits: PIN_B });
    await post("/ivr", { callId, digits: "1" });
    await post("/ivr", { callId, recording: "voice/x.wav" });
    for (const m of smsOutbox) expect(m.text).not.toMatch(/\b\d{6}\b|code:/i);
    const welcome = await post("/ivr", { callId: await newCall() });
    expect(welcome.body.prompts[0].textEn).toMatch(/never ask for your OTP/i);
    const prompts = await import("../../server/civic/channels/routes");
    for (const [id, p] of Object.entries(prompts.PROMPTS)) if (id !== "welcome") expect(p.textEn).not.toMatch(/\botp\b|one.time/i);
  });

  it("@E2E-71 single-adult SIMs must give the PIN by default; the short flow needs CIVIC_IVR_PIN_ALWAYS=0", async () => {
    const solo = createPerson({ phone: "+919876500777", pin: "5566", consentVersion: "v1" });
    getDb().prepare("UPDATE persons SET residence_unit='DEMO-V-KLR', residence_declared_at=? WHERE id=?").run(new Date().toISOString(), solo.id);
    process.env.CIVIC_IVR_PIN_ALWAYS = "0";
    let callId = await newCall("9876500777");
    await post("/ivr", { callId });
    expect((await post("/ivr", { callId, digits: "1" })).body.state).toBe("category");

    delete process.env.CIVIC_IVR_PIN_ALWAYS;
    callId = await newCall("9876500777");
    await post("/ivr", { callId });
    expect((await post("/ivr", { callId, digits: "1" })).body).toMatchObject({ state: "pin", sensitive: true });
    expect((await post("/ivr", { callId, digits: "5566" })).body.state).toBe("category");
  });

  it("the standalone voice-note endpoint still refuses a shared SIM (no PIN step there)", async () => {
    const r = await post("/voice-note", { from: LOCAL, audioKey: "voice/x.wav" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("pin_required");
  });
});
