import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normAcName, parseElectorsText, validateElectors } from "../../pipeline/electors";

const SAMPLE = [
  "State: Andhra Pradesh", "PC:- Araku",
  "Palakonda 94966 100036 15 195017 3 0 0 3 632 21 653 195673 146583",
  "Gannavaram(SC) 99921 98648 6 198575 22 5 0 27 131 6 137 198739 150000",
  "PC:- Araku 753690 800809 111 1554610 19 4 0 23 2379 141 2520 1557153 1143013",
  "Andhra Pradesh 20267896 21054460 3419 41325775 6248 1677 2 7927 65707 2478 68185 41401887 33258505",
  "State: Assam", "Foo 1 1 1 3 1 1 1 3 1 1 2 8 5",
].join("\n");

describe("@E2E-101 electors by AC (ECI GE-2024 table 15 parser)", () => {
  it("parses AC rows, skips PC subtotals, state totals and other states", () => {
    const rows = parseElectorsText(SAMPLE);
    expect(rows.map(r => r.acName)).toEqual(["Palakonda", "Gannavaram(SC)"]);
    expect(rows[0]).toMatchObject({ state: "AP", pcName: "Araku", generalFemale: 100036, generalThirdGender: 15, totalElectors: 195673, votesPolledEvm: 146583 });
    expect(validateElectors(rows)).toEqual([]);
  });
  it("flags rows whose parts do not add up", () => {
    const [r] = parseElectorsText(SAMPLE);
    expect(validateElectors([{ ...r, generalTotal: r.generalTotal + 1 }]).length).toBeGreaterThan(0);
  });
  it("keeps reservation tags distinct and applies the reviewed spelling aliases", () => {
    expect(normAcName("Gannavaram(SC)")).not.toBe(normAcName("Gannavaram"));
    expect(normAcName("Zaheerabad")).toBe(normAcName("ZAHIRABAD"));
  });
  it("committed electors-ac.json covers every AC with ECI printed state totals", () => {
    const f = JSON.parse(readFileSync(resolve(__dirname, "../../data/generated/electors-ac.json"), "utf8")) as { rows: { state: string; acNo: number; totalElectors: number }[]; provenance: string };
    expect(f.provenance).toBe("eci-ge2024-statistical-report");
    expect(f.rows.filter(r => r.state === "AP")).toHaveLength(175);
    expect(f.rows.filter(r => r.state === "TG")).toHaveLength(119);
    const sum = (s: string) => f.rows.filter(r => r.state === s).reduce((a, r) => a + r.totalElectors, 0);
    expect(sum("AP")).toBe(41401887);
    expect(sum("TG")).toBe(33232318);
  });
});
