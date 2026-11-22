import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { computeForecast, normCdf, winProb, classify, mulberry32, blackoutResponse } from "../../src/lib/forecast";
import type { CandidateResult } from "../../src/lib/elections";

const file = path.join(process.cwd(), "data", "generated", "elections.json");
const real: CandidateResult[] = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).results ?? []) : [];

function el(year: number, type: "assembly" | "ls", seats: [string, number, string, number][]): CandidateResult[] {
  return seats.flatMap(([wp, wv, rp, rv], i) => {
    const b = { state: "AP" as const, year, type, acNo: i + 1, acName: `AC${i + 1}`, validVotes: wv + rv, provenance: "demo" as const };
    return [{ ...b, candidate: "a", party: wp, votes: wv, position: 1 }, { ...b, candidate: "b", party: rp, votes: rv, position: 2 }];
  });
}
const toy = [
  ...el(2014, "assembly", [["TDP", 600, "YSRCP", 400], ["YSRCP", 550, "TDP", 450], ["TDP", 505, "YSRCP", 495]]),
  ...el(2019, "assembly", [["YSRCP", 600, "TDP", 400], ["YSRCP", 550, "TDP", 450], ["TDP", 505, "YSRCP", 495]]),
];

describe("forecast math", () => {
  it("normCdf sane", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it("winProb in [0,1] and monotone; classes by threshold", () => {
    expect(winProb(0, 5, 3)).toBeCloseTo(0.5, 6);
    expect(winProb(50, 5, 3)).toBeLessThanOrEqual(1);
    expect(winProb(5, 5, 3)).toBeLessThan(winProb(10, 5, 3));
    expect(classify(0.96)).toBe("safe");
    expect(classify(0.8)).toBe("lean");
    expect(classify(0.6)).toBe("toss-up");
  });
  it("rng deterministic", () => { expect(mulberry32(1)()).toBe(mulberry32(1)()); });
});

describe("computeForecast", () => {
  it("returns null with no data", () => { expect(computeForecast([], "AP")).toBeNull(); });
  it("handles tiny data (fallback noise) deterministically", () => {
    const a = computeForecast(toy, "AP")!, b = computeForecast(toy, "AP")!;
    expect(a).toEqual(b);
    expect(a.parameters!.uncertaintySource).toBe("fallback-prior");
    expect(a.seats!.length).toBe(3);
    for (const s of a.seats!) { expect(s.winProbLeader).toBeGreaterThanOrEqual(0); expect(s.winProbLeader).toBeLessThanOrEqual(1); }
  });
  it("handles uncontested seats", () => {
    const rows = [...toy, { state: "AP" as const, year: 2019, type: "assembly" as const, acNo: 4, acName: "U", candidate: "x", party: "YSRCP", votes: 100, position: 1, validVotes: 100 }];
    const f = computeForecast(rows, "AP")!;
    expect(f.seats!.find(s => s.acNo === 4)!.leader).toBe("YSRCP");
  });
  it("blackout response has no seats/alliances", () => {
    const b = blackoutResponse("AP");
    expect(b.blackout).toBe(true);
    expect(b.seats).toBeUndefined();
    expect(b.alliances).toBeUndefined();
  });
  const live = real.length ? describe : describe.skip;
  live("real AP/TG data", () => {
    for (const st of ["AP", "TG"] as const) {
      it(`${st}: sorted seats, valid probs, back-test present, deterministic`, () => {
        const f = computeForecast(real, st)!;
        expect(f.disclaimer).toMatch(/Not a poll/);
        expect(f.method).toBe("uniform-swing-damped-v1");
        const nos = f.seats!.map(s => s.acNo);
        expect(nos).toEqual([...nos].sort((a, b) => a - b));
        for (const s of f.seats!) { expect(s.winProbLeader).toBeGreaterThanOrEqual(0); expect(s.winProbLeader).toBeLessThanOrEqual(1); }
        for (const a of f.alliances!) { expect(a.majorityProb).toBeGreaterThanOrEqual(0); expect(a.majorityProb).toBeLessThanOrEqual(1); expect(a.seatsP10).toBeLessThanOrEqual(a.seatsP90); }
        expect(f.alliances!.reduce((s, a) => s + a.seatsMedian, 0)).toBeGreaterThan(0);
        expect(f.backtest!.runs.length).toBeGreaterThan(0);
        expect(computeForecast(real, st)).toEqual(f);
      });
    }
    it("print summary", () => {
      for (const st of ["AP", "TG"] as const) {
        const f = computeForecast(real, st)!;
        console.log(st, JSON.stringify({ basedOn: f.basedOn, p: f.parameters, alliances: f.alliances, classes: f.seats!.reduce((m: any, s) => (m[s.class] = (m[s.class] ?? 0) + 1, m), {}) }));
        for (const r of f.backtest!.runs) console.log(st, JSON.stringify(r));
      }
    });
  });
});
