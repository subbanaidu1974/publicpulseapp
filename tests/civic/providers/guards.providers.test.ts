import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevKeyProvider, getDb, getKeys, migrate, resetDbForTests, setKeyProvider, setSmsProvider } from "../../../server/civic/core";
import { setAttestationVerifier } from "../../../server/civic/identity/network";
import { getNumberIntelligence, isDevNumberIntelligence, setNumberIntelligence } from "../../../server/civic/identity/service";
import { assertProductionSafe, productionProblems } from "../../../server/civic/guards";
import { createCivicRouter } from "../../../server/civic/index";
import { installProvidersFromEnv, keysReady, markKeysWarmForTests, requireKeysReady, resetProviderStateForTests, startKeyWarmup } from "../../../server/civic/providers/install";
import { isKeyProviderV2 } from "../../../server/civic/providers/keys";
import { startMockKmsServer, type MockKmsServer } from "../../../server/civic/providers/mock/kmsServer";
import { startMockSmsServer, type MockSmsServer } from "../../../server/civic/providers/mock/smsServer";
import { HttpSmsProvider, SmsTemplateRegistry, defaultCivicTemplates, getSmsGateway, setSmsGateway } from "../../../server/civic/providers/sms";
import { setProviderLogger, signedHeaders } from "../../../server/civic/providers/util";

const ENV = ["NODE_ENV", "CIVIC_ENV", "CIVIC_SWEEP", "CIVIC_JOBS", "CIVIC_ALLOW_DEMO", "CIVIC_GENERATED_DIR", "CIVIC_DEV_MASTER_KEY", "CIVIC_ANCHOR_URL", "CIVIC_ANCHOR_SECRET", "CIVIC_ALLOW_NO_ATTESTATION",
  "CIVIC_KMS_URL", "CIVIC_KMS_SECRET", "CIVIC_KMS_KEK_ID", "CIVIC_SMS_URL", "CIVIC_SMS_SECRET", "CIVIC_SMS_RECEIPT_SECRET", "CIVIC_SMS_RECEIPT_URL", "CIVIC_SMS_TEMPLATES_FILE", "CIVIC_NUMINTEL_URL", "CIVIC_NUMINTEL_SECRET"];
const saved: Record<string, string | undefined> = {};
let gen: string;

/** Everything production needs through ADAPTER objects, so each test removes exactly one thing. */
function productionReady() {
  process.env.NODE_ENV = "production"; process.env.CIVIC_SWEEP = "0"; process.env.CIVIC_JOBS = "0";
  const real = new DevKeyProvider("test-master");
  setKeyProvider({ hmac: (p, v) => real.hmac(p, v), encrypt: (p, v) => real.encrypt(p, v), decrypt: (p, v) => real.decrypt(p, v) });
  setSmsProvider({ send: async () => undefined });
  setNumberIntelligence({ lookup: async () => ({ recently_reissued: false, voip: false }) });
  setAttestationVerifier({ verify: async () => ({ verified: false }) });
  process.env.CIVIC_GENERATED_DIR = gen;
  fs.writeFileSync(path.join(gen, "census.json"), JSON.stringify({ provenance: "Census of India 2011" }));
  fs.writeFileSync(path.join(gen, "elections.json"), JSON.stringify({ provenance: "TCPD" }));
}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; }
  for (const k of ENV.filter((k) => k !== "NODE_ENV")) delete process.env[k];
  resetDbForTests(); migrate(); resetProviderStateForTests(); setProviderLogger(() => undefined);
  gen = fs.mkdtempSync(path.join(os.tmpdir(), "civic-gen-"));
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setNumberIntelligence(null); setAttestationVerifier(null); setSmsGateway(null); resetProviderStateForTests(); setProviderLogger(null); resetDbForTests(); vi.restoreAllMocks();
});

