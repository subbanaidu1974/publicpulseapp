/**
 * KeyProvider CONTRACT SUITE v2 (S-64, E2E-79). A KMS/HSM adapter is certified when `runKeyProviderContract` passes against it.
 * The factory returns a COLD provider (nothing unwrapped yet) wired to a simulator of the KMS, plus controls for outages and the clock.
 * See docs/PROVIDERS.md. Break-glass and rehash behaviour are provider-independent and tested in breakglass.test.ts / rehash.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../../../../server/civic/core";
import type { KeyProviderV2 } from "../../../../server/civic/providers/keys";
import { setProviderLogger } from "../../../../server/civic/providers/util";

export interface KeyHarness {
  provider: KeyProviderV2;
  /** A NEW provider instance over the same KMS and the same key registry (a process restart). Cold. */
  restart(): KeyProviderV2;
  /** true = the KMS is unreachable / failing. */
  breakKms(on: boolean): void;
  /** Move the provider's clock forward. */
  advance(ms: number): void;
  /** Base64 of every clear data key the KMS was shown (wrap requests), so the suite can prove none reaches a log. */
  keyMaterialSeen(): string[];
  close(): Promise<void>;
}
export type KeyHarnessFactory = (o: { cacheTtlMs: number }) => Promise<KeyHarness>;

const TTL = 60_000;

