import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, migrate, resetDbForTests } from "../../../server/civic/core";
import { startMockSmsServer } from "../../../server/civic/providers/mock/smsServer";
import {
  HttpSmsProvider, ManagedSmsProvider, SmsTemplateRegistry, createSmsReceiptRouter, defaultCivicTemplates, normalizeSmsStatus, setSmsGateway, smsDegraded, smsSegments,
  type SmsGatewayOpts, type SmsSubmit, type SmsTransport,
} from "../../../server/civic/providers/sms";
import { ProviderError, setProviderLogger, signedHeaders } from "../../../server/civic/providers/util";
import { runSmsProviderContract, type SmsHarness } from "./contract/sms.contract";

const RECEIPT_SECRET = "receipt-secret-test";

/** Certifies the neutral HttpSmsProvider against the reference mock vendor: the template for every vendor adapter. */
runSmsProviderContract("HttpSmsProvider + reference mock", async (o: SmsGatewayOpts): Promise<SmsHarness> => {
  const mock = await startMockSmsServer();
  const app = express();
  app.use("/sms-receipt", createSmsReceiptRouter());
  let srv!: Server;
  await new Promise<void>((r) => { srv = app.listen(0, "127.0.0.1", r); });
  const cb = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/sms-receipt`;
  const provider = new HttpSmsProvider({ ...o, url: mock.url, secret: mock.secret, receiptSecret: RECEIPT_SECRET, callbackUrl: cb });
  setSmsGateway(provider);
  return {
    provider,
    setMode: (m) => { mock.mode = m; },
    received: () => mock.received.map((r) => ({ ...r, templateId: r.templateId, dltTemplateId: r.dltTemplateId })),
    requests: () => mock.requests,
    deliverReceipt: (id, status, errorCode) => mock.sendReceipt(cb, RECEIPT_SECRET, [{ message_id: id, status, ...(errorCode ? { error_code: errorCode } : {}) }]),
    deliverForgedReceipt: async (id, status) => (await fetch(cb, { method: "POST", headers: { "content-type": "application/json", "x-civic-timestamp": String(Date.now()), "x-civic-signature": "sha256=" + "0".repeat(64) }, body: JSON.stringify({ receipts: [{ message_id: id, status }] }) })).status,
    setVendorPrice: (p) => { mock.unitCost = p; },
    close: async () => { setSmsGateway(null); await mock.close(); srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
  };
});

/** A scripted in-process transport for behaviours the HTTP mock cannot express. */
function scripted(script: (m: SmsSubmit, n: number) => Promise<{ messageId: string; status: "queued" }>): SmsTransport & { calls: number } {
  const t = { name: "scripted", calls: 0, submit: async (m: SmsSubmit) => { t.calls++; return script(m, t.calls); } };
  return t;
}

describe("SMS provider internals (S-63)", () => {
  beforeEach(() => { resetDbForTests(); migrate(); setProviderLogger(() => undefined); });
  afterEach(() => { setProviderLogger(null); setSmsGateway(null); resetDbForTests(); });

  it("@E2E-78 template registry: slots, specificity, render round trip, DLT status", () => {
    const reg = new SmsTemplateRegistry(defaultCivicTemplates("PPULSE"));
    const m = reg.match("People Pulse code: 123456. Valid for 5 minutes. Do not share it.");
    expect(m?.template.id).toBe("otp");
    expect(m?.variables).toEqual({ code: "123456" });
    expect(reg.match("People Pulse code: 123456789012. Valid for 5 minutes. Do not share it.")).toBeNull(); // slot longer than allowed
    expect(reg.match("People Pulse: your issue reference is ISS-1. We never ask for OTP or bank details.")?.template.id).toBe("issue_reference");
    expect(reg.render("issue_reference", { ref: "ISS-1" })).toContain("ISS-1");
    // every message the civic code sends today matches a template
    const sample = [
      "People Pulse: sign-in for a person linked to your number was locked from one device after repeated wrong PINs. It unlocks automatically in 30 minutes. You can reset the PIN with a code sent to this number.",
      "People Pulse: another adult was added to your number. If this was not you, reply STOP or contact the grievance officer.",
      "Notice text line\nsecond line\n\nPeople Pulse activation. Code: ABCD-1234  OTP: 123456\nEnter both in the app and choose your OWN PIN. Never tell the PIN to anyone, including the volunteer. Valid 72 hours (OTP 5 minutes).",
      "తెలుగు నోటీసు\n\nEnglish notice\n\nInvite code: INV-123\nValid 72 hours. [DRAFT NOTICE v1]",
    ];
    for (const s of sample) expect(reg.match(s), s.slice(0, 30)).not.toBeNull();
    expect(reg.unregistered().length).toBe(reg.all().length); // defaults carry no DLT ids on purpose
  });

  it("@E2E-78 segment counting: GSM-7 vs UCS-2", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("తెలుగు")).toBe(1);
    expect(smsSegments("త".repeat(71))).toBe(2);
  });

  it("@E2E-78 status vocabulary maps vendor words to the four states", () => {
    expect(normalizeSmsStatus("DELIVRD")).toBe("delivered");
    expect(normalizeSmsStatus("UNDELIV")).toBe("failed");
    expect(normalizeSmsStatus("accepted")).toBe("queued");
    expect(normalizeSmsStatus("Submitted")).toBe("sent");
    expect(normalizeSmsStatus("weird")).toBeNull();
    expect(normalizeSmsStatus(5)).toBeNull();
  });

  it("@E2E-78 an open circuit stops hammering the vendor and recovers through a half-open probe", async () => {
    let t = 1_000_000;
    let healthy = false;
    const tr = scripted(async (_m, n) => { if (!healthy) throw new ProviderError("down", "http", 503); return { messageId: "ok" + n, status: "queued" as const }; });
    const p = new ManagedSmsProvider(tr, { requireTemplates: false, maxAttempts: 50, now: () => t, backoffBaseMs: 1, backoffCapMs: 1, timeoutMs: 100 });
    for (let i = 0; i < 8; i++) await p.send("+919876500001", "msg " + i);
    expect(tr.calls).toBe(5); // threshold, then the circuit is open and the vendor is not asked
    expect(p.health()).toMatchObject({ breaker: "open", degraded: true });
    t += 31_000; healthy = true;
    await p.runRetries(t + 10_000_000);
    expect(p.health().breaker).toBe("closed");
    expect(p.health().retrying).toBe(0);
  });

  it("@E2E-78 a transport that ignores its timeout is still cut off by the gateway deadline", async () => {
    const tr = scripted(() => new Promise(() => undefined));
    const p = new ManagedSmsProvider(tr, { requireTemplates: false, timeoutMs: 50 });
    const t0 = Date.now();
    const r = await p.submit("+919876500002", "slow");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.state).toBe("retry");
  });

  it("@E2E-78 the ledger keeps no clear phone number and drops the payload once the vendor accepted", async () => {
    const tr = scripted(async () => ({ messageId: "m1", status: "queued" as const }));
    const p = new ManagedSmsProvider(tr, { requireTemplates: false });
    await p.send("+919876500003", "hello 424242");
    const rows = getDb().prepare("SELECT * FROM sms_ledger").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("9876500003");
    expect(JSON.stringify(rows)).not.toContain("424242");
    expect(rows[0].payload_enc).toBeNull();
  });

  it("@E2E-78 purge drops old dead-letter payloads and old rows", async () => {
    const tr = scripted(async () => { throw new ProviderError("bad", "http", 400); });
    let t = 1_000_000;
    const p = new ManagedSmsProvider(tr, { requireTemplates: false, now: () => t });
    await p.send("+919876500004", "dead one");
    expect(p.deadLetters()[0].hasPayload).toBe(true);
    t += 2 * 86_400_000;
    expect(p.purge(t)).toEqual({ payloads: 1, rows: 0 });
    expect(p.deadLetters()[0].hasPayload).toBe(false);
    t += 100 * 86_400_000;
    expect(p.purge(t).rows).toBe(1);
  });

  it("@E2E-78 the receipt endpoint answers 503 without a provider, 401 for bad signatures and 400 for garbage", async () => {
    const mock = await startMockSmsServer();
    const app = express(); app.use("/r", createSmsReceiptRouter());
    const srv = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/r`;
    try {
      const body = JSON.stringify({ receipts: [] });
      expect((await fetch(url, { method: "POST", headers: signedHeaders(RECEIPT_SECRET, body), body })).status).toBe(503);
      setSmsGateway(new HttpSmsProvider({ url: mock.url, secret: mock.secret, receiptSecret: RECEIPT_SECRET }));
      expect((await fetch(url, { method: "POST", headers: signedHeaders("wrong", body), body })).status).toBe(401);
      expect((await fetch(url, { method: "POST", body })).status).toBe(401);
      const old = signedHeaders(RECEIPT_SECRET, body, Date.now() - 3_600_000);
      expect((await fetch(url, { method: "POST", headers: old, body })).status).toBe(401); // stale timestamp (replay window)
      const junk = "not json";
      expect((await fetch(url, { method: "POST", headers: signedHeaders(RECEIPT_SECRET, junk), body: junk })).status).toBe(400);
      expect((await fetch(url, { method: "POST", headers: signedHeaders(RECEIPT_SECRET, body), body })).status).toBe(200);
    } finally { await mock.close(); srv.closeAllConnections?.(); srv.close(); }
  });

  it("@E2E-78 smsDegraded() mirrors the installed provider's health for the UI notice", async () => {
    expect(smsDegraded()).toBe(false);
    const tr = scripted(async () => { throw new ProviderError("down", "http", 503); });
    const p = new ManagedSmsProvider(tr, { requireTemplates: false });
    setSmsGateway(p);
    await p.send("+919876500005", "x");
    expect(smsDegraded()).toBe(true);
  });

  it("@E2E-78 HttpSmsProvider refuses plain http in production and a missing secret", () => {
    const keep = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => new HttpSmsProvider({ url: "http://sms.example.org/x", secret: "s" })).toThrow(/https/);
      expect(() => new HttpSmsProvider({ url: "https://sms.example.org/x", secret: "" })).toThrow(/CIVIC_SMS_SECRET/);
      expect(() => new HttpSmsProvider({ url: "https://sms.example.org/x", secret: "s" })).not.toThrow();
    } finally { process.env.NODE_ENV = keep; }
  });
});
