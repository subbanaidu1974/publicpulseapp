import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannelsRouter, type ChannelDeps } from "../../server/civic/channels/routes";
import { webhookSignature } from "../../server/civic/channels/webhook";

const SECRET = "test-aggregator-secret";
const deps: ChannelDeps = {
  now: () => Date.now(),
  sendSms: async () => undefined,
  createIssue: async () => ({ id: "ISS-1" }),
  listAdults: async () => [],
};
const ENV = ["CIVIC_IVR_WEBHOOK_SECRET", "CIVIC_IVR_ALLOWED_IPS", "NODE_ENV"];
const saved: Record<string, string | undefined> = {};
let server: Server, base = "";

beforeAll(async () => {
  const app = express();
  app.use("/channels", createChannelsRouter(deps));
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/channels`;
});
afterAll(() => { server.close(); });
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; delete process.env.CIVIC_IVR_WEBHOOK_SECRET; delete process.env.CIVIC_IVR_ALLOWED_IPS; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** Raw POST with optional signature headers (signed over `${ts}.${body}`). */
async function send(p: string, body: unknown, opts: { sign?: boolean; ts?: number; headers?: Record<string, string> } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.sign) {
    const ts = String(opts.ts ?? Date.now());
    headers["x-civic-timestamp"] = ts;
    headers["x-civic-signature"] = webhookSignature(SECRET, ts, raw);
  }
  const r = await fetch(base + p, { method: "POST", headers, body: raw });
  return { status: r.status, body: (await r.json()) as any, headers, raw };
}

describe("webhook authentication for the aggregator endpoints (S-56)", () => {
  it("@E2E-71 a valid signed call works and is bound to the aggregator's own call id", async () => {
    process.env.CIVIC_IVR_WEBHOOK_SECRET = SECRET;
    const mc = await send("/missed-call", { from: "9876500201", aggregatorCallId: "AGG-0001-xyz" }, { sign: true });
    expect(mc.status).toBe(202);
    expect(mc.body.callId).toBe("AGG-0001-xyz");
    const turn = await send("/ivr", { callId: "AGG-0001-xyz" }, { sign: true });
    expect(turn.status).toBe(200);
    expect(turn.body.state).toBe("welcome");
    // the same aggregator id cannot be registered twice
    expect((await send("/missed-call", { from: "9876500202", aggregatorCallId: "AGG-0001-xyz" }, { sign: true })).status).toBe(409);
  });

  it("@E2E-71 an authenticated aggregator must supply its call id", async () => {
    process.env.CIVIC_IVR_WEBHOOK_SECRET = SECRET;
    expect((await send("/missed-call", { from: "9876500203" }, { sign: true })).status).toBe(400);
  });

  it("@E2E-71 forged calls are rejected: no signature, wrong signature, wrong secret, stale timestamp, altered body", async () => {
    process.env.CIVIC_IVR_WEBHOOK_SECRET = SECRET;
    expect((await send("/missed-call", { from: "9876500204", aggregatorCallId: "AGG-forged-1" })).status).toBe(401);
    const bad = { "x-civic-timestamp": String(Date.now()), "x-civic-signature": "0".repeat(64) };
    expect((await send("/missed-call", { from: "9876500204", aggregatorCallId: "AGG-forged-1" }, { headers: bad })).status).toBe(401);
    const ts = String(Date.now()), raw = JSON.stringify({ callId: "AGG-forged-1" });
    const wrongSecret = { "x-civic-timestamp": ts, "x-civic-signature": webhookSignature("other-secret", ts, raw) };
    expect((await send("/ivr", { callId: "AGG-forged-1" }, { headers: wrongSecret })).status).toBe(401);
    expect((await send("/ivr", { callId: "AGG-forged-1" }, { sign: true, ts: Date.now() - 10 * 60_000 })).status).toBe(401);
    const t2 = String(Date.now());
    const tampered = { "x-civic-timestamp": t2, "x-civic-signature": webhookSignature(SECRET, t2, JSON.stringify({ from: "9876500204", aggregatorCallId: "AGG-orig-111" })) };
    expect((await send("/missed-call", { from: "9876500204", aggregatorCallId: "AGG-evil-111" }, { headers: tampered })).status).toBe(401);
    // nothing was created by the forged attempts
    expect((await send("/ivr", { callId: "AGG-forged-1" }, { sign: true })).status).toBe(404);
  });

  it("@E2E-71 a replayed signed request is rejected", async () => {
    process.env.CIVIC_IVR_WEBHOOK_SECRET = SECRET;
    const first = await send("/missed-call", { from: "9876500205", aggregatorCallId: "AGG-replay-1" }, { sign: true });
    expect(first.status).toBe(202);
    const replay = await fetch(base + "/missed-call", { method: "POST", headers: first.headers, body: first.raw });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).reason).toBe("replay");
  });

  it("@E2E-71 IP allow-list admits listed sources and rejects others", async () => {
    process.env.CIVIC_IVR_ALLOWED_IPS = "10.9.9.9";
    expect((await send("/missed-call", { from: "9876500206", aggregatorCallId: "AGG-ip-0001" })).status).toBe(401);
    process.env.CIVIC_IVR_ALLOWED_IPS = "10.9.9.9, 127.0.0.1";
    expect((await send("/missed-call", { from: "9876500206", aggregatorCallId: "AGG-ip-0001" })).status).toBe(202);
  });

  it("@E2E-71 production with no secret or allow-list fails closed; dev allows it", async () => {
    process.env.NODE_ENV = "production";
    expect((await send("/missed-call", { from: "9876500207" })).status).toBe(401);
    expect((await send("/ivr", { callId: "whatever" })).status).toBe(401);
    expect((await send("/voice-note", { from: "9876500207", audioKey: "voice/a.wav" })).status).toBe(401);
    process.env.NODE_ENV = "test";
    expect((await send("/missed-call", { from: "9876500207" })).status).toBe(202);
  });

  it("webhookSignature is HMAC-SHA256 over timestamp.body", () => {
    expect(webhookSignature("k", "1", "{}")).toBe(crypto.createHmac("sha256", "k").update("1.{}").digest("hex"));
  });
});
