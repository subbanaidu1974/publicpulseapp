import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKeys, isDevKeyProvider, migrate, resetDbForTests, setKeyProvider } from "../../../server/civic/core";
import { productionProblems } from "../../../server/civic/guards";
import { isDevNumberIntelligence, setNumberIntelligence, getNumberIntelligence } from "../../../server/civic/identity/service";
import { installProvidersFromEnv, markKeysWarmForTests, resetProviderStateForTests, startKeyWarmup } from "../../../server/civic/providers/install";
import { startAwsKmsSim, type AwsKmsSim } from "../../../server/civic/providers/mock/awsKmsServer";
import { startVendorIntelSim, VENDOR_SIM_MAPPING, type VendorIntelSim } from "../../../server/civic/providers/mock/vendorIntelServer";
import { setProviderLogger } from "../../../server/civic/providers/util";

const KEYS = ["NODE_ENV", "CIVIC_AWS_KMS_KEY_ID", "CIVIC_AWS_KMS_REGION", "CIVIC_AWS_KMS_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CIVIC_KMS_URL", "CIVIC_NUMINTEL_URL", "CIVIC_NUMINTEL_SECRET", "CIVIC_NUMINTEL_API_KEY"];
const saved: Record<string, string | undefined> = {};

describe("vendor adapter registration and production guards (S-62, S-64)", () => {
  let kms: AwsKmsSim; let intel: VendorIntelSim;
  beforeEach(async () => {
    resetDbForTests(); migrate(); setProviderLogger(() => undefined);
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    kms = await startAwsKmsSim(); intel = await startVendorIntelSim();
  });
  afterEach(async () => {
    await kms.close(); await intel.close();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    setKeyProvider(null); setNumberIntelligence(null); resetProviderStateForTests(); setProviderLogger(null); resetDbForTests();
  });

  it("@E2E-79 CIVIC_AWS_KMS_KEY_ID installs the AWS provider, warm-up unwraps through the simulator, and the dev stand-in is gone", async () => {
    expect(isDevKeyProvider()).toBe(true);
    const env = { CIVIC_AWS_KMS_KEY_ID: "alias/civic", CIVIC_AWS_KMS_REGION: kms.region, CIVIC_AWS_KMS_ENDPOINT: kms.url, AWS_ACCESS_KEY_ID: kms.accessKeyId, AWS_SECRET_ACCESS_KEY: kms.secretAccessKey } as NodeJS.ProcessEnv;
    expect(installProvidersFromEnv(env).keys).toBe(true);
    expect(isDevKeyProvider()).toBe(false);
    await startKeyWarmup();
    expect(kms.calls.Encrypt).toBeGreaterThan(0);
    expect(getKeys().hmac("phone", "+919876500000")).toMatch(/^[0-9a-f]{64}$/);
    markKeysWarmForTests();
  });

  it("@E2E-79 production guard: AWS config problems are reported, and a complete config is accepted", () => {
    process.env.NODE_ENV = "production";
    process.env.CIVIC_AWS_KMS_KEY_ID = "alias/civic";
    const p = productionProblems().join("\n");
    expect(p).toContain("CIVIC_AWS_KMS_REGION is missing");
    expect(p).toContain("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are missing");
    process.env.CIVIC_KMS_URL = "https://kms.example.org"; process.env.CIVIC_AWS_KMS_ENDPOINT = "http://insecure";
    const q = productionProblems().join("\n");
    expect(q).toContain("pick one KMS");
    expect(q).toContain("CIVIC_AWS_KMS_ENDPOINT must be https");
  });

  it("@E2E-77 CIVIC_NUMINTEL_API_KEY installs the generic adapter with a mapping file; production accepts an API key instead of a secret", async () => {
    expect(isDevNumberIntelligence()).toBe(true);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "intel-map-")), "map.json");
    fs.writeFileSync(f, JSON.stringify(VENDOR_SIM_MAPPING));
    intel.answers.set("+919876540555", { type: "VOIP", circle: "AP", ported: false, recycled: false, days: 900, confidence: 0.9 });
    const env = { CIVIC_NUMINTEL_URL: intel.url, CIVIC_NUMINTEL_API_KEY: intel.apiKey, CIVIC_NUMINTEL_MAPPING_FILE: f } as NodeJS.ProcessEnv;
    expect(installProvidersFromEnv(env).numberIntel).toBe(true);
    expect(isDevNumberIntelligence()).toBe(false);
    expect(await getNumberIntelligence().lookup("+919876540555")).toMatchObject({ voip: true });
    process.env.NODE_ENV = "production"; process.env.CIVIC_NUMINTEL_URL = "https://intel.example.org"; process.env.CIVIC_NUMINTEL_API_KEY = "k";
    expect(productionProblems().join("\n")).not.toContain("CIVIC_NUMINTEL_SECRET is missing");
    delete process.env.CIVIC_NUMINTEL_API_KEY;
    expect(productionProblems().join("\n")).toContain("CIVIC_NUMINTEL_SECRET is missing");
  });
});
