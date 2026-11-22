import { describe, expect, it } from "vitest";
import { runOtpFlood, report as otpReport } from "../../scripts/load/otp-flood";
import { runCountDay, report as countReport } from "../../scripts/load/count-day";

/** Short smoke runs (a few seconds each) of the load scripts, against localhost only. Full numbers: docs/PERFORMANCE.md. */
describe("load scripts smoke (@E2E-90)", () => {
  it("@E2E-90 OTP flood: caps hold, 429 under flood, no unexpected 5xx", async () => {
    const rs = await runOtpFlood({ smoke: true });
    console.log(otpReport(rs));
    for (const r of rs) {
      expect(r.unexpected5xx, r.name).toBe(0);
      expect(r.stats.errors, r.name).toBe(0);
      expect(r.sent, `${r.name}: ${r.cap}`).toBeLessThanOrEqual(r.name === "many /24s / SMS budget" ? 25 : r.name.startsWith("one phone") ? 3 : r.name.startsWith("one /24") ? 60 : 10);
      expect((r.stats.status[429] ?? 0) + r.degraded503, r.name).toBeGreaterThan(0); // the flood was throttled, not served
    }
    expect(rs.every((r) => r.ok)).toBe(true);
  }, 180_000);

  it("@E2E-90 count-day reads: 200s, ETag answers 304, gzip on, no errors under load", async () => {
    const r = await runCountDay({ smoke: true });
    console.log(countReport(r));
    expect(r.problems).toEqual([]);
    expect(r.mixed[0].stats.requests).toBeGreaterThan(100);
    expect(r.caching.filter((c) => c.etag).every((c) => c.revalidated === 304)).toBe(true);
    expect(r.caching.find((c) => c.path.endsWith("ac.geojson"))?.cacheControl).toMatch(/max-age=\d+/);
  }, 180_000);
});