describe("production guards for providers (S-62/63/64)", () => {
  it("@E2E-79 the fully adapter-configured production passes (control for the refusals below)", () => {
    productionReady();
    expect(productionProblems()).toEqual([]);
    expect(() => createCivicRouter()).not.toThrow();
  });

  it("@E2E-79 refuses the dev attestation verifier unless CIVIC_ALLOW_NO_ATTESTATION=1 accepts that risk", () => {
    productionReady(); setAttestationVerifier(null);
    expect(() => assertProductionSafe()).toThrow(/dev attestation verifier/);
    process.env.CIVIC_ALLOW_NO_ATTESTATION = "1";
    expect(() => assertProductionSafe()).not.toThrow();
  });

  it("@E2E-79 refuses a missing CIVIC_ANCHOR_SECRET when an HTTP witness is configured (unsigned anchors)", () => {
    productionReady(); process.env.CIVIC_ANCHOR_URL = "https://witness.example.org/anchor";
    expect(() => assertProductionSafe()).toThrow(/CIVIC_ANCHOR_SECRET/);
    process.env.CIVIC_ANCHOR_SECRET = "s3cret";
    expect(() => assertProductionSafe()).not.toThrow();
  });

  it("@E2E-79 refuses the dev key provider and the dev master key, and names CIVIC_KMS_URL as the remedy", () => {
    productionReady(); setKeyProvider(null); process.env.CIVIC_DEV_MASTER_KEY = "m";
    expect(() => assertProductionSafe()).toThrow(/CIVIC_KMS_URL/);
    expect(() => createCivicRouter()).toThrow(/dev key provider/);
  });

  it("@E2E-79 a half-configured KMS is refused: missing secret, missing KEK id, or plain http", () => {
    productionReady(); process.env.CIVIC_KMS_URL = "http://kms.example.org";
    const p = productionProblems().join("|");
    expect(p).toMatch(/CIVIC_KMS_SECRET/); expect(p).toMatch(/CIVIC_KMS_KEK_ID/); expect(p).toMatch(/CIVIC_KMS_URL must be https/);
    process.env.CIVIC_KMS_URL = "https://kms.example.org"; process.env.CIVIC_KMS_SECRET = "s"; process.env.CIVIC_KMS_KEK_ID = "k";
    expect(productionProblems()).toEqual([]);
  });

  it("@E2E-78 refuses the dev SMS provider, and a half-configured SMS vendor (secrets, receipts secret, https)", () => {
    productionReady(); setSmsProvider(null);
    expect(() => assertProductionSafe()).toThrow(/CIVIC_SMS_URL/);
    setSmsProvider({ send: async () => undefined });
    process.env.CIVIC_SMS_URL = "http://sms.example.org";
    const p = productionProblems().join("|");
    expect(p).toMatch(/CIVIC_SMS_SECRET/); expect(p).toMatch(/CIVIC_SMS_RECEIPT_SECRET/); expect(p).toMatch(/CIVIC_SMS_URL must be https/);
  });

  it("@E2E-78 refuses a managed SMS provider whose templates have no DLT template id (they would all be refused at send time)", async () => {
    const mock = await startMockSmsServer();
    const p = new HttpSmsProvider({ url: mock.url, secret: mock.secret, requireTemplates: true });
    const full = new SmsTemplateRegistry(defaultCivicTemplates("PPULSE").map((t) => ({ ...t, dltTemplateId: "1107" + t.id })));
    const q = new HttpSmsProvider({ url: mock.url, secret: mock.secret, registry: full });
    productionReady();
    try {
      setSmsProvider(p); setSmsGateway(p);
      expect(productionProblems().join("|")).toMatch(/templates without a DLT template id.*otp/);
      setSmsProvider(q); setSmsGateway(q);
      expect(productionProblems()).toEqual([]);
    } finally { await mock.close(); }
  });

  it("@E2E-77 refuses number-intelligence dev fixtures and a half-configured vendor", () => {
    productionReady(); setNumberIntelligence(null);
    expect(() => assertProductionSafe()).toThrow(/number-intelligence/);
    setNumberIntelligence({ lookup: async () => ({ recently_reissued: false, voip: false }) });
    process.env.CIVIC_NUMINTEL_URL = "http://intel.example.org";
    const p = productionProblems().join("|");
    expect(p).toMatch(/CIVIC_NUMINTEL_SECRET/); expect(p).toMatch(/CIVIC_NUMINTEL_URL must be https/);
  });
});

