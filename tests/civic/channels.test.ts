import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createChannelsRouter, PROMPTS, type ChannelDeps } from "../../server/civic/channels/routes";

const manifest = JSON.parse(readFileSync("data/civic/audio-manifest.json", "utf8")) as { prompts: { id: string; file: string; textTe: string }[] };

let server: Server;
let base = "";
const sms: { to: string; text: string }[] = [];
const issues: Record<string, unknown>[] = [];
let clock = 1_000_000;
const deps: ChannelDeps = {
  now: () => clock,
  sendSms: async (to, text) => { sms.push({ to, text }); },
  createIssue: async (i) => { issues.push(i as unknown as Record<string, unknown>); return { id: `ISS-${issues.length}` }; },
};

beforeAll(async () => {
  const app = express();
  app.use("/channels", createChannelsRouter(deps));
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/channels`;
});
afterAll(() => { server.close(); });

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

describe("channels: missed call, Telugu IVR, voice-note issue (@E2E-55)", () => {
  it("@E2E-55 missed call -> Telugu menu -> category -> voice note creates an issue and sends reference SMS", async () => {
    const mc = await post("/missed-call", { from: "9876543210" });
    expect(mc.status).toBe(202);
    expect(mc.body.callbackTo).not.toContain("9876543210");
    const callId = mc.body.callId as string;
    expect(sms).toHaveLength(0); // callback is free; no OTP/SMS at this point

    const menu = await post("/ivr", { callId });
    expect(menu.body.state).toBe("welcome");
    expect(menu.body.prompts[0].textTe).toMatch(/[\u0C00-\u0C7F]/);
    expect(menu.body.prompts[0].audioKey).toBe("audio/te/welcome.wav");
    expect(menu.body.xml).toContain("<Gather");

    expect((await post("/ivr", { callId, digits: "1" })).body.state).toBe("category");
    const bad = await post("/ivr", { callId, digits: "0" });
    expect(bad.body.state).toBe("category");
    expect(bad.body.prompts[0].id).toBe("invalid");
    const rec = await post("/ivr", { callId, digits: "1" });
    expect(rec.body.state).toBe("record");
    expect(rec.body.expect).toBe("recording");
    expect(rec.body.xml).toContain("<Record");

    const done = await post("/ivr", { callId, recording: "voice/abc123.wav" });
    expect(done.body.state).toBe("done");
    expect(done.body.referenceId).toBe("ISS-1");
    expect(issues[0]).toMatchObject({ channel: "ivr", category: "water", phone: "9876543210", audioKey: "voice/abc123.wav" });
    expect(sms).toHaveLength(1);
    expect(sms[0].text).toContain("ISS-1");
    expect(sms[0].text).toMatch(/never ask for OTP/i);
  });

  it("rejects invalid numbers and unknown calls; rate limits repeated missed calls", async () => {
    expect((await post("/missed-call", { from: "12345" })).status).toBe(400);
    expect((await post("/ivr", { callId: "nope" })).status).toBe(404);
    for (let i = 0; i < 3; i++) expect((await post("/missed-call", { from: "9123456780" })).status).toBe(202);
    expect((await post("/missed-call", { from: "9123456780" })).status).toBe(429);
    clock += 3_700_000;
    expect((await post("/missed-call", { from: "9123456780" })).status).toBe(202);
  });

  it("IVR survey is limited to a service topic and never election questions", async () => {
    const { body } = await post("/missed-call", { from: "9000000001" });
    const s = await post("/ivr", { callId: body.callId, digits: "3" });
    expect(s.body.state).toBe("survey");
    expect(PROMPTS.survey.textEn).toMatch(/water supply/i);
    for (const p of Object.values(PROMPTS)) expect(p.textEn).not.toMatch(/vote|party|election|candidate/i);
  });

  it("voice-note endpoint validates and creates an issue", async () => {
    expect((await post("/voice-note", { from: "9000000002", audioKey: "../etc/passwd" })).status).toBe(400);
    const ok = await post("/voice-note", { from: "9000000002", audioKey: "voice/x.wav", category: "roads" });
    expect(ok.status).toBe(201);
    expect(issues.at(-1)).toMatchObject({ category: "roads" });
  });

  it("audio manifest covers every prompt, flagged as placeholder, and USSD is not built", () => {
    const ids = manifest.prompts.map((p) => p.id).sort();
    expect(ids).toEqual(Object.keys(PROMPTS).sort());
    for (const p of manifest.prompts) { expect(p.file).toBe(`audio/te/${p.id}.wav`); expect(p.textTe).toBe(PROMPTS[p.id].textTe); }
    const src = readFileSync("server/civic/channels/routes.ts", "utf8");
    expect(src).not.toMatch(/r\.(post|get)\(["']\/ussd/);
  });
});
