/**
 * NumberIntelligence CONTRACT SUITE v2 (S-62, E2E-77). A vendor adapter is certified when `runNumberIntelContract` passes against it.
 * The factory returns the adapter wrapped in ManagedNumberIntel (or any NumberIntelligenceV2) plus a vendor simulator's controls.
 * See docs/PROVIDERS.md.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../../../../server/civic/core";
import type { ManagedIntelOpts, NumberIntelligenceV2, RawNumberFacts } from "../../../../server/civic/providers/numberintel";
import { setProviderLogger } from "../../../../server/civic/providers/util";

export interface IntelHarness {
  intel: NumberIntelligenceV2;
  /** What the vendor should answer for this number. */
  setFacts(e164: string, f: Partial<RawNumberFacts>): void;
  setMode(m: "ok" | "error500" | "timeout" | "garbage"): void;
  /** Number of vendor calls so far. */
  calls(): number;
  /** Raw request bodies the vendor received. */
  bodies(): string[];
  /** Move the adapter's clock forward (cache TTLs). */
  advance(ms: number): void;
  close(): Promise<void>;
}
export type IntelHarnessFactory = (o: ManagedIntelOpts) => Promise<IntelHarness>;

const N = "+919876512345";
const base: RawNumberFacts = { lineType: "mobile_postpaid", recycled: false, portedRecently: false, carrierCircle: "AP", activationAgeDays: 900, activationConfidence: 0.9 };

export function runNumberIntelContract(name: string, factory: IntelHarnessFactory): void {
  describe(`NumberIntelligence contract: ${name}`, () => {
    let h: IntelHarness; let logs: string[];
    const make = async (o: ManagedIntelOpts = {}) => { h = await factory({ timeoutMs: 150, cacheTtlMs: 10_000, unknownTtlMs: 2_000, ...o }); return h; };
    beforeEach(() => { resetDbForTests(); migrate(); logs = []; setProviderLogger((l) => logs.push(l)); });
    afterEach(async () => { await h?.close(); setProviderLogger(null); resetDbForTests(); });

    it("@E2E-77 classifies line type, recycled flag, port status, circle and activation-age confidence into a risk class", async () => {
      await make();
      h.setFacts(N, base);
      expect(await h.intel.lookup(N)).toMatchObject({ risk: "low", trust: "normal", lineType: "mobile_postpaid", carrierCircle: "AP", activationAgeDays: 900, activationConfidence: 0.9, voip: false, recently_reissued: false, source: "vendor" });
      h.setFacts("+919876512346", { lineType: "voip" });
      expect(await h.intel.lookup("+919876512346")).toMatchObject({ risk: "high", voip: true });
      h.setFacts("+919876512347", { recycled: true });
      expect(await h.intel.lookup("+919876512347")).toMatchObject({ risk: "high", recently_reissued: true, recycled: true });
      h.setFacts("+919876512348", { portedRecently: true });
      expect(await h.intel.lookup("+919876512348")).toMatchObject({ risk: "medium", portedRecently: true });
      h.setFacts("+919876512349", { lineType: "mobile_prepaid", activationAgeDays: 5, activationConfidence: 0.8 });
      expect(await h.intel.lookup("+919876512349")).toMatchObject({ risk: "medium", activationAgeDays: 5 });
      h.setFacts("+919876512350", { lineType: "mobile_prepaid", activationAgeDays: 5, activationConfidence: 0.1 });
      expect((await h.intel.lookup("+919876512350")).risk).toBe("low"); // too little confidence in the age to act on it
    });

    it("@E2E-77 a vendor that knows nothing yields unknown risk with reduced trust, not a guess", async () => {
      await make();
      h.setFacts(N, { lineType: "unknown", recycled: null, portedRecently: null, activationAgeDays: null, activationConfidence: null, carrierCircle: null });
      expect(await h.intel.lookup(N)).toMatchObject({ risk: "unknown", trust: "reduced", activationConfidence: 0 });
    });

    it("@E2E-77 failure policy: timeout, 5xx and garbage answers all give unknown + reduced trust, never throw and never block sign-up", async () => {
      await make();
      for (const mode of ["timeout", "error500", "garbage"] as const) {
        h.setMode(mode);
        const t0 = Date.now();
        const r = await h.intel.lookup("+9198765" + (10000 + ["timeout", "error500", "garbage"].indexOf(mode)));
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(r).toMatchObject({ risk: "unknown", trust: "reduced", voip: false, recently_reissued: false, source: "unknown" });
      }
    });

    it("@E2E-77 caching: repeat lookups are served from the cache (keyed by phone hash) until the TTL; failures are cached only briefly", async () => {
      await make();
      h.setFacts(N, base);
      await h.intel.lookup(N);
      expect((await h.intel.lookup(N)).source).toBe("cache");
      expect(h.calls()).toBe(1);
      h.advance(11_000);
      expect((await h.intel.lookup(N)).source).toBe("vendor");
      expect(h.calls()).toBe(2);
      h.setMode("error500");
      const M = "+919876512399";
      expect((await h.intel.lookup(M)).risk).toBe("unknown");
      const c = h.calls();
      await h.intel.lookup(M); // within the unknown TTL: no hammering
      expect(h.calls()).toBe(c);
      h.setMode("ok"); h.advance(2_500);
      expect((await h.intel.lookup(M)).source).toBe("vendor"); // recovered promptly
    });

    it("@E2E-77 concurrent lookups of one number make one vendor call", async () => {
      await make();
      const rs = await Promise.all([h.intel.lookup(N), h.intel.lookup(N), h.intel.lookup(N)]);
      expect(h.calls()).toBe(1);
      expect(new Set(rs.map((r) => r.risk)).size).toBe(1);
    });

    it("@E2E-77 an unhealthy vendor trips the circuit: later lookups are answered unknown without calling it", async () => {
      await make();
      h.setMode("error500");
      for (let i = 0; i < 5; i++) await h.intel.lookup("+91987651" + (3000 + i));
      const c = h.calls();
      const r = await h.intel.lookup("+919876513999");
      expect(r.risk).toBe("unknown");
      expect(h.calls()).toBe(c);
    });

    it("@E2E-77 privacy: only the number (and a random request id) is sent, never person/session/device data, and logs carry no clear number", async () => {
      await make();
      h.setFacts(N, base);
      await h.intel.lookup(N);
      h.setMode("error500");
      await h.intel.lookup("+919876512777");
      h.setMode("timeout");
      await h.intel.lookup("+919876512778");
      for (const b of h.bodies()) expect(Object.keys(JSON.parse(b)).sort()).toEqual(["msisdn", "request_id", "version"]);
      const all = logs.join("\n");
      expect(all.length).toBeGreaterThan(0);
      for (const bad of ["9876512345", "9876512777", "9876512778", "+91987"]) expect(all).not.toContain(bad);
    });
  });
}
