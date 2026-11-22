import { describe, expect, it } from "vitest";
import { seatResults, type CandidateResult } from "../../src/lib/elections";

const row = (o: Partial<CandidateResult>): CandidateResult => ({ state: "AP", year: 2024, type: "assembly", acNo: 1, acName: "A", candidate: "c", party: "P", votes: 10, position: 1, validVotes: 20, ...o });

describe("@E2E-102 SeatResult district / electors / acNameTe", () => {
  const rows = [row({ candidate: "w", votes: 12 }), row({ candidate: "r", party: "Q", votes: 8, position: 2, electors: 40 }), row({ acNo: 2, acName: "B", candidate: "x", electors: 50, votes: 20, validVotes: 20 })];
  it("adds electors from any candidate row and leaves other fields untouched", () => {
    const s = seatResults(rows);
    expect(s[0]).toMatchObject({ acNo: 1, winner: "w", winnerParty: "P", runnerUpParty: "Q", margin: 4, electors: 40 });
    expect(s[0]).not.toHaveProperty("district");
    expect(s[0]).not.toHaveProperty("acNameTe");
    expect(s[1]).toMatchObject({ uncontested: true, electors: 50 });
  });
  it("adds district and Telugu name from the geo function, and omits missing values", () => {
    const s = seatResults(rows, n => (n === 1 ? { district: "Guntur", acNameTe: "గుంటూరు" } : undefined));
    expect(s[0]).toMatchObject({ district: "Guntur", acNameTe: "గుంటూరు" });
    expect(s[1]).not.toHaveProperty("district");
    expect(seatResults(rows, () => ({ district: "D" }))[0]).not.toHaveProperty("acNameTe");
  });
  it("no electors in the data means no electors field", () => {
    expect(seatResults([row({})])[0]).not.toHaveProperty("electors");
  });
});
