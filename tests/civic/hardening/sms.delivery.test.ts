/** S-164 (@E2E-188): the OTP request says what really happened (sent / queued / failed) and a failed send can be retried at once. */
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, migrate, resetDbForTests, setSmsProvider, type SmsProvider } from "../../../server/civic/core";
import { resetDegradedForTests } from "../../../server/degraded";
import { startMockSmsServer, type MockSmsServer } from "../../../server/civic/providers/mock/smsServer";
import { HttpSmsProvider, ManagedSmsProvider, setSmsGateway, type SmsSubmit, type SmsTransport } from "../../../server/civic/providers/sms";
import { ProviderError, setProviderLogger } from "../../../server/civic/providers/util";
import { caller, serveIdentity } from "./helpers";

let server: Server, call: ReturnType<typeof caller>, mock: MockSmsServer;
beforeAll(async () => { const s = await serveIdentity(); server = s.server; call = caller(s.base); mock = await startMockSmsServer(); });
afterAll(async () => { server.close(); await mock.close(); });
beforeEach(() => { process.env.CIVIC_EXPOSE_DEV_OTP = "1"; resetDbForTests(); migrate(); resetDegradedForTests(); setProviderLogger(() => undefined); mock.mode = "ok"; });
afterEach(() => { setSmsProvider(null); setSmsGateway(null); setProviderLogger(null); resetDbForTests(); delete process.env.CIVIC_EXPOSE_DEV_OTP; });

const PHONE = "+919876500041";
const otpRows = () => (getDb().prepare("SELECT COUNT(*) AS c FROM otps").get() as { c: number }).c;
const transport = (fn: (m: SmsSubmit, n: number) => Promise<{ messageId: string; status: "queued" | "sent" | "delivered" | "failed" }>): SmsTransport & { calls: number } => {
  const t = { name: "scripted", calls: 0, submit: async (m: SmsSubmit) => { t.calls++; return fn(m, t.calls); } };
  return t;
};
const managed = (t: SmsTransport) => new ManagedSmsProvider(t, { backoffBaseMs: 60_000, maxAttempts: 3 });

describe("honest SMS state on the OTP request (S-164)", () => {
  it("@E2E-188 the dev provider and a vendor that reports sent: delivery is 'sent'", async () => {
    const dev = await call("POST", "/signup/request", { phone: PHONE });
    expect(dev.json).toMatchObject({ ok: true, delivery: "sent" });
    getDb().prepare("DELETE FROM otps").run();
    setSmsProvider(managed(transport(async (_m, n) => ({ messageId: "m" + n, status: "sent" }))));
    const sent = await call("POST", "/signup/request", { phone: "+919876500042" });
    expect(sent.json).toMatchObject({ ok: true, delivery: "sent" });
  });

  it("@E2E-188 a vendor that only accepted the message answers 'queued' (not 'sent')", async () => {
    setSmsProvider(new HttpSmsProvider({ url: mock.url, secret: mock.secret }));
    const r = await call("POST", "/signup/request", { phone: PHONE });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, delivery: "queued" });
    expect(mock.received.at(-1)?.to).toBe(PHONE);
  });

  it("@E2E-188 vendor down (retryable): the code is kept, delivery is 'queued' and the provider will retry; never 'sent'", async () => {
    mock.mode = "error500";
    setSmsProvider(new HttpSmsProvider({ url: mock.url, secret: mock.secret, backoffBaseMs: 60_000 }));
    const r = await call("POST", "/signup/request", { phone: PHONE });
    expect(r.status).toBe(200);
    expect(r.json.delivery).toBe("queued");
    expect(otpRows()).toBe(1);
  });

  it("@E2E-188 vendor rejects the message (not retryable): 502 with delivery 'failed', the code is dropped, and a resend works at once", async () => {
    mock.mode = "reject400";
    setSmsProvider(new HttpSmsProvider({ url: mock.url, secret: mock.secret }));
    const bad = await call("POST", "/signup/request", { phone: PHONE });
    expect(bad.status).toBe(502);
    expect(bad.json).toMatchObject({ delivery: "failed", can_retry: true });
    expect(bad.json.dev_otp).toBeUndefined();
    expect(otpRows()).toBe(0);
    // vendor recovers: no 5 minute wait, no already_sent trap
    mock.mode = "ok";
    const again = await call("POST", "/signup/request", { phone: PHONE });
    expect(again.status).toBe(200);
    expect(again.json.already_sent).toBeUndefined();
    expect(again.json.delivery).toBe("queued");
    expect(otpRows()).toBe(1);
  });

  it("@E2E-188 a provider whose send() throws (v1 contract) is reported as failed too, and the resend still respects the per-phone cap and the SMS budget", async () => {
    let up = false;
    const flaky: SmsProvider = { send: async () => { if (!up) throw new Error("gateway down"); } };
    setSmsProvider(flaky);
    expect((await call("POST", "/signup/request", { phone: PHONE })).status).toBe(502);
    expect((await call("POST", "/signup/request", { phone: PHONE })).status).toBe(502);
    expect((await call("POST", "/signup/request", { phone: PHONE })).status).toBe(502);
    expect((await call("POST", "/signup/request", { phone: PHONE })).status).toBe(429); // the 3-per-10-minutes cap still applies after failures
    up = true;
    process.env.CIVIC_SMS_HOURLY_BUDGET = "4"; // the three failed sends already spent three
    const other = await call("POST", "/signup/request", { phone: "+919876500043" });
    expect(other.status).toBe(200);
    expect((await call("POST", "/signup/request", { phone: "+919876500044" })).status).toBe(429); // budget spent by the first successful send
    delete process.env.CIVIC_SMS_HOURLY_BUDGET;
  });

  it("@E2E-188 a dead letter after the retries are used up and a vendor-reported 'failed' both map to failed", async () => {
    setSmsProvider(managed(transport(async () => { throw new ProviderError("bad", "bad_response"); })));
    const dead = await call("POST", "/signup/request", { phone: PHONE });
    expect(dead.status).toBe(502);
    expect(dead.json.delivery).toBe("failed");
    setSmsProvider(managed(transport(async (_m, n) => ({ messageId: "x" + n, status: "failed" as const }))));
    const failed = await call("POST", "/signup/request", { phone: "+919876500045" });
    expect(failed.status).toBe(502);
    expect(failed.json.delivery).toBe("failed");
  });

  it("@E2E-188 recovery requests use the same honest answer", async () => {
    mock.mode = "reject400";
    setSmsProvider(new HttpSmsProvider({ url: mock.url, secret: mock.secret }));
    const r = await call("POST", "/pin/recover/request", { phone: PHONE });
    expect(r.status).toBe(502);
    expect(r.json.delivery).toBe("failed");
  });
});
