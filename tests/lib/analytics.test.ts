import { describe, expect, it } from "vitest";
import {
  aggregateAlliances, marginBuckets, marginalSeats, seatResults, seatTally, splitVoting, swing, turnoutPct, voteShare,
} from "../../src/lib/elections";
import type { CandidateResult } from "../../src/lib/elections";

let n = 0;
const c = (acNo: number, party: string, votes: number, position: number, valid: number, year = 2024): CandidateResult => ({
  state: "AP", year, type: "assembly", acNo, acName: `AC${acNo}`, candidate: `${party}-${acNo}-${n++}`, party, votes, position, validVotes: valid,
});

describe("UT-analytics seatResults", () => {
  it("computes winner, runner-up and margin", () => {
    const [s] = seatResults([c(1, "A", 600, 1, 1000), c(1, "B", 300, 2, 1000), c(1, "C", 100, 3, 1000)]);
    expect(s.winnerParty).toBe("A");
    expect(s.runnerUpParty).toBe("B");
    expect(s.margin).toBe(300);
    expect(s.marginPct).toBeCloseTo(30);
    expect(s.tie).toBe(false);
  });

  it("sorts regardless of input order", () => {
    const [s] = seatResults([c(1, "B", 300, 2, 1000), c(1, "A", 600, 1, 1000)]);
    expect(s.winnerParty).toBe("A");
  });

  it("handles single-candidate (uncontested) seats", () => {
    const [s] = seatResults([c(1, "A", 500, 1, 500)]);
    expect(s.runnerUpParty).toBeNull();
    expect(s.uncontested).toBe(true);
    expect(s.margin).toBe(500);
    expect(Number.isFinite(s.marginPct)).toBe(true);
  });

  it("handles zero votes without NaN", () => {
    const [s] = seatResults([c(1, "A", 0, 1, 0), c(1, "B", 0, 2, 0)]);
    expect(s.margin).toBe(0);
    expect(s.marginPct).toBe(0);
    expect(s.winnerParty).toBe("A"); // falls back to recorded position
  });

  it("breaks exact ties by recorded position and flags the tie", () => {
    const [s] = seatResults([c(1, "B", 400, 2, 800), c(1, "A", 400, 1, 800)]);
    expect(s.winnerParty).toBe("A");
    expect(s.tie).toBe(true);
    expect(s.margin).toBe(0);
  });

  it("falls back to summed votes when validVotes is missing", () => {
    const [s] = seatResults([c(1, "A", 60, 1, 0), c(1, "B", 40, 2, 0)]);
    expect(s.validVotes).toBe(100);
    expect(s.marginPct).toBeCloseTo(20);
  });

  it("returns [] for no rows and orders seats by acNo", () => {
    expect(seatResults([])).toEqual([]);
    const seats = seatResults([c(3, "A", 1, 1, 1), c(1, "A", 1, 1, 1)]);
    expect(seats.map(s => s.acNo)).toEqual([1, 3]);
  });
});

describe("UT-analytics tally, share, swing", () => {
  const e19 = [c(1, "A", 60, 1, 100, 2019), c(1, "B", 40, 2, 100, 2019), c(2, "B", 70, 1, 100, 2019), c(2, "A", 30, 2, 100, 2019)];
  const e24 = [c(1, "A", 80, 1, 100), c(1, "B", 20, 2, 100), c(2, "A", 55, 1, 100), c(2, "B", 45, 2, 100)];

  it("tallies seats", () => {
    expect(seatTally(seatResults(e24))).toEqual({ A: 2 });
    expect(seatTally([])).toEqual({});
  });

  it("vote share sums to 100 and is 0-safe", () => {
    const vs = voteShare(e24);
    expect(Object.values(vs).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(voteShare([c(1, "A", 0, 1, 0)])).toEqual({ A: 0 });
    expect(voteShare([])).toEqual({});
  });

  it("swing sums to ~0 and treats absent parties as 0", () => {
    const sw = swing(e19, e24);
    expect(sw.A).toBeCloseTo(22.5);
    expect(sw.B).toBeCloseTo(-22.5);
    expect(Object.values(sw).reduce((a, b) => a + b, 0)).toBeCloseTo(0);
    const sw2 = swing(e19, [c(1, "Z", 100, 1, 100)]);
    expect(sw2.Z).toBeCloseTo(100);
    expect(sw2.A).toBeCloseTo(-45);
    expect(Object.values(sw2).reduce((a, b) => a + b, 0)).toBeCloseTo(0);
  });
});

describe("UT-analytics margins", () => {
  const seats = seatResults([
    c(1, "A", 505, 1, 1000), c(1, "B", 495, 2, 1000), // 1%
    c(2, "A", 540, 1, 1000), c(2, "B", 460, 2, 1000), // 8%
    c(3, "A", 800, 1, 1000), c(3, "B", 200, 2, 1000), // 60%
    c(4, "A", 400, 1, 800), c(4, "B", 400, 2, 800),   // tie, 0%
  ]);

  it("marginalSeats uses strict < threshold, sorted ascending", () => {
    expect(marginalSeats(seats, 2).map(s => s.acNo)).toEqual([4, 1]);
    expect(marginalSeats(seats, 1).map(s => s.acNo)).toEqual([4]); // 1% is not < 1
    expect(marginalSeats(seats, 0)).toEqual([]);
    expect(marginalSeats(seats, Number.NaN)).toEqual([]);
  });

  it("marginBuckets partitions every seat", () => {
    const b = marginBuckets(seats);
    expect(b).toEqual({ "<2%": 2, "2-5%": 0, "5-10%": 1, ">10%": 1 });
    expect(Object.values(b).reduce((a, x) => a + x, 0)).toBe(seats.length);
  });
});

describe("UT-analytics alliances, split voting, turnout", () => {
  it("aggregates alliance members and leaves others", () => {
    const out = aggregateAlliances({ TDP: 135, JSP: 21, BJP: 8, YSRCP: 11 }, { NDA: ["TDP", "JSP", "BJP"] });
    expect(out).toEqual({ NDA: 164, YSRCP: 11 });
    expect(aggregateAlliances({ X: 1 }, {})).toEqual({ X: 1 });
  });

  it("splitVoting lists seats whose LS-segment winner differs", () => {
    const seats = seatResults([c(1, "A", 60, 1, 100), c(1, "B", 40, 2, 100), c(2, "B", 60, 1, 100), c(2, "A", 40, 2, 100)]);
    const split = splitVoting(seats, { 1: "A", 2: "A" });
    expect(split.map(s => s.acNo)).toEqual([2]);
    expect(splitVoting(seats, {})).toEqual([]);
  });

  it("turnoutPct guards zero electors", () => {
    expect(turnoutPct(50, 100)).toBe(50);
    expect(turnoutPct(10, 0)).toBe(0);
  });
});
