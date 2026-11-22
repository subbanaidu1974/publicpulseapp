/** S-29 (@E2E-38) geography helpers behind eligibility and the mandal stratum check. */
import { beforeEach, describe, expect, it } from "vitest";
import { mandalInScope, mandalOfResidence, qualityOfClass, stateCodeOfUnit, tierOfClass, villageInScope } from "../../../server/civic/surveys/eligibility";
import { freshWorld } from "./helpers";

beforeEach(() => freshWorld());
const scope = (state: string, units = {}) => ({ state, units });

describe("scope geography", () => {
  it("@E2E-38 state of a unit comes from its ancestors; unknown units have none", () => {
    expect(stateCodeOfUnit("DEMO-V-KLR")).toBe("AP");
    expect(stateCodeOfUnit("DEMO-V-HNK")).toBe("TG");
    expect(stateCodeOfUnit("nope")).toBeNull();
  });
  it("@E2E-38 a village is in scope by state, district, mandal, village or constituency; unknown villages never are", () => {
    expect(villageInScope("DEMO-V-KLR", scope("AP"))).toBe(true);
    expect(villageInScope("DEMO-V-KLR", scope("TG"))).toBe(false);
    expect(villageInScope("DEMO-V-KLR", scope("AP", { district: ["D-GNT"] }))).toBe(true); // the namespaced tail matches
    expect(villageInScope("DEMO-V-KLR", scope("AP", { ac_no: ["999"] }))).toBe(false);
    expect(villageInScope("nope", scope("AP"))).toBe(false);
  });
  it("@E2E-38 a mandal is in scope when it, its district, or one of its villages is", () => {
    expect(mandalInScope("DEMO-M-KLP", scope("AP"))).toBe(true);
    expect(mandalInScope("DEMO-M-KLP", scope("TG"))).toBe(false);
    expect(mandalInScope("DEMO-M-KLP", scope("AP", { district: ["DEMO-D-GNT"] }))).toBe(true);
    expect(mandalInScope("DEMO-M-KLP", scope("AP", { village: ["DEMO-V-BPL"] }))).toBe(true);
    expect(mandalInScope("DEMO-M-KLP", scope("AP", { constituency: ["DEMO-C-TNL"] }))).toBe(true);
    expect(mandalInScope("DEMO-M-KLP", scope("AP", { constituency: ["DEMO-C-WGE"] }))).toBe(false);
    expect(mandalInScope("DEMO-D-GNT", scope("AP"))).toBe(false); // not a mandal
    expect(mandalInScope("zzz", scope("AP"))).toBe(false);
    expect(mandalOfResidence("DEMO-V-KLR")).toBe("DEMO-M-KLP");
    expect(mandalOfResidence(null)).toBeNull();
  });
  it("@E2E-38 key classes split into tier and quality", () => {
    expect([tierOfClass("T2_LOW"), qualityOfClass("T2_LOW"), tierOfClass("T1"), qualityOfClass("T1")]).toEqual(["T2", "low", "T1", "normal"]);
  });
});
