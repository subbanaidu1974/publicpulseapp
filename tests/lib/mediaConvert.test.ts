import { describe, expect, it } from "vitest";
import spec from "../../data/civic/client-media-spec.json";
import { CONVERT_DEFAULTS, SERVER_LIMITS, fitSize, nextAttempt } from "../../src/lib/mediaConvert";

describe("mediaConvert matches data/civic/client-media-spec.json (S-138)", () => {
  it("@E2E-152 defaults come from the spec", () => {
    expect(CONVERT_DEFAULTS).toEqual(spec.helper.defaults);
    expect(CONVERT_DEFAULTS.maxSide).toBeLessThanOrEqual(SERVER_LIMITS.max_side_px_default);
    expect(CONVERT_DEFAULTS.maxBytes).toBeLessThanOrEqual(SERVER_LIMITS.max_bytes_default);
  });
  it("scales the longer side down, never up", () => {
    expect(fitSize(4000, 3000, 2048)).toEqual({ w: 2048, h: 1536 });
    expect(fitSize(100, 50, 2048)).toEqual({ w: 100, h: 50 });
  });
  it("retry schedule: quality -0.1 down to a 0.5 floor, then maxSide -25%", () => {
    let a = { quality: 0.82, maxSide: 2048 };
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) { seen.push(`${a.quality}/${a.maxSide}`); a = nextAttempt(a); }
    expect(seen).toEqual(["0.82/2048", "0.72/2048", "0.62/2048", "0.52/2048", "0.52/1536"]);
  });
});
