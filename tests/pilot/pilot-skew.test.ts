/**
 * All data in this file is SYNTHETIC: invented counts that exercise the arithmetic. It says nothing about any real pilot, mandal or person.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AggregateOnlyError, MAX_ROWS, analyse, formatSkew, loadCensusReference, parseCsv, parseJsonInput, validateAggregate, type PilotInput } from "../../scripts/pilot-skew";

const ROOT = path.resolve(__dirname, "..", "..");

/** SYNTHETIC: 2,000 invited; women respond at half the rate of men; one tiny stratum. */
const SYNTHETIC: PilotInput = {
  area: "SYNTHETIC mandal (invented numbers)",
  strata: [
    { dimension: "gender", stratum: "male", invited: 1000, responded: 400 },
    { dimension: "gender", stratum: "female", invited: 1000, responded: 200 },
    { dimension: "age_band", stratum: "18-29", invited: 730, responded: 228 },
    { dimension: "age_band", stratum: "30-49", invited: 800, responded: 240 },
    { dimension: "age_band", stratum: "50-64", invited: 450, responded: 120 },
    { dimension: "age_band", stratum: "65+", invited: 20, responded: 12 },
    { dimension: "phone_ownership", stratum: "own phone", invited: 1500, responded: 540 },
    { dimension: "phone_ownership", stratum: "shared phone", invited: 500, responded: 60 },
    { dimension: "shared_sim", stratum: "single adult SIM", invited: 1200, responded: 450 },
    { dimension: "shared_sim", stratum: "shared SIM", invited: 800, responded: 150 },
  ],
};

describe("pilot skew on SYNTHETIC aggregate data (@E2E-168)", () => {
  it("@E2E-168 computes response rates and skew ratios against the overall rate", () => {
    const r = analyse(SYNTHETIC);
    const g = r.dimensions.find((d) => d.dimension === "gender")!;
    expect(g.overallRate).toBeCloseTo(0.3, 4);
    const male = g.strata.find((s) => s.stratum === "male")!, female = g.strata.find((s) => s.stratum === "female")!;
    expect(male.rate).toBeCloseTo(0.4, 4);
    expect(female.rate).toBeCloseTo(0.2, 4);
    expect(male.skewRatio).toBeCloseTo(1.3333, 3);
    expect(female.skewRatio).toBeCloseTo(0.6667, 3);
    expect(female.flags).toContain("under_responding");
    expect(male.flags).toContain("over_responding");
    expect(g.disparity).toBeCloseTo(2, 4);
  });

  it("@E2E-168 flags strata below the minimum cell size and keeps them out of the disparity", () => {
    const r = analyse(SYNTHETIC);
    const age = r.dimensions.find((d) => d.dimension === "age_band")!;
    const old = age.strata.find((s) => s.stratum === "65+")!;
    expect(old.belowMinCell).toBe(true);
    expect(old.flags.some((f) => f.startsWith("below_min_cell"))).toBe(true);
    expect(old.flags).not.toContain("over_responding"); // a tiny cell is never reported as a finding
    expect(age.disparity).toBeLessThan(1.5); // 65+ (60 percent rate) is excluded
    expect(r.flaggedStrata.some((f) => f.startsWith("age_band/65+"))).toBe(true);
    const strict = analyse(SYNTHETIC, { minCell: 150 });
    expect(strict.dimensions.find((d) => d.dimension === "gender")!.strata.every((s) => !s.belowMinCell)).toBe(true);
    expect(strict.dimensions.find((d) => d.dimension === "age_band")!.strata.filter((s) => s.belowMinCell).length).toBe(2);
  });

  it("@E2E-168 representativeness index: 1 for a perfect match, lower as respondents drift from the reference", () => {
    const even: PilotInput = { strata: [
      { dimension: "gender", stratum: "male", invited: 100, responded: 50, reference_share: 0.5 },
      { dimension: "gender", stratum: "female", invited: 100, responded: 50, reference_share: 0.5 },
    ] };
    expect(analyse(even).dimensions[0].index).toBe(1);
    const skewed = analyse({ strata: [
      { dimension: "gender", stratum: "male", invited: 100, responded: 80, reference_share: 0.5 },
      { dimension: "gender", stratum: "female", invited: 100, responded: 20, reference_share: 0.5 },
    ] });
    expect(skewed.dimensions[0].index).toBeCloseTo(0.7, 4); // 1 - 0.5 * (|0.8-0.5| + |0.2-0.5|)
    expect(skewed.dimensions[0].flags.some((f) => f.startsWith("low_representativeness"))).toBe(true);
    expect(skewed.dimensions[0].invitedIndex).toBe(1);
  });

  it("@E2E-168 the index is marked unreliable when a referenced cell is under the minimum", () => {
    const r = analyse({ strata: [
      { dimension: "age_band", stratum: "young", invited: 500, responded: 200, reference_share: 0.6 },
      { dimension: "age_band", stratum: "old", invited: 20, responded: 5, reference_share: 0.4 },
    ] });
    expect(r.dimensions[0].indexReliable).toBe(false);
    expect(r.dimensions[0].flags).toContain("index_unreliable_small_cells");
    expect(formatSkew(r)).toContain("UNRELIABLE");
  });

  it("@E2E-168 dimensions with no reference get skew but no index, and say so", () => {
    const r = analyse(SYNTHETIC);
    for (const d of r.dimensions) { expect(d.index).toBeNull(); expect(d.flags).toContain("no_reference"); }
    expect(r.caveats.join(" ")).toMatch(/Electoral-roll marginals are not available/);
    expect(r.caveats.join(" ")).toMatch(/signal, not a representative sample/);
  });

  it("@E2E-168 reference shares can be supplied in the input and are renormalised with a warning", () => {
    const r = analyse({ ...SYNTHETIC, reference_shares: { age_band: { "18-29": 0.3, "30-49": 0.3, "50-64": 0.2, "65+": 0.1 } } });
    const age = r.dimensions.find((d) => d.dimension === "age_band")!;
    expect(age.index).not.toBeNull();
    expect(age.referenceSource).toMatch(/cite the source/);
    expect(r.warnings.join(" ")).toMatch(/sum to 0\.9/);
  });

  it("@E2E-168 warns when invited totals differ across dimensions", () => {
    const r = analyse({ strata: [
      { dimension: "gender", stratum: "male", invited: 100, responded: 30 }, { dimension: "gender", stratum: "female", invited: 100, responded: 30 },
      { dimension: "shared_sim", stratum: "shared SIM", invited: 90, responded: 30 }, { dimension: "shared_sim", stratum: "single", invited: 90, responded: 30 },
    ] });
    expect(r.warnings.join(" ")).toMatch(/invited totals differ/);
  });

  it("@E2E-168 handles a zero-invited stratum without dividing by zero", () => {
    const r = analyse({ strata: [{ dimension: "gender", stratum: "male", invited: 0, responded: 0 }, { dimension: "gender", stratum: "female", invited: 100, responded: 40 }] });
    const m = r.dimensions[0].strata[0];
    expect(m.rate).toBeNull(); expect(m.skewRatio).toBeNull(); expect(m.belowMinCell).toBe(true);
  });
});

