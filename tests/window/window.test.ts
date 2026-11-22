import { describe, expect, it } from "vitest";
import { forecastDecision, loadCalendar, parseInstant, surveysAllowed, windowState } from "../../server/window";
import type { Calendar } from "../../server/window";

const cal: Calendar = {
  schema: 1, coveredFrom: "2099-01-01", coveredThrough: "2100-01-01",
  entries: [
    { state: "AP", mccStart: "2099-03-01T00:00:00+05:30", end: "2099-03-10T00:00:00+05:30", source: "https://x.invalid", verified: true },
    { state: "TG", mccStart: "2099-06-01", end: "2099-06-05", source: "https://x.invalid", verified: false },
    { state: "TG", mccStart: "2099-07-01", end: "2099-07-05", source: "https://x.invalid", verified: true, example: true },
  ],
};
const at = (s: string) => new Date(s);
const env = {} as NodeJS.ProcessEnv;

describe("election window", () => {
  it("@E2E-133 blackout only inside [mccStart, end) with exact boundaries", () => {
    const o = { calendar: cal, env };
    expect(windowState("AP", at("2099-02-28T23:59:59.999+05:30"), o)).toBe("open");
    expect(windowState("AP", at("2099-03-01T00:00:00+05:30"), o)).toBe("blackout");
    expect(windowState("AP", at("2099-03-09T23:59:59.999+05:30"), o)).toBe("blackout");
    expect(windowState("AP", at("2099-03-10T00:00:00+05:30"), o)).toBe("open");
    expect(windowState("ap", at("2099-03-05T00:00:00Z"), o)).toBe("blackout");
  });
  it("@E2E-133 unverified and example entries never close or open anything", () => {
    const o = { calendar: cal, env };
    expect(windowState("TG", at("2099-06-02T00:00:00+05:30"), o)).toBe("open");
    expect(windowState("TG", at("2099-07-02T00:00:00+05:30"), o)).toBe("open");
  });
  it("@E2E-133 unknown when calendar missing, empty, or now is outside coverage", () => {
    expect(windowState("AP", at("2099-03-05T00:00:00Z"), { calendar: null, env })).toBe("unknown");
    expect(windowState("AP", at("2098-12-31T18:29:59Z"), { calendar: cal, env })).toBe("unknown");
    expect(windowState("AP", at("2099-12-31T18:30:00Z"), { calendar: cal, env })).toBe("unknown");
    expect(windowState("AP", new Date(), { calendar: { ...cal, coveredFrom: null, coveredThrough: null }, env })).toBe("unknown");
  });
  it("@E2E-133 the shipped calendar has an empty real list, so every state is unknown (fail closed)", () => {
    const real = loadCalendar();
    expect(real).not.toBeNull();
    expect(real!.entries).toEqual([]);
    expect(windowState("AP", new Date(), { env })).toBe("unknown");
    expect(windowState("TG", new Date(), { env })).toBe("unknown");
  });
  it("@E2E-133 a missing or corrupt calendar file is null, hence unknown, not open", () => {
    expect(loadCalendar("Z:/does/not/exist.json")).toBeNull();
  });
  it("@E2E-133 FORECAST_BLACKOUT override", () => {
    expect(windowState("AP", at("2099-02-01T00:00:00Z"), { calendar: cal, env: { FORECAST_BLACKOUT: "1" } })).toBe("blackout");
    expect(windowState("AP", at("2099-03-05T00:00:00Z"), { calendar: cal, env: { FORECAST_BLACKOUT: "0" } })).toBe("open");
  });
  it("@E2E-133 forecast policy: hidden in blackout and unknown; unknown allowed only with the fail-open env", () => {
    const now = at("2099-03-05T00:00:00Z");
    expect(forecastDecision("AP", now, { calendar: cal, env })).toMatchObject({ show: false, reason: "blackout" });
    expect(forecastDecision("AP", now, { calendar: cal, env: { ELECTION_WINDOW_FAIL_OPEN_FORECAST: "1" } })).toMatchObject({ show: false, reason: "blackout" });
    expect(forecastDecision("AP", now, { calendar: null, env })).toMatchObject({ show: false, reason: "unknown" });
    expect(forecastDecision("AP", now, { calendar: null, env: { ELECTION_WINDOW_FAIL_OPEN_FORECAST: "1" } })).toMatchObject({ show: true, reason: "unknown-fail-open" });
    expect(forecastDecision("AP", at("2099-02-01T00:00:00Z"), { calendar: cal, env })).toMatchObject({ show: true, reason: "open" });
  });
  it("@E2E-133 surveys and notifications are allowed only when open (never on unknown)", () => {
    expect(surveysAllowed("AP", at("2099-02-01T00:00:00Z"), { calendar: cal, env })).toBe(true);
    expect(surveysAllowed("AP", at("2099-03-05T00:00:00Z"), { calendar: cal, env })).toBe(false);
    expect(surveysAllowed("AP", new Date(), { calendar: null, env: { ELECTION_WINDOW_FAIL_OPEN_FORECAST: "1" } })).toBe(false);
  });
  it("parseInstant treats date-only as IST midnight and rejects junk", () => {
    expect(parseInstant("2099-01-01")).toBe(Date.parse("2099-01-01T00:00:00+05:30"));
    expect(parseInstant("nope")).toBeNull();
    expect(parseInstant(5)).toBeNull();
  });
});
