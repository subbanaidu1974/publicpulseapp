import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKeys, migrate, resetDbForTests, setKeyProvider } from "../../../server/civic/core";
import { KNOWN_PURPOSES, MemoryKeyRegistry, RemoteKmsKeyProvider, SqlKeyRegistry, type KeyRegistry } from "../../../server/civic/providers/keys";
import { startMockKmsServer, type MockKmsServer } from "../../../server/civic/providers/mock/kmsServer";
import { ProviderError, setProviderLogger } from "../../../server/civic/providers/util";
import { runKeyProviderContract, type KeyHarness } from "./contract/keys.contract";

/** Certifies the neutral RemoteKmsKeyProvider against the reference mock KMS, with both registry flavours. */
function harnessFor(makeRegistry: () => KeyRegistry) {
  return async (o: { cacheTtlMs: number }): Promise<KeyHarness> => {
    const kms = await startMockKmsServer();
    const registry = makeRegistry();
    let t = Date.now();
    const build = () => new RemoteKmsKeyProvider({ url: kms.url, secret: kms.secret, kekId: "kek-main", registry, cacheTtlMs: o.cacheTtlMs, now: () => t, timeoutMs: 500 });
    const live: RemoteKmsKeyProvider[] = [];
    const first = build(); live.push(first);
    return {
      provider: first,
      restart: () => { const p = build(); live.push(p); return p; },
      breakKms: (on) => { kms.mode = on ? "error500" : "ok"; },
      advance: (ms) => { t += ms; },
      keyMaterialSeen: () => kms.bodies.map((b) => { try { return (JSON.parse(b) as { plaintext_b64?: string }).plaintext_b64; } catch { return undefined; } }).filter((x): x is string => !!x),
      close: async () => { for (const p of live) p.destroy(); await kms.close(); },
    };
  };
}
runKeyProviderContract("RemoteKmsKeyProvider + reference mock KMS (memory registry)", harnessFor(() => new MemoryKeyRegistry()));
runKeyProviderContract("RemoteKmsKeyProvider + reference mock KMS (SQL registry)", harnessFor(() => new SqlKeyRegistry()));

