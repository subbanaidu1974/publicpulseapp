import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { migrate, resetDbForTests } from "../../../server/civic/core";
import { identityRouter } from "../../../server/civic/identity/routes";
import { resetDegradedForTests } from "../../../server/degraded";
import { shedFrom } from "../../../src/lib/degraded";

let server: Server, base = "";
beforeAll(async () => {
  const app = express();
  app.use("/id", identityRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/id`;
});
afterAll(() => { server.close(); });
const ENV = ["CIVIC_SMS_HOURLY_BUDGET", "CIVIC_OTP_MIN_BURST", "CIVIC_OTP_QUEUE_MAX", "CIVIC_OTP_SMOOTH_FACTOR"];
beforeEach(() => { resetDbForTests(); migrate(); resetDegradedForTests(); });
afterEach(() => { for (const k of ENV) delete process.env[k]; resetDegradedForTests(); });

const request = async (phone: string) => {
  const r = await fetch(base + "/signup/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
  return { status: r.status, retry: r.headers.get("retry-after"), json: (await r.json()) as Record<string, any> };
};

describe("OTP refusals carry bilingual notices (S-156)", () => {
  it("@E2E-171 the 429 'sms capacity reached' answer has notice_en and notice_te, and the sign-up client prefers them", async () => {
    process.env.CIVIC_SMS_HOURLY_BUDGET = "1";
    expect((await request("+919876543210")).status).toBe(200);
    const r = await request("+919876543211");
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ degraded: true, error: expect.stringMatching(/sms capacity/) });
    expect(r.json.notice_en).toMatch(/paused|try again/i);
    expect(r.json.notice_te).toMatch(/[ఀ-౿]/);
    const shed = shedFrom(429, r.json, r.retry);
    expect(shed?.notice_en).toBe(r.json.notice_en);
    expect(shed?.notice_te).toBe(r.json.notice_te);
  });

  it("@E2E-171 the 503 'sms queue is full' answer has notice_en and notice_te with a retry hint", async () => {
    process.env.CIVIC_SMS_HOURLY_BUDGET = "100";
    process.env.CIVIC_OTP_MIN_BURST = "1"; process.env.CIVIC_OTP_QUEUE_MAX = "0"; process.env.CIVIC_OTP_SMOOTH_FACTOR = "0";
    expect((await request("+919876543210")).status).toBe(200);
    const r = await request("+919876543211");
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ degraded: true, retry_after_seconds: expect.any(Number) });
    expect(r.json.notice_en).toBeTruthy();
    expect(r.json.notice_te).toMatch(/[ఀ-౿]/);
    const shed = shedFrom(503, r.json, r.retry);
    expect(shed?.notice_te).toBe(r.json.notice_te);
    expect(shed?.retry_after_s).toBe(r.json.retry_after_seconds);
  });
});
