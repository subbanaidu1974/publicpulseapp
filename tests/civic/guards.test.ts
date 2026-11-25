import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevKeyProvider, getDb, migrate, resetDbForTests, setKeyProvider, setSmsProvider, getStore } from "../../server/civic/core";
import { ensureGeo } from "../../server/civic/geo/service";
import { setNumberIntelligence } from "../../server/civic/identity/service";
import { setAttestationVerifier } from "../../server/civic/identity/network";
import { assertProductionSafe, isLocalHost } from "../../server/civic/guards";
import { setMailProvider } from "../../server/civic/providers/mail";
import { GenericHttpMailProvider } from "../../server/civic/providers/mailgeneric";
import { createCivicRouter } from "../../server/civic/index";

const KEYS = ["NODE_ENV", "CIVIC_ENV", "CIVIC_DEMO_PERSONAS", "CIVIC_EXPOSE_DEV_OTP", "CIVIC_EXPOSE_DEV_MAIL", "CIVIC_ALLOW_DEMO", "CIVIC_GENERATED_DIR", "CIVIC_DEV_MASTER_KEY", "CIVIC_SWEEP", "CIVIC_JOBS"];
const saved: Record<string, string | undefined> = {};
let gen: string;

/** Everything production needs, so each test removes exactly one thing. */
function productionReady() {
  process.env.NODE_ENV = "production";
  process.env.CIVIC_SWEEP = "0"; process.env.CIVIC_JOBS = "0";
  const real = new DevKeyProvider("test-master");
  setKeyProvider({ hmac: (p, v) => real.hmac(p, v), encrypt: (p, v) => real.encrypt(p, v), decrypt: (p, v) => real.decrypt(p, v) });
  setSmsProvider({ send: async () => undefined });
  setMailProvider({ name: "test", send: async () => undefined });
  setNumberIntelligence({ lookup: async () => ({ recently_reissued: false, voip: false }) });
  setAttestationVerifier({ verify: async () => ({ verified: false }) }); // a real verifier is installed (S-62/63/64 guard)
  process.env.CIVIC_GENERATED_DIR = gen;
  fs.writeFileSync(path.join(gen, "census.json"), JSON.stringify({ provenance: "Census of India 2011" }));
  fs.writeFileSync(path.join(gen, "elections.json"), JSON.stringify({ provenance: "TCPD" }));
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  resetDbForTests(); migrate();
  gen = fs.mkdtempSync(path.join(os.tmpdir(), "civic-gen-"));
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setMailProvider(null); setNumberIntelligence(null); setAttestationVerifier(null); resetDbForTests(); vi.restoreAllMocks();
});

describe("production startup guards (S-55)", () => {
  it("@E2E-70 a fully configured production passes", () => {
    productionReady();
    expect(() => assertProductionSafe()).not.toThrow();
    expect(() => createCivicRouter()).not.toThrow();
  });

  it("@E2E-70 refuses the dev key provider (including CIVIC_DEV_MASTER_KEY as the only key source)", () => {
    productionReady(); setKeyProvider(null);
    expect(() => assertProductionSafe()).toThrow(/dev key provider/);
    process.env.CIVIC_DEV_MASTER_KEY = "some-master";
    expect(() => createCivicRouter()).toThrow(/dev key provider/);
  });

  it("@E2E-70 refuses the dev SMS provider", () => {
    productionReady(); setSmsProvider(null);
    expect(() => assertProductionSafe()).toThrow(/dev SMS provider/);
  });

  it("refuses the dev mail provider and CIVIC_EXPOSE_DEV_MAIL=1", () => {
    productionReady(); setMailProvider(null);
    expect(() => assertProductionSafe()).toThrow(/dev mail provider/);
    productionReady(); process.env.CIVIC_EXPOSE_DEV_MAIL = "1";
    expect(() => assertProductionSafe()).toThrow(/CIVIC_EXPOSE_DEV_MAIL/);
  });

  it("boots with the generic HTTP mail adapter on a secure URL and still refuses the dev mailer", () => {
    productionReady();
    process.env.CIVIC_MAIL_URL = "https://mail.example.test/send"; process.env.CIVIC_MAIL_AUTH_VALUE = "k";
    setMailProvider(new GenericHttpMailProvider({ url: process.env.CIVIC_MAIL_URL, authValue: "k" }));
    try {
      expect(() => assertProductionSafe()).not.toThrow();
      setMailProvider(null);
      expect(() => assertProductionSafe()).toThrow(/dev mail provider.*CIVIC_MAIL_URL/);
    } finally { delete process.env.CIVIC_MAIL_URL; delete process.env.CIVIC_MAIL_AUTH_VALUE; }
  });

  it("@E2E-70 refuses CIVIC_EXPOSE_DEV_OTP=1", () => {
    productionReady(); process.env.CIVIC_EXPOSE_DEV_OTP = "1";
    expect(() => assertProductionSafe()).toThrow(/CIVIC_EXPOSE_DEV_OTP/);
  });

  it("@E2E-70 refuses number-intelligence dev fixtures", () => {
    productionReady(); setNumberIntelligence(null);
    expect(() => assertProductionSafe()).toThrow(/number-intelligence/);
  });

  it("@E2E-70 refuses demo census/elections provenance unless CIVIC_ALLOW_DEMO=1", () => {
    productionReady();
    fs.writeFileSync(path.join(gen, "census.json"), JSON.stringify({ schema: 1, provenance: "demo" }));
    expect(() => assertProductionSafe()).toThrow(/demo data provenance.*census\.json/);
    fs.writeFileSync(path.join(gen, "elections.json"), JSON.stringify({ provenance: "DEMO" }));
    expect(() => assertProductionSafe()).toThrow(/elections\.json/);
    process.env.CIVIC_ALLOW_DEMO = "1";
    expect(() => assertProductionSafe()).not.toThrow();
  });

  it("@E2E-70 CIVIC_ENV=production is treated like NODE_ENV=production", () => {
    productionReady(); process.env.NODE_ENV = "test"; process.env.CIVIC_ENV = "production";
    setSmsProvider(null);
    expect(() => assertProductionSafe()).toThrow(/dev SMS provider/);
  });

  it("@E2E-70 ensureGeo does not seed DEMO geography in production", () => {
    productionReady();
    ensureGeo();
    expect((getStore("issues").prepare("SELECT COUNT(*) c FROM admin_unit").get() as { c: number }).c).toBe(0);
    process.env.NODE_ENV = "test";
    ensureGeo();
    expect((getStore("issues").prepare("SELECT COUNT(*) c FROM admin_unit").get() as { c: number }).c).toBeGreaterThan(0);
  });

  it("@E2E-70 unset NODE_ENV is non-production but warns loudly; dev OTP needs a localhost host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const v = process.env.VITEST; delete process.env.NODE_ENV; delete process.env.CIVIC_ENV; delete process.env.VITEST;
    try { expect(() => assertProductionSafe()).not.toThrow(); } finally { process.env.VITEST = v; }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NODE_ENV is not set/));
    expect(isLocalHost({ hostname: "localhost" })).toBe(true);
    expect(isLocalHost({ hostname: "127.0.0.1" })).toBe(true);
    expect(isLocalHost({ hostname: "api.example.org" })).toBe(false);
  });
});
