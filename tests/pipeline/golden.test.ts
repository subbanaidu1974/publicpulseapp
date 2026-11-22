import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateResult } from "../../src/lib/elections";
import { filterElection, seatResults, seatTally } from "../../src/lib/elections";
import { comparabilityNotes } from "../../src/lib/comparability";
import type { ElectionType, StateCode } from "../../src/lib/states";

const snap = JSON.parse(readFileSync(resolve(__dirname, "../../data/generated/elections.json"), "utf8")) as { provenance: string; results: CandidateResult[] };
const rows = snap.results;

/** Pinned from the committed TCPD/ECI snapshot and cross-checked against the published seat totals. */
const GOLDEN: [StateCode, number, ElectionType, { seats: number; candidates: number; validVotesPolled: number; tally: Record<string, number> }][] = [
  ["AP", 2014, "assembly", { seats: 175, candidates: 2416, validVotesPolled: 28952127, tally: { TDP: 102, YSRCP: 67, BJP: 4, IND: 1, NPT: 1 } }],
  ["AP", 2019, "assembly", { seats: 175, candidates: 2293, validVotesPolled: 31409811, tally: { YSRCP: 151, TDP: 23, JSP: 1 } }],
  ["AP", 2024, "assembly", { seats: 175, candidates: 2562, validVotesPolled: 33736917, tally: { TDP: 135, JSP: 21, YSRCP: 11, BJP: 8 } }],
  ["TG", 2014, "assembly", { seats: 119, candidates: 1788, validVotesPolled: 19448279, tally: { BRS: 63, INC: 21, TDP: 15, AIMIM: 7, BJP: 5, YSRCP: 3, BSP: 2, CPI: 1, CPM: 1, IND: 1 } }],
  ["TG", 2018, "assembly", { seats: 119, candidates: 1940, validVotesPolled: 20695458, tally: { BRS: 88, INC: 19, AIMIM: 7, TDP: 2, AIFB: 1, BJP: 1, IND: 1 } }],
  ["TG", 2023, "assembly", { seats: 119, candidates: 2409, validVotesPolled: 23439945, tally: { INC: 64, BRS: 39, BJP: 8, AIMIM: 7, CPI: 1 } }],
  ["AP", 2019, "ls", { seats: 25, candidates: 344, validVotesPolled: 31612534, tally: { YSRCP: 22, TDP: 3 } }],
  ["AP", 2024, "ls", { seats: 25, candidates: 479, validVotesPolled: 33729624, tally: { TDP: 16, YSRCP: 4, BJP: 3, JSP: 2 } }],
  ["TG", 2019, "ls", { seats: 17, candidates: 460, validVotesPolled: 18642895, tally: { BRS: 9, BJP: 4, INC: 3, AIMIM: 1 } }],
  ["TG", 2024, "ls", { seats: 17, candidates: 542, validVotesPolled: 22008373, tally: { BJP: 8, INC: 8, AIMIM: 1 } }],
];

describe("@E2E-136 golden tests for the real election snapshot", () => {
  it("the committed snapshot is real data, not the demo fixture", () => {
    expect(snap.provenance).not.toBe("demo");
  });

  for (const [state, year, type, g] of GOLDEN) {
    it(`${state} ${year} ${type}: seat winners by party, candidate count and votes are pinned`, () => {
      const el = filterElection(rows, state, year, type);
      const seats = seatResults(el);
      expect(seats).toHaveLength(g.seats);
      expect(el).toHaveLength(g.candidates);
      expect(el.reduce((s, r) => s + r.votes, 0)).toBe(g.validVotesPolled);
      expect(seatTally(seats)).toEqual(g.tally);
      expect(Object.values(seatTally(seats)).reduce((a, b) => a + b, 0)).toBe(g.seats);
    });
  }

  it("headline figures quoted in the brief hold (AP 2014 TDP 102, 2019 YSRCP 151, 2024 TDP 135; TG 2023 INC 64)", () => {
    const t = (s: StateCode, y: number) => seatTally(seatResults(filterElection(rows, s, y, "assembly")));
    expect(t("AP", 2014)).toMatchObject({ TDP: 102, YSRCP: 67, BJP: 4 });
    expect(t("AP", 2019)).toMatchObject({ YSRCP: 151, TDP: 23, JSP: 1 });
    expect(t("AP", 2024)).toMatchObject({ TDP: 135, JSP: 21, YSRCP: 11, BJP: 8 });
    expect(t("TG", 2014)).toMatchObject({ BRS: 63, INC: 21, TDP: 15, AIMIM: 7, BJP: 5 });
    expect(t("TG", 2018)).toMatchObject({ BRS: 88, INC: 19, AIMIM: 7 });
    expect(t("TG", 2023)).toMatchObject({ INC: 64, BRS: 39, BJP: 8, AIMIM: 7, CPI: 1 });
  });
});

describe("@E2E-136 comparability notes", () => {
  it("AP 2014 -> 2019 explains the residual state and the district reorganisation", () => {
    const n = comparabilityNotes("AP", 2014, 2019, "assembly").join(" ");
    expect(n).toMatch(/residual state/);
    expect(n).toMatch(/13 districts to 26/);
    expect(n).toMatch(/2008 delimitation/);
  });
  it("TG 2018 -> 2023 notes the TRS to BRS rename and the alliance change", () => {
    const n = comparabilityNotes("TG", 2018, 2023, "assembly").join(" ");
    expect(n).toMatch(/TRS\) was renamed/);
    expect(n).toMatch(/alliance arrangements differ/);
  });
  it("2014 notes do not appear for later comparisons", () => {
    expect(comparabilityNotes("AP", 2019, 2024, "assembly").join(" ")).not.toMatch(/bifurcation/);
  });
});
