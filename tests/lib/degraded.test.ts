import { describe, expect, it } from "vitest";
import { nextPollDelay, POLL_DEGRADED_MS, POLL_MAX_MS, POLL_OK_MS, shedFrom } from "../../src/lib/degraded";

describe("degraded client policy (S-46, E2E-56)", () => {
  it("@E2E-56 polls slower when healthy, faster when degraded, and backs off exponentially up to a cap", () => {
    expect(nextPollDelay(0, false)).toBe(POLL_OK_MS);
    expect(nextPollDelay(0, true)).toBe(POLL_DEGRADED_MS);
    expect(nextPollDelay(1, false)).toBe(POLL_OK_MS * 2);
    expect(nextPollDelay(2, true)).toBe(POLL_OK_MS * 4);
    expect(nextPollDelay(50, false)).toBe(POLL_MAX_MS);
  });
  it("@E2E-56 recognises the server shed answer and the OTP queue-full answer, nothing else", () => {
    const shed = shedFrom(503, { error: "degraded", shed: "export", retry_after_seconds: 60, notice_en: "a", notice_te: "b" }, "60");
    expect(shed).toMatchObject({ shed: "export", notice_en: "a", notice_te: "b", retry_after_s: 60 });
    expect(shedFrom(503, { error: "sms queue is full", degraded: true, retry_after_seconds: 7 })?.retry_after_s).toBe(7);
    expect(shedFrom(429, { error: "sms capacity", degraded: true }, "300")?.retry_after_s).toBe(300);
    expect(shedFrom(429, { error: "too many" })).toBeNull();
    expect(shedFrom(503, { error: "boom" })).toBeNull();
    expect(shedFrom(500, { error: "degraded" })).toBeNull();
    expect(shedFrom(503, null)).toBeNull();
  });
});