describe("Census 2011 reference (sex only) (@E2E-168)", () => {
  it("@E2E-168 loads a real mandal sex share from data/generated and sums several", () => {
    const one = loadCensusReference(ROOT, "subdistrict=Adilabad/Tamsi");
    expect(one.population).toBe(39631);
    expect(one.shares.male).toBeCloseTo(19615 / 39631, 6);
    expect(one.shares.male + one.shares.female).toBeCloseTo(1, 9);
    const two = loadCensusReference(ROOT, "subdistrict=Adilabad/Tamsi,Adilabad/ADILABAD MANDAL");
    expect(two.population).toBe(39631 + 198338);
    expect(one.source).toMatch(/Census of India 2011/);
  });

  it("@E2E-168 loads a district by name or code and refuses unknown or malformed specs", () => {
    const d = loadCensusReference(ROOT, "district=Srikakulam");
    expect(d.population).toBe(2703114);
    expect(loadCensusReference(ROOT, "district=542").population).toBe(2703114);
    expect(() => loadCensusReference(ROOT, "district=Nowhere")).toThrow(/no census district/);
    expect(() => loadCensusReference(ROOT, "mandal=x")).toThrow(/--census must be/);
    expect(() => loadCensusReference(ROOT, "subdistrict=Adilabad")).toThrow(/use <district>\/<subdistrict>/);
  });

  it("@E2E-168 gender index uses the census shares; other dimensions stay without a census reference", () => {
    const census = loadCensusReference(ROOT, "subdistrict=Adilabad/Tamsi");
    const r = analyse(SYNTHETIC, { census });
    const g = r.dimensions.find((d) => d.dimension === "gender")!;
    expect(g.index).not.toBeNull();
    expect(g.index!).toBeLessThan(1);
    expect(g.referenceSource).toMatch(/census-subdistricts/);
    expect(r.dimensions.find((d) => d.dimension === "age_band")!.index).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/all ages/);
  });
});

