import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getDb, migrate, resetDbForTests, smsOutbox } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { issuesRouter } from "../../server/civic/issues/routes";
import { createPerson } from "../../server/civic/identity/service";
import { createChannelsRouter, ChannelError } from "../../server/civic/channels/routes";

/** Real issues module, real identity data, real dev SMS: missed call -> IVR -> voice note -> issue + reference SMS. */
let server: Server;
let base = "";
const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  resetDbForTests(); migrate(); loadDemoGeo();
  const app = express();
  app.use("/api/v1/civic/issues", express.json(), issuesRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.CIVIC_INTERNAL_BASE = base;
  const chan = express();
  chan.use("/channels", createChannelsRouter());
  const s2 = chan.listen(0, "127.0.0.1");
  await new Promise((r) => s2.once("listening", r));
  base = base; // issues base kept in env; channels base below
  (globalThis as any).__chan = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/channels`;
  (globalThis as any).__s2 = s2;
});
afterAll(() => { server.close(); (globalThis as any).__s2.close(); });

const chanPost = async (p: string, body: unknown) => {
  const r = await fetch((globalThis as any).__chan + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

describe("channels with the real issues and identity modules (@E2E-55)", () => {
  it("@E2E-55 registered caller: voice note creates a real issue and the reference SMS carries its id", async () => {
    const p = createPerson({ phone: "+919876500001", pin: "4821", consentVersion: "v1" });
    getDb().prepare("UPDATE persons SET residence_unit = ?, residence_declared_at = ? WHERE id = ?").run("DEMO-V-KLR", new Date().toISOString(), p.id);
    const { body: mc } = await chanPost("/missed-call", { from: "9876500001" });
    await chanPost("/ivr", { callId: mc.callId });
    expect((await chanPost("/ivr", { callId: mc.callId, digits: "1" })).body).toMatchObject({ state: "pin", sensitive: true }); // PIN is required by default (S-56)
    await chanPost("/ivr", { callId: mc.callId, digits: "4821" });
    await chanPost("/ivr", { callId: mc.callId, digits: "1" });
    const done = await chanPost("/ivr", { callId: mc.callId, recording: "voice/real-1.wav" });
    expect(done.body.state).toBe("done");
    const row = getDb().prepare("SELECT category, village_lgd, photo_ref, reporter_id FROM issue WHERE id = ?").get(done.body.referenceId) as any;
    expect(row).toMatchObject({ category: "water", village_lgd: "DEMO-V-KLR", photo_ref: "voice/real-1.wav", reporter_id: p.id });
    const sms = smsOutbox.filter((m) => m.to === "+919876500001").at(-1)!;
    expect(sms.text).toContain(done.body.referenceId);
  });

  it("unregistered caller: no issue, an SMS pointing to the app, and no leak", async () => {
    const before = (getDb().prepare("SELECT COUNT(*) c FROM issue").get() as any).c;
    const { body: mc } = await chanPost("/missed-call", { from: "9876500002" });
    for (const d of ["", "1", "2"]) await chanPost("/ivr", d ? { callId: mc.callId, digits: d } : { callId: mc.callId });
    const done = await chanPost("/ivr", { callId: mc.callId, recording: "voice/x.wav" });
    expect(done.body.error).toBe("not_registered");
    expect((getDb().prepare("SELECT COUNT(*) c FROM issue").get() as any).c).toBe(before);
    expect(smsOutbox.at(-1)!.text).toMatch(/sign up/i);
  });

  it("ChannelError codes are exported for adapters", () => {
    expect(new ChannelError("pin_required").code).toBe("pin_required");
  });
});