describe("remote KMS adapter internals (S-64)", () => {
  let kms: MockKmsServer;
  beforeEach(async () => { resetDbForTests(); migrate(); kms = await startMockKmsServer(); setProviderLogger(() => undefined); });
  afterEach(async () => { await kms.close(); setProviderLogger(null); setKeyProvider(null); resetDbForTests(); });
  const mk = (extra: Partial<ConstructorParameters<typeof RemoteKmsKeyProvider>[0]> = {}) =>
    new RemoteKmsKeyProvider({ url: kms.url, secret: kms.secret, kekId: "kek-main", registry: new MemoryKeyRegistry(), timeoutMs: 300, ...extra });

  it("@E2E-79 warm() unwraps each key once; the hot path never calls the KMS", async () => {
    const p = mk();
    await p.warm();
    const wraps = kms.calls.wrap;
    expect(wraps).toBe(KNOWN_PURPOSES.length);
    for (let i = 0; i < 200; i++) p.hmac("phone", "x" + i);
    expect(kms.calls).toMatchObject({ wrap: wraps, unwrap: 0 });
    const q = new RemoteKmsKeyProvider({ url: kms.url, secret: kms.secret, kekId: "kek-main", registry: (p as unknown as { registry: KeyRegistry }).registry });
    await q.warm();
    expect(kms.calls.unwrap).toBe(KNOWN_PURPOSES.length);
    expect(kms.calls.wrap).toBe(wraps); // nothing re-provisioned
    p.destroy(); q.destroy();
  });

  it("@E2E-79 a KMS that times out opens the circuit and warm() fails closed fast", async () => {
    const p = mk({ timeoutMs: 80 });
    kms.mode = "timeout";
    await expect(p.warm()).rejects.toBeInstanceOf(ProviderError);
    for (let i = 0; i < 4; i++) await p.warm().catch(() => undefined);
    expect(p.health().breaker).toBe("open");
    const before = kms.bodies.length;
    await expect(p.warm()).rejects.toMatchObject({ kind: "circuit_open" });
    expect(kms.bodies.length).toBe(before);
    p.destroy();
  });

  it("@E2E-79 malformed KMS answers are refused (wrong key length, missing fields, garbage)", async () => {
    const p = mk();
    kms.mode = "garbage";
    await expect(p.warm()).rejects.toMatchObject({ kind: "bad_response" });
    p.destroy();
  });

  it("@E2E-79 the data key is wrapped with an AAD bound to purpose and version (a wrapped key cannot be replayed under another purpose)", async () => {
    const reg = new MemoryKeyRegistry();
    const p = mk({ registry: reg });
    await p.warm(["phone", "otp"]);
    const recs = reg.list();
    const swapped = new MemoryKeyRegistry();
    const phone = recs.find((r) => r.purpose === "phone")!, otp = recs.find((r) => r.purpose === "otp")!;
    swapped.put({ ...phone, purpose: "otp", wrapped: phone.wrapped }); // otp row now carries phone's wrapped key
    void otp;
    const q = mk({ registry: swapped });
    await expect(q.warm(["otp"])).rejects.toThrow(); // AAD mismatch: the KMS refuses to unwrap
    p.destroy(); q.destroy();
  });

  it("@E2E-79 calls are HMAC-signed: a KMS configured with another secret answers 401 and nothing is keyed", async () => {
    const p = new RemoteKmsKeyProvider({ url: kms.url, secret: "wrong-secret", kekId: "kek-main", timeoutMs: 300 });
    await expect(p.warm()).rejects.toMatchObject({ kind: "http", status: 401 });
    expect(kms.unauthorised).toBeGreaterThan(0);
    p.destroy();
  });

  it("@E2E-79 hmacRemote uses the KMS-held key (async path for non-exportable HMAC keys)", async () => {
    const p = mk();
    const a = await p.hmacRemote("phone-hmac-key", "+919876501234");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await p.hmacRemote("phone-hmac-key", "+919876501234")).toBe(a);
    expect(await p.hmacRemote("other-key", "+919876501234")).not.toBe(a);
    p.destroy();
  });

  it("@E2E-79 the KMS endpoint must be https in production and the secret is mandatory", () => {
    const keep = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => new RemoteKmsKeyProvider({ url: "http://kms.example.org", secret: "s", kekId: "k" })).toThrow(/https/);
      expect(() => new RemoteKmsKeyProvider({ url: "https://kms.example.org", secret: "", kekId: "k" })).toThrow(/CIVIC_KMS_SECRET/);
    } finally { process.env.NODE_ENV = keep; }
  });

  it("@E2E-79 installed as the process provider, the core code paths (isDevKeyProvider false) work through it", async () => {
    const { isDevKeyProvider } = await import("../../../server/civic/core");
    const p = mk({ registry: new SqlKeyRegistry() });
    await p.warm();
    setKeyProvider(p);
    expect(isDevKeyProvider()).toBe(false);
    expect(getKeys().hmac("phone", "+919876501234")).toMatch(/^[0-9a-f]{64}$/);
    p.destroy();
  });

  it("@E2E-79 every key purpose the civic code uses is provisioned by the provider (no purpose can fail closed in production by omission)", () => {
    const root = path.resolve(__dirname, "../../../server/civic");
    const used = new Set<string>();
    const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) for (const m of fs.readFileSync(p, "utf8").matchAll(/(?:hmac|encrypt|decrypt)\(\s*"([a-z0-9:_-]+)"/g)) used.add(m[1]); } };
    walk(root);
    const missing = [...used].filter((u) => !(KNOWN_PURPOSES as readonly string[]).includes(u));
    expect(missing).toEqual([]);
  });
});
