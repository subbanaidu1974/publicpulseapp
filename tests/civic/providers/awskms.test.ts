import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../../../server/civic/core";
import { AwsKmsKeyProvider, signV4 } from "../../../server/civic/providers/awskms";
import { KNOWN_PURPOSES, MemoryKeyRegistry, SqlKeyRegistry, type KeyRegistry } from "../../../server/civic/providers/keys";
import { startAwsKmsSim, type AwsKmsSim } from "../../../server/civic/providers/mock/awsKmsServer";
import { ProviderError, setProviderLogger } from "../../../server/civic/providers/util";
import { runKeyProviderContract, type KeyHarness } from "./contract/keys.contract";

const creds = (s: AwsKmsSim) => ({ accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey });

/** Certifies AwsKmsKeyProvider against the local AWS KMS simulator (NOT real AWS). */
function harnessFor(makeRegistry: () => KeyRegistry) {
  return async (o: { cacheTtlMs: number }): Promise<KeyHarness> => {
    const sim = await startAwsKmsSim();
    const registry = makeRegistry();
    let t = Date.now();
    const build = () => new AwsKmsKeyProvider({ region: sim.region, endpoint: sim.url, credentials: creds(sim), kekId: "alias/civic-kek", registry, cacheTtlMs: o.cacheTtlMs, now: () => t, timeoutMs: 500 });
    const live: AwsKmsKeyProvider[] = [];
    const first = build(); live.push(first);
    return {
      provider: first,
      restart: () => { const p = build(); live.push(p); return p; },
      breakKms: (on) => { sim.mode = on ? "error500" : "ok"; },
      advance: (ms) => { t += ms; },
      keyMaterialSeen: () => sim.bodies.map((b) => { try { return (JSON.parse(b) as { Plaintext?: string }).Plaintext; } catch { return undefined; } }).filter((x): x is string => !!x),
      close: async () => { for (const p of live) p.destroy(); await sim.close(); },
    };
  };
}
runKeyProviderContract("AwsKmsKeyProvider + AWS KMS simulator (memory registry)", harnessFor(() => new MemoryKeyRegistry()));
runKeyProviderContract("AwsKmsKeyProvider + AWS KMS simulator (SQL registry)", harnessFor(() => new SqlKeyRegistry()));