describe("aggregate-only guard: individual-level data is refused (@E2E-168)", () => {
  const rejects = (fn: () => unknown, re: RegExp) => {
    try { fn(); } catch (e) { expect(e).toBeInstanceOf(AggregateOnlyError); expect((e as Error).message).toMatch(re); return; }
    throw new Error("expected AggregateOnlyError");
  };

  it("@E2E-168 refuses a CSV with phone, person or name columns", () => {
    rejects(() => parseCsv("phone,gender,responded\n+919999900001,female,1"), /individual-level field/);
    rejects(() => parseCsv("dimension,stratum,invited,responded,person_id\ngender,male,10,5,abc"), /individual-level field/);
    rejects(() => parseCsv("dimension,stratum,invited,responded,voter_name\ngender,male,10,5,abc"), /individual-level field/);
    rejects(() => parseCsv("dimension,stratum,invited,responded,notes\ngender,male,10,5,abc"), /unknown column/);
  });

  it("@E2E-168 refuses JSON strata with extra individual-level fields", () => {
    rejects(() => parseJsonInput(JSON.stringify({ strata: [{ dimension: "gender", stratum: "male", invited: 1, responded: 1, phone: "+919999900001" }] })), /individual-level field/);
    rejects(() => parseJsonInput("{not json"), /not valid JSON/);
  });

  it("@E2E-168 refuses more than the row cap, too many strata in one dimension, and identifier-like labels", () => {
    const many = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `gender,s${i},1,1`).join("\n");
    rejects(() => parseCsv("dimension,stratum,invited,responded\n" + many), /aggregate counts only/);
    const ages = Array.from({ length: 13 }, (_, i) => ({ dimension: "age_band" as const, stratum: "a" + i, invited: 40, responded: 20 }));
    rejects(() => validateAggregate(ages), /individual-level data is refused/);
    rejects(() => validateAggregate([{ dimension: "gender", stratum: "+91 99999 00001", invited: 1, responded: 1 }]), /identifier or phone number/);
    rejects(() => validateAggregate([{ dimension: "gender", stratum: "a@b.in", invited: 1, responded: 1 }]), /identifier or phone number/);
  });

  it("@E2E-168 refuses non-integer or inconsistent counts, duplicate strata and unknown dimensions", () => {
    rejects(() => parseCsv("dimension,stratum,invited,responded\ngender,male,10.5,5"), /non-negative integer/);
    rejects(() => parseCsv("dimension,stratum,invited,responded\ngender,male,10,-1"), /non-negative integer/);
    rejects(() => validateAggregate([{ dimension: "gender", stratum: "male", invited: 5, responded: 9 }]), /responded exceeds invited/);
    rejects(() => validateAggregate([{ dimension: "gender", stratum: "male", invited: 5, responded: 1 }, { dimension: "gender", stratum: "Male", invited: 5, responded: 1 }]), /duplicate/);
    rejects(() => validateAggregate([{ dimension: "caste" as never, stratum: "x", invited: 5, responded: 1 }]), /unknown dimension/);
    rejects(() => validateAggregate([]), /no strata/);
  });
});

describe("pilot-skew CLI (@E2E-168)", () => {
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const run = (args: string[]) => execFileSync(process.execPath, [tsx, "scripts/pilot-skew.ts", ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });

  it("@E2E-168 reads a CSV, prints the report with the caveats, and emits JSON on request", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skew-"));
    try {
      const f = path.join(dir, "synthetic.csv");
      fs.writeFileSync(f, "# SYNTHETIC invented counts\ndimension,stratum,invited,responded\ngender,male,1000,400\ngender,female,1000,200\n");
      const text = run(["--input", f, "--census", "subdistrict=Adilabad/Tamsi"]);
      expect(text).toContain("under_responding");
      expect(text).toContain("signal, not a representative sample");
      const json = JSON.parse(run(["--input", f, "--json"]));
      expect(json.dimensions[0].dimension).toBe("gender");
      expect(json.caveats.length).toBeGreaterThan(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("@E2E-168 exits non-zero and says why on an individual-level file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skew-"));
    try {
      const f = path.join(dir, "bad.csv");
      fs.writeFileSync(f, "phone,gender\n+919999900001,female\n");
      let status: number | undefined, stderr = "";
      try { run(["--input", f]); } catch (e) { status = (e as { status?: number }).status; stderr = String((e as { stderr?: string }).stderr); }
      expect(status).toBe(3);
      expect(stderr).toMatch(/individual-level field/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
