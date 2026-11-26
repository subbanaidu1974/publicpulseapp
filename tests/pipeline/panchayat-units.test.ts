import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePanchayatFile } from "../../src/lib/panchayat";
import type { PanchayatFile } from "../../src/lib/panchayat";
import { buildDirectory, joinUnits, norm, rollup, trends } from "../../src/lib/panchayatUnits";
import type { LgdFile } from "../../src/lib/panchayatUnits";

const rd = (p: string) => JSON.parse(readFileSync(resolve(__dirname, "../..", p), "utf8"));
const lgdFile = (): LgdFile => rd("data/generated/geo/lgd-TG.json");
const fixture = (): PanchayatFile => rd("e2e/fixtures/panchayat/units-TG.json");

describe("@E2E-214 panchayat unit matching, roll-ups and trends", () => {
  it("names are compared on letters and digits only, ignoring 'gram panchayat'", () => {
    expect(norm("Tamsi (Gram Panchayat)")).toBe(norm("TAMSI GP"));
    expect(norm("  Adilabad  Urban ")).toBe("adilabadurban");
  });

  it("the sample file passes the format checks and is marked as a fixture", () => {
    const f = fixture();
    expect(f.fixture).toBe(true);
    expect(validatePanchayatFile(f, "TG")).toEqual([]);
    expect(f.source.publisher).toMatch(/SAMPLE/);
    expect(f.elections.every((e) => (e.caveats ?? []).join(" ").match(/Sample data/))).toBe(true);
  });

  it("units match the directory by code or by a unique name, and the leftovers are reported, never guessed", () => {
    const f = fixture(); const dir = buildDirectory(lgdFile());
    const e = f.elections.find((x) => x.id === "fx-gp-2025")!;
    const { units, stats } = joinUnits(e.units!, "gp", dir, e.id);
    expect(stats.total).toBe(14);
    expect(stats.byCode).toBeGreaterThan(0);
    expect(stats.byName).toBeGreaterThan(0);
    expect(stats.unmatched).toBe(1);          // "Sample New Village" has no directory entry
    expect(stats.conflicts).toBe(1);          // a code that belongs to another district
    expect(stats.byCode + stats.byName + stats.unmatched + stats.conflicts).toBe(14);
    expect(stats.unmatchedNames[0]).toMatch(/Sample New Village/);
    const matched = units.filter((u) => u.match === "code" || u.match === "name");
    expect(matched.every((u) => u.matchedLgd && u.lgdDistrict && u.lgdMandal)).toBe(true);
    expect(units.find((u) => u.match === "conflict")!.matchedLgd).toBeNull();
    expect(units.find((u) => u.match === "none")!.matchedLgd).toBeNull();
    expect(matched.some((u) => /[ఀ-౿]/.test(u.nameTe ?? ""))).toBe(true); // Telugu names come from the directory
  });

  it("only gram panchayat elections are matched; a name that is not unique is not matched", () => {
    const f = fixture(); const dir = buildDirectory(lgdFile());
    const e = f.elections[0];
    expect(joinUnits(e.units!, "mptc", dir).stats.byCode + joinUnits(e.units!, "mptc", dir).stats.byName).toBe(0);
    // same name and district but no mandal: matches only when the name is unique in the district
    const u = { name: e.units![0].name, district: e.units![0].district, posts: 8 };
    const r = joinUnits([u], "gp", dir).units[0];
    expect(["name", "none"]).toContain(r.match);
    expect(joinUnits([{ name: "No Such Place", district: "Nowhere", posts: 8 }], "gp", dir).units[0].match).toBe("none");
  });

  it("roll-ups count units, posts and unopposed units by name order, with plain averages and no ranking", () => {
    const f = fixture(); const dir = buildDirectory(lgdFile());
    const e = f.elections[0];
    const { units } = joinUnits(e.units!, "gp", dir, e.id);
    const d = rollup(units, "district");
    expect(d.map((g) => g.name)).toEqual([...d.map((g) => g.name)].sort((a, b) => a.localeCompare(b)));
    expect(d.reduce((n, g) => n + g.units, 0)).toBe(12);
    expect(d.reduce((n, g) => n + g.posts, 0)).toBe(units.reduce((n, u) => n + u.posts, 0));
    const g = d[0];
    expect(g.unopposedPct).toBeCloseTo((g.unopposed / g.units) * 100, 0);
    const m = rollup(units.filter((u) => u.district === d[0].name), "mandal");
    expect(m.reduce((n, x) => n + x.units, 0)).toBe(d[0].units);
  });

  it("trends compare cycles of one level, report shared units and warn when the unit list changed", () => {
    const f = fixture();
    const t = trends(f.elections, "gp");
    expect(t.points.map((p) => p.year)).toEqual([2019, 2025]);
    expect(t.points[0].units).toBe(12);
    expect(t.points[1].units).toBe(14);
    expect(t.sharedUnits).toBe(12);
    expect(t.notes.join(" ")).toMatch(/differs between cycles/);
    expect(t.notes.join(" ")).toMatch(/not weighted/);
    expect(trends(f.elections, "mptc").points).toEqual([]);
    expect(trends([f.elections[0]], "gp").notes.join(" ")).toMatch(/at least two cycles/);
  });
});

describe("@E2E-215 sample data can never ship", () => {
  it("no unit-level file exists in data/reference/panchayat yet, and none that exists is marked as a fixture", () => {
    const dir = resolve(__dirname, "../../data/reference/panchayat");
    expect(existsSync(dir)).toBe(true);
    for (const n of readdirSync(dir)) {
      const j = JSON.parse(readFileSync(resolve(dir, n), "utf8"));
      expect(j.fixture, n).not.toBe(true);
      expect(String(j.source?.publisher ?? ""), n).not.toMatch(/SAMPLE/);
    }
    expect(existsSync(resolve(dir, "units-TG.json"))).toBe(false);
    expect(existsSync(resolve(dir, "units-AP.json"))).toBe(false);
  });
  it("the server refuses a fixture file unless it was started with the test directory", () => {
    const src = readFileSync(resolve(__dirname, "../../server/analytics-api.ts"), "utf8");
    expect(src).toMatch(/f\.fixture === true && !process\.env\.PANCHAYAT_UNITS_DIR/);
    expect(src).toMatch(/sample data is refused outside the test directory/);
  });
  it("the sample files live only under e2e/fixtures and carry invented winners", () => {
    const f = fixture();
    for (const e of f.elections) for (const u of e.units ?? []) expect(u.winner?.name ?? "SAMPLE", u.name).toMatch(/^SAMPLE WINNER/);
  });
});