describe("AWS KMS adapter internals (S-64)", () => {
  let sim: AwsKmsSim;
  beforeEach(async () => { resetDbForTests(); migrate(); sim = await startAwsKmsSim(); setProviderLogger(() => undefined); });
  afterEach(async () => { await sim.close(); setProviderLogger(null); resetDbForTests(); });
  const mk = (extra: Partial<ConstructorParameters<typeof AwsKmsKeyProvider>[0]> = {}) =>
    new AwsKmsKeyProvider({ region: sim.region, endpoint: sim.url, credentials: creds(sim), kekId: "alias/civic-kek", registry: new MemoryKeyRegistry(), timeoutMs: 300, ...extra });
  const signed = (body: string, target: string) => signV4({ method: "POST", url: new URL(sim.url), body, region: sim.region, service: "kms", creds: creds(sim), now: new Date(), headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "TrentService." + target } });

  it("@E2E-79 requests carry a valid SigV4 signature and the KMS target headers; warm uses Encrypt once per purpose", async () => {
    const p = mk(); await p.warm();
    expect(sim.badSignatures).toBe(0);
    expect(sim.calls.Encrypt).toBe(KNOWN_PURPOSES.length);
    expect(sim.lastHeaders["x-amz-target"]).toBe("TrentService.Encrypt");
    expect(sim.lastHeaders["content-type"]).toBe("application/x-amz-json-1.1");
    expect(String(sim.lastHeaders.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA.*\/\d{8}\/ap-south-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
    for (let i = 0; i < 100; i++) p.hmac("phone", "x" + i);
    expect(sim.calls.Decrypt).toBe(0);
    const q = mk({ registry: (p as unknown as { registry: KeyRegistry }).registry }); await q.warm();
    expect(sim.calls.Decrypt).toBe(KNOWN_PURPOSES.length);
    p.destroy(); q.destroy();
  });

  it("@E2E-79 wrong secret key, wrong region and a tampered body are rejected by signature verification", async () => {
    await expect(mk({ credentials: { accessKeyId: sim.accessKeyId, secretAccessKey: "wrong" } }).warm()).rejects.toMatchObject({ kind: "http", status: 400 });
    await expect(mk({ region: "us-east-1" }).warm()).rejects.toBeInstanceOf(ProviderError);
    expect(sim.badSignatures).toBe(2);
    const r = await fetch(sim.url, { method: "POST", headers: signed("{}", "Encrypt"), body: '{"tampered":1}' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { __type: string }).__type).toBe("InvalidSignatureException");
  });

  it("@E2E-79 SigV4 is deterministic for a fixed time and the session token is signed", () => {
    const base = { method: "POST", url: new URL("https://kms.ap-south-1.amazonaws.com"), body: "{}", region: "ap-south-1", service: "kms", now: new Date("2026-01-02T03:04:05.000Z"), headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "TrentService.Decrypt" } };
    const a = signV4({ ...base, creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
    expect(a["x-amz-date"]).toBe("20260102T030405Z");
    expect(signV4({ ...base, creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } }).authorization).toBe(a.authorization);
    const t = signV4({ ...base, creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "TOKEN" } });
    expect(t.authorization).toContain("x-amz-security-token");
    expect(t.authorization).not.toBe(a.authorization);
  });

  it("@E2E-79 ThrottlingException is retryable (429) and trips the breaker; AccessDenied is permanent and does not", async () => {
    const p = mk();
    sim.mode = "throttle";
    const e = await p.warm().catch((x: unknown) => x as ProviderError);
    expect(e).toMatchObject({ kind: "http", status: 429, retryable: true });
    for (let i = 0; i < 3; i++) await p.warm().catch(() => undefined);
    expect(p.health().breaker).toBe("open");
    const q = mk(); sim.mode = "accessDenied";
    const d = await q.warm().catch((x: unknown) => x as ProviderError);
    expect(d).toMatchObject({ kind: "http", status: 400, retryable: false });
    expect((d as ProviderError).message).toContain("AccessDeniedException");
    for (let i = 0; i < 5; i++) await q.warm().catch(() => undefined);
    expect(q.health().breaker).toBe("closed");
  });

  it("@E2E-79 a disabled KEK fails closed; a wrapped key replayed under another encryption context fails to decrypt", async () => {
    sim.disabled.add("alias/civic-kek");
    await expect(mk().warm()).rejects.toThrow(/DisabledException/);
    sim.disabled.clear();
    const p = mk(); await p.warm();
    const rec = (p as unknown as { registry: KeyRegistry }).registry.list()[0];
    const body = JSON.stringify({ CiphertextBlob: rec.wrapped, EncryptionContext: { aad: "civic-key:other:1" } });
    const r = await fetch(sim.url, { method: "POST", headers: signed(body, "Decrypt"), body });
    expect(((await r.json()) as { __type: string }).__type).toBe("InvalidCiphertextException");
    p.destroy();
  });

  it("@E2E-79 generateDataKey returns a 32-byte clear key and a wrapped copy that Decrypt reopens", async () => {
    const p = mk();
    const g = await p.aws.generateDataKey("alias/civic-kek", "civic-key:phone:1");
    expect(g.plaintext).toHaveLength(32);
    expect((await p.aws.unwrap(g.wrapped, "civic-key:phone:1")).equals(g.plaintext)).toBe(true);
    await expect(p.aws.unwrap(g.wrapped, "civic-key:phone:2")).rejects.toBeInstanceOf(ProviderError);
  });

  it("@E2E-79 refuses plain http endpoints in production and missing credentials", () => {
    const keep = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => mk({ endpoint: "http://kms.example.org" })).toThrow(/https/);
    } finally { process.env.NODE_ENV = keep; }
    expect(() => mk({ credentials: { accessKeyId: "", secretAccessKey: "" } })).toThrow(/credentials/);
  });

  it("@E2E-79 logs never contain credentials", async () => {
    const logs: string[] = []; setProviderLogger((l) => logs.push(l));
    sim.mode = "throttle"; await mk().warm().catch(() => undefined);
    sim.mode = "ok"; const p = mk(); await p.warm(); p.destroy();
    const all = logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(sim.secretAccessKey);
    expect(all).not.toContain(sim.accessKeyId);
  });
});