export function runKeyProviderContract(name: string, factory: KeyHarnessFactory): void {
  describe(`KeyProvider v2 contract: ${name}`, () => {
    let h: KeyHarness; let logs: string[];
    beforeEach(async () => { resetDbForTests(); migrate(); logs = []; setProviderLogger((l) => logs.push(l)); h = await factory({ cacheTtlMs: TTL }); });
    afterEach(async () => { h.provider.destroy(); await h.close(); setProviderLogger(null); resetDbForTests(); });
    const ready = async () => { await h.provider.warm(); return h.provider; };

    it("@E2E-79 hmac is deterministic per purpose, hex, and separated by purpose and input", async () => {
      const p = await ready();
      const a = p.hmac("phone", "+919876501234");
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(p.hmac("phone", "+919876501234")).toBe(a);
      expect(p.hmac("otp", "+919876501234")).not.toBe(a);
      expect(p.hmac("phone", "+919876501235")).not.toBe(a);
      expect(p.hmac("phone", "")).toMatch(/^[0-9a-f]{64}$/);
    });

    it("@E2E-79 a restarted provider (cold cache, same KMS and registry) reproduces hashes and decrypts old ciphertext", async () => {
      const p = await ready();
      const h1 = p.hmac("phone", "+919876501234"), c = p.encrypt("residence", "Plot 7, Ward 3");
      const q = h.restart();
      await q.warm();
      expect(q.hmac("phone", "+919876501234")).toBe(h1);
      expect(q.decrypt("residence", c)).toBe("Plot 7, Ward 3");
      q.destroy();
    });

    it("@E2E-79 encrypt/decrypt round-trips unicode, is randomized, bound to purpose, and rejects tampering", async () => {
      const p = await ready();
      const c1 = p.encrypt("phone", "+919876501234 తెలుగు"), c2 = p.encrypt("phone", "+919876501234 తెలుగు");
      expect(c1).not.toBe(c2);
      expect(p.decrypt("phone", c1)).toBe("+919876501234 తెలుగు");
      expect(() => p.decrypt("residence", c1)).toThrow();
      // flip a character well inside the ciphertext: the tail can hold unused base64 bits, where a flip may change nothing
      const mid = c1.lastIndexOf(".") + 1 + Math.floor((c1.length - c1.lastIndexOf(".") - 1) / 2);
      const flipped = c1.slice(0, mid) + (c1[mid] === "A" ? "B" : "A") + c1.slice(mid + 1);
      expect(flipped).not.toBe(c1);
      expect(() => p.decrypt("phone", flipped)).toThrow();
      expect(() => p.decrypt("phone", "garbage")).toThrow();
      expect(() => p.decrypt("phone", "v2.1.AAAA")).toThrow();
      expect(c1).not.toContain("9876501234");
    });

    it("@E2E-79 fails closed before warm-up and for a purpose that was never provisioned", async () => {
      expect(() => h.provider.hmac("phone", "x")).toThrow();
      expect(() => h.provider.encrypt("phone", "x")).toThrow();
      const p = await ready();
      expect(() => p.hmac("not-a-known-purpose", "x")).toThrow();
      expect(() => p.encrypt("not-a-known-purpose", "x")).toThrow();
    });

    it("@E2E-79 key ids and versions: keyInfo, rotate, dual-read candidates and old data stays decryptable", async () => {
      const p = await ready();
      const v1 = p.keyInfo("phone");
      expect(v1).toMatchObject({ purpose: "phone", version: 1, retiredAt: null });
      expect(v1.keyId).toContain("phone");
      const oldHash = p.hmac("phone", "+919876501234"), oldCt = p.encrypt("phone", "+919876501234"), otpBefore = p.hmac("otp", "1");
      const v2 = await p.rotate("phone");
      expect(v2.version).toBe(2);
      expect(p.keyInfo("phone").keyId).not.toBe(v1.keyId);
      const newHash = p.hmac("phone", "+919876501234");
      expect(newHash).not.toBe(oldHash); // single-write: new hashes use the new key
      expect(p.hmacVersioned("phone", "+919876501234", 1)).toBe(oldHash);
      expect(p.hmacVersioned("phone", "+919876501234", 2)).toBe(newHash);
      expect(p.hmacCandidates("phone", "+919876501234")).toEqual([newHash, oldHash]); // dual-read: current first
      expect(p.activeVersions("phone")).toEqual([2, 1]);
      expect(p.decrypt("phone", oldCt)).toBe("+919876501234"); // rotation keeps old data decryptable
      expect(p.encrypt("phone", "x")).toMatch(/^v2\.2\./);
      expect(p.hmac("otp", "1")).toBe(otpBefore); // other purposes untouched
    });

    it("@E2E-79 rotation survives a restart; retiring the old version makes its data undecryptable; the current version cannot be retired", async () => {
      const p = await ready();
      const oldCt = p.encrypt("phone", "old"), oldHash = p.hmac("phone", "+91");
      await p.rotate("phone");
      const q = h.restart(); await q.warm();
      expect(q.activeVersions("phone")).toEqual([2, 1]);
      expect(q.decrypt("phone", oldCt)).toBe("old");
      expect(q.hmacVersioned("phone", "+91", 1)).toBe(oldHash);
      await expect(q.retire("phone", 2)).rejects.toThrow(/current/);
      await q.retire("phone", 1);
      expect(q.activeVersions("phone")).toEqual([2]);
      expect(() => q.decrypt("phone", oldCt)).toThrow();
      expect(q.hmacCandidates("phone", "+91")).toHaveLength(1);
      q.destroy();
    });

    it("@E2E-79 rotating the audit-chain key is refused without force (it would break verification of the existing chain)", async () => {
      const p = await ready();
      await expect(p.rotate("audit")).rejects.toThrow(/force/);
      await expect(p.rotate("audit", { force: true })).resolves.toMatchObject({ version: 2 });
    });

    it("@E2E-79 KMS outage: a cold start fails (never half-keyed); a warm cache keeps serving until its TTL, then fails closed; recovery restores service", async () => {
      h.breakKms(true);
      await expect(h.provider.warm()).rejects.toThrow();
      expect(() => h.provider.hmac("phone", "x")).toThrow();
      h.breakKms(false);
      const p = await ready();
      const ct = p.encrypt("phone", "+919876501234");
      h.breakKms(true);
      expect(p.decrypt("phone", ct)).toBe("+919876501234"); // cache still valid
      h.advance(TTL + 1000);
      expect(() => p.hmac("phone", "x")).toThrow(/expired|not available/);
      expect(() => p.decrypt("phone", ct)).toThrow();
      expect(p.health().ready).toBe(false);
      h.breakKms(false);
      await p.warm();
      expect(p.decrypt("phone", ct)).toBe("+919876501234");
      expect(p.health().ready).toBe(true);
    });

    it("@E2E-79 a failed background refresh keeps the old key until its TTL (fail closed later, not now)", async () => {
      const p = await ready();
      h.advance(TTL / 2 + 1000);
      h.breakKms(true);
      expect((await p.refresh()).ok).toBe(false);
      expect(() => p.hmac("phone", "x")).not.toThrow();
      h.breakKms(false);
      expect((await p.refresh()).ok).toBe(true);
    });

    it("@E2E-79 destroy() zeroizes the cache and the provider fails closed afterwards", async () => {
      const p = await ready();
      const ct = p.encrypt("phone", "x");
      p.destroy();
      expect(() => p.hmac("phone", "x")).toThrow();
      expect(() => p.decrypt("phone", ct)).toThrow();
      await expect(p.warm()).rejects.toThrow();
    });

    it("@E2E-79 no key material or plaintext in logs, including on failure paths", async () => {
      const p = await ready();
      p.encrypt("phone", "+919876501234");
      await p.rotate("phone");
      h.breakKms(true);
      await p.refresh(); h.advance(TTL / 2 + 1);
      await p.refresh();
      h.advance(TTL);
      try { p.hmac("phone", "+919876501234"); } catch { /* expected */ }
      const all = logs.join("\n");
      expect(all.length).toBeGreaterThan(0);
      for (const k of h.keyMaterialSeen()) expect(all).not.toContain(k);
      expect(all).not.toContain("9876501234");
    });

    it("@E2E-79 health() reports readiness and cached key count", async () => {
      expect(h.provider.health().ready).toBe(false);
      const p = await ready();
      expect(p.health()).toMatchObject({ ready: true });
      expect(p.health().cachedKeys).toBeGreaterThanOrEqual(20);
    });
  });
}