describe("provider installation from the environment (S-62/63/64)", () => {
  let kms: MockKmsServer, sms: MockSmsServer;
  beforeEach(async () => { kms = await startMockKmsServer(); sms = await startMockSmsServer(); });
  afterEach(async () => { await kms.close(); await sms.close(); });

  it("@E2E-79 CIVIC_KMS_URL installs the remote KMS provider; the civic router answers 503 keys_warming until keys are unwrapped, then serves", async () => {
    process.env.CIVIC_KMS_URL = kms.url; process.env.CIVIC_KMS_SECRET = kms.secret; process.env.CIVIC_KMS_KEK_ID = "kek-main";
    expect(installProvidersFromEnv()).toMatchObject({ keys: true });
    expect(isKeyProviderV2(getKeys())).toBe(true);
    expect(keysReady()).toBe(false);
    // the router gate, unit-level
    const res = { code: 0, body: null as unknown, status(c: number) { this.code = c; return this; }, set() { return this; }, json(b: unknown) { this.body = b; return this; } };
    const next = vi.fn();
    requireKeysReady({} as never, res as never, next);
    expect(res.code).toBe(503); expect(res.body).toMatchObject({ error: "keys_warming" }); expect(next).not.toHaveBeenCalled();
    expect(() => getKeys().hmac("phone", "x")).toThrow(); // fail closed while cold
    await startKeyWarmup();
    expect(keysReady()).toBe(true);
    requireKeysReady({} as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getKeys().hmac("phone", "x")).toMatch(/^[0-9a-f]{64}$/);
    (getKeys() as unknown as { destroy(): void }).destroy();
  });

  it("@E2E-79 a warm-up that fails keeps the router closed", async () => {
    process.env.CIVIC_KMS_URL = kms.url; process.env.CIVIC_KMS_SECRET = kms.secret; process.env.CIVIC_KMS_KEK_ID = "kek-main";
    installProvidersFromEnv();
    kms.mode = "error500";
    await startKeyWarmup();
    expect(keysReady()).toBe(false);
    kms.mode = "ok";
    await startKeyWarmup();
    expect(keysReady()).toBe(true);
    (getKeys() as unknown as { destroy(): void }).destroy();
  });

  it("@E2E-79 CIVIC_KMS_URL without a KEK id fails at startup; an already-installed adapter is never replaced", () => {
    process.env.CIVIC_KMS_URL = kms.url;
    expect(() => installProvidersFromEnv()).toThrow(/CIVIC_KMS_KEK_ID/);
    process.env.CIVIC_KMS_KEK_ID = "k"; process.env.CIVIC_KMS_SECRET = kms.secret;
    const mine = new DevKeyProvider("x"); const own = { hmac: mine.hmac.bind(mine), encrypt: mine.encrypt.bind(mine), decrypt: mine.decrypt.bind(mine) };
    setKeyProvider(own);
    expect(installProvidersFromEnv().keys).toBe(false);
    expect(getKeys()).toBe(own);
  });

  it("@E2E-78 CIVIC_SMS_URL installs the HTTP SMS provider and the receipts endpoint is served by the civic router", async () => {
    process.env.CIVIC_SMS_URL = sms.url; process.env.CIVIC_SMS_SECRET = sms.secret; process.env.CIVIC_SMS_RECEIPT_SECRET = "rcpt";
    const app = express(); app.use("/api/v1/civic", createCivicRouter());
    const srv = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1/civic`;
    try {
      expect(getSmsGateway()).not.toBeNull();
      const gw = getSmsGateway()!;
      const r = await gw.submit("+919876500077", "People Pulse code: 123456. Valid for 5 minutes. Do not share it.");
      expect(r.messageId).toBeTruthy();
      const body = JSON.stringify({ receipts: [{ message_id: r.messageId, status: "delivered" }] });
      const res = await fetch(base + "/channels/sms-receipt", { method: "POST", headers: signedHeaders("rcpt", body), body });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ applied: 1 });
      expect(gw.status(r.idempotencyKey)!.state).toBe("delivered");
      const bad = await fetch(base + "/channels/sms-receipt", { method: "POST", headers: signedHeaders("nope", body), body });
      expect(bad.status).toBe(401);
      expect((getDb().prepare("SELECT COUNT(*) c FROM sms_ledger").get() as { c: number }).c).toBe(1);
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });

  it("@E2E-77 CIVIC_NUMINTEL_URL installs the HTTP number-intelligence adapter in place of the dev fixtures", () => {
    process.env.CIVIC_NUMINTEL_URL = "http://127.0.0.1:1/x"; process.env.CIVIC_NUMINTEL_SECRET = "s";
    expect(isDevNumberIntelligence()).toBe(true);
    expect(installProvidersFromEnv().numberIntel).toBe(true);
    expect(isDevNumberIntelligence()).toBe(false);
    expect((getNumberIntelligence() as { contract?: number }).contract).toBe(2);
    markKeysWarmForTests();
  });
});
