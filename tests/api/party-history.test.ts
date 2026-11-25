import { describe, expect, it } from "vitest";
import type { CandidateResult } from "../../src/lib/elections";
import { MIN_SHARE_PCT, partyHistory } from "../../src/lib/partyHistory";

// S-195: party-by-party results across elections, from results already held.
const row = (year: number, acNo: number, party: string, votes: number, position: number, type: "assembly" | "ls" = "assembly"): CandidateResult =>
  ({ state: "TG", year, type, acNo, acName: `AC${acNo}`, candidate: `${party}${acNo}`, party, votes, position, validVotes: 1000 });

describe("party history (S-195)", () => {
  const rows = [
    row(2018, 1, "TRS", 500, 1), row(2018, 1, "INC", 300, 2), row(2018, 1, "NOTA", 10, 4), row(2018, 1, "XYZ", 5, 3),
    row(2018, 2, "INC", 600, 1), row(2018, 2, "TRS", 200, 2),
    row(2023, 1, "BRS", 450, 1), row(2023, 1, "INC", 400, 2),
    row(2023, 2, "INC", 700, 1), row(2023, 2, "BJP", 100, 2),
  ];
  const h = partyHistory(rows, "TG");

  it("merges renamed labels through the registry (TRS and BRS are one party) and counts seats, votes and contested", () => {
    const brs = h.parties.find(p => p.code === "BRS")!;
    expect(brs).toBeTruthy();
    expect(h.parties.find(p => p.code === "TRS")).toBeUndefined();
    const r2018 = brs.rows.find(r => r.year === 2018)!;
    expect(r2018).toMatchObject({ seats: 1, contested: 2, votes: 700 });
    expect(brs.totalSeats).toBe(2); // seat 1 in 2018 (as TRS) and seat 1 in 2023
  });

  it("share is of all votes polled including NOTA, and a party that did not stand has no row (not a zero)", () => {
    const inc = h.parties.find(p => p.code === "INC")!;
    expect(inc.rows.map(r => r.year)).toEqual([2018, 2023]);
    const bjp = h.parties.find(p => p.code === "BJP");
    expect(bjp?.rows.map(r => r.year)).toEqual([2023]); // BJP stood only in 2023
    const e2018 = h.elections.find(e => e.year === 2018)!;
    expect(e2018.totalVotes).toBe(500 + 300 + 10 + 5 + 600 + 200);
    expect(inc.rows[0].sharePct).toBeCloseTo(((300 + 600) / e2018.totalVotes) * 100, 1);
  });

  it("NOTA is never listed as a party, and labels with no seat and under the share floor are counted as omitted", () => {
    expect(h.parties.find(p => p.code === "NOTA")).toBeUndefined();
    expect(h.parties.find(p => p.code === "XYZ")).toBeUndefined();
    expect(h.omitted).toBeGreaterThanOrEqual(1);
    expect(MIN_SHARE_PCT).toBe(1);
  });

  it("parties are ordered by total seats and registry facts are attached only for registered parties", () => {
    const seats = h.parties.map(p => p.totalSeats);
    expect([...seats].sort((a, b) => b - a)).toEqual(seats);
    const inc = h.parties.find(p => p.code === "INC")!;
    expect(inc.registered).toBe(true);
    expect(inc.name.en.length).toBeGreaterThan(3);
  });

  it("other states' rows are ignored", () => {
    expect(partyHistory([{ ...row(2018, 1, "INC", 5, 1), state: "AP" }], "TG").parties).toEqual([]);
  });
});
