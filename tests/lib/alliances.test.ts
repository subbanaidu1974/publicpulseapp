import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLIANCES, ALLIANCE_RECORDS, allianceGroups } from "../../src/lib/states";
import { aggregateAlliances } from "../../src/lib/elections";
import { PARTIES } from "../../src/lib/parties";

const data = JSON.parse(readFileSync(resolve(__dirname, "../../data/reference/alliances.json"), "utf8"));

describe("@E2E-120 per-election alliance dataset", () => {
  it("covers AP 2014/2019/2024 and TG 2014/2018/2023 assemblies plus AP LS 2019/2024, and nothing is invented for the rest", () => {
    for (const k of ["AP-2014-assembly", "AP-2019-assembly", "AP-2024-assembly", "TG-2014-assembly", "TG-2018-assembly", "TG-2023-assembly", "AP-2019-ls", "AP-2024-ls"]) {
      expect(ALLIANCES[k], k).toBeTruthy();
    }
    // Cited pages name no state-level alliance for TG Lok Sabha: no record, no grouping.
    expect(ALLIANCES["TG-2019-ls"]).toBeUndefined();
    expect(ALLIANCES["TG-2024-ls"]).toBeUndefined();
  });

  it("every group is cited, typed and uses registry parties", () => {
    for (const r of data.records) for (const g of r.groups) {
      expect(["pre-poll", "post-hoc"]).toContain(g.kind);
      expect(["high", "medium", "low"]).toContain(g.confidence);
      expect(g.sources.length).toBeGreaterThan(0);
      for (const u of g.sources) expect(u.startsWith("https://en.wikipedia.org/wiki/")).toBe(true);
      expect(g.parties.length).toBeGreaterThanOrEqual(2);
      for (const p of g.parties) expect(PARTIES[p], `${r.key} ${p}`).toBeTruthy();
    }
  });

  it("a party appears in at most one pre-poll group per election", () => {
    for (const r of data.records) {
      const seen = new Set<string>();
      for (const g of r.groups.filter((x: { kind: string }) => x.kind === "pre-poll")) for (const p of g.parties) {
        expect(seen.has(p), `${r.key} ${p}`).toBe(false);
        seen.add(p);
      }
    }
  });

  it("pre-poll facts: AP 2014 TDP+BJP, AP 2024 TDP+JSP+BJP, TG 2018 Praja Kutami, TG 2023 INC with CPI", () => {
    expect(Object.values(ALLIANCES["AP-2014-assembly"]).flat().sort()).toEqual(["BJP", "TDP"]);
    expect(ALLIANCES["AP-2024-assembly"]["NDA (TDP+JSP+BJP)"]).toEqual(["TDP", "JSP", "BJP"]);
    expect(ALLIANCES["TG-2018-assembly"]["Praja Kutami (INC+TDP+CPI+TJS)"]).toEqual(["INC", "TDP", "CPI", "TJS"]);
    expect(ALLIANCES["TG-2023-assembly"]["INC+ (INC+CPI)"]).toEqual(["INC", "CPI"]);
  });

  it("hindsight groupings are labelled post-hoc and excluded from ALLIANCES", () => {
    const post = allianceGroups("AP", 2019, "assembly", "post-hoc");
    expect(post).toHaveLength(1);
    expect(post[0].name).toMatch(/^Hindsight/);
    expect(Object.keys(ALLIANCES["AP-2019-assembly"]).some(n => /Hindsight/.test(n))).toBe(false);
    expect(ALLIANCE_RECORDS["AP-2019-assembly"].groups.map(g => g.kind).sort()).toEqual(["post-hoc", "pre-poll"]);
  });

  it("aggregation works for a previously uncovered election (AP 2019: JSP+ front)", () => {
    const tally = { YSRCP: 151, TDP: 23, JSP: 1 };
    expect(aggregateAlliances(tally, ALLIANCES["AP-2019-assembly"])).toEqual({ YSRCP: 151, TDP: 23, "JSP+ (JSP+BSP+CPI+CPM)": 1 });
  });
});
