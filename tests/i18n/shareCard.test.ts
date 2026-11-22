import { describe, expect, it } from "vitest";
import { buildCard, cardToSvg, wrap } from "../../src/lib/shareCard";

const labels = { source: "Source", asOf: "Data as of", projection: "Model projection from past results. Not a poll, not a prediction of any outcome.", demo: "Demo data", footer: "People Pulse" };
const base = { title: "Andhra Pradesh 2024 Assembly: Seats won", lines: [{ label: "TDP", value: "135" }, { label: "BJP", value: "8" }, { label: "YSRCP", value: "11" }], source: "ECI / TCPD Lok Dhaba", asOf: "2026-11-01", labels };

describe("share card (S-122)", () => {
  it("@E2E-137 the card text carries the figure, source and as-of date", () => {
    const c = buildCard(base);
    const all = c.text.join("\n");
    expect(all).toContain("TDP 135");
    expect(all).toContain("Source: ECI / TCPD Lok Dhaba");
    expect(all).toContain("Data as of: 2026-11-01");
    const svg = cardToSvg(c);
    expect(svg).toContain("ECI / TCPD Lok Dhaba");
    expect(svg).toContain("2026-11-01");
    expect(svg).toContain("<svg");
  });
  it("@E2E-137 a projection card carries the not-a-poll disclaimer; a plain card does not claim to be a projection", () => {
    expect(buildCard({ ...base, projection: true }).text.join(" ")).toMatch(/Not a poll, not a prediction/);
    expect(buildCard(base).text.join(" ")).not.toMatch(/projection/i);
  });
  it("@E2E-137 demo data is stamped on the card", () => {
    expect(buildCard({ ...base, demo: true }).text).toContain("Demo data");
  });
  it("@E2E-137 entries are listed alphabetically so the card never ranks or favours a party", () => {
    const order = buildCard(base).prims.filter((p) => p.kind === "text" && p.size === 32 && p.anchor !== "end").map((p) => p.text);
    expect(order).toEqual(["BJP", "TDP", "YSRCP"]);
  });
  it("@E2E-137 text is XML-escaped in the SVG", () => {
    const svg = cardToSvg(buildCard({ ...base, title: "A <b> & \"c\"" }));
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt; &amp; &quot;c&quot;");
  });
  it("@E2E-137 no party-leaning copy in the guardrail strings", () => {
    expect(JSON.stringify(labels)).not.toMatch(/landslide|wave|sweep|will win/i);
  });
  it("wrap breaks long text without losing words", () => {
    const t = "one two three four five six seven eight nine ten";
    expect(wrap(t, 12).join(" ")).toBe(t);
    expect(Math.max(...wrap(t, 12).map((l) => l.length))).toBeLessThanOrEqual(12);
  });
});
