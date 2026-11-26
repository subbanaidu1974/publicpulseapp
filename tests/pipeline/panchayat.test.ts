import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { panchayatResponse, validatePanchayatFile } from "../../src/lib/panchayat";

const unitFile = () => ({
  state: "TG",
  source: { publisher: "Test commission", url: "https://example.org/r", licence: "test-licence", terms: "reuse with credit", retrieved: "2026-11-25", quality: "commission" },
  elections: [{ id: "tg-gp-2025", level: "gp", year: 2025, period: "2025-12", phases: [{ date: "2025-12-11" }], units: [{ name: "Unit A", district: "D1", posts: 8, unopposed: true }, { name: "Unit B", district: "D1", posts: 10, turnoutPct: 80.5 }] }],
});
const tallyFile = () => ({
  state: "TG",
  source: { publisher: "Secondary", url: "https://example.org/p", licence: "CC BY-SA 4.0", terms: "credit", retrieved: "2026-11-25", quality: "secondary" },
  elections: [{ id: "x", level: "zptc", year: 2019, period: "2019-05", totalPosts: 100, tallies: [{ party: "A", won: 60 }, { party: "B", won: 30 }],
    evidence: { kind: "wikipedia", url: "https://example.org/p", revision: "1", cites: "a newspaper" }, caveats: ["incomplete"] }],
});
const read = (st: string) => JSON.parse(readFileSync(resolve(__dirname, `../../data/reference/panchayat/results-${st}.json`), "utf8"));

describe("@E2E-212 panchayat data format", () => {
  it("with no file the response says not loaded", () => {
    const r = panchayatResponse("TG", null);
    expect(r.loaded).toBe(false);
    expect(r.granularity).toBe("none");
    expect(r.levels).toEqual(["gp", "mptc", "zptc"]);
  });
  it("a unit-level file and a totals file are both accepted and summarised", () => {
    expect(validatePanchayatFile(unitFile(), "TG")).toEqual([]);
    const u = panchayatResponse("TG", unitFile());
    expect(u.granularity).toBe("units");
    expect(u.elections[0]).toMatchObject({ units: 2, posts: 18 });
    expect(validatePanchayatFile(tallyFile(), "TG")).toEqual([]);
    const t = panchayatResponse("TG", tallyFile());
    expect(t.granularity).toBe("totals");
    expect(t.elections[0]).toMatchObject({ units: null, posts: 100 });
  });
  it("refuses a wrong state, a missing licence or quality, bad values and a file with neither units nor totals", () => {
    expect(validatePanchayatFile(unitFile(), "AP").join()).toMatch(/expected AP/);
    const noLic = unitFile(); noLic.source.licence = "";
    expect(validatePanchayatFile(noLic, "TG").join()).toMatch(/source needs/);
    const noQ = unitFile() as any; delete noQ.source.quality;
    expect(validatePanchayatFile(noQ, "TG").join()).toMatch(/quality/);
    const bad = unitFile(); bad.elections[0].units![0].posts = 0; bad.elections[0].units![1].turnoutPct = 140; bad.elections[0].period = "Dec 2025";
    const p = validatePanchayatFile(bad, "TG").join();
    expect(p).toMatch(/posts/); expect(p).toMatch(/turnoutPct/); expect(p).toMatch(/period/);
    const empty = unitFile() as any; delete empty.elections[0].units;
    expect(validatePanchayatFile(empty, "TG").join()).toMatch(/needs units or tallies/);
    expect(panchayatResponse("TG", bad).loaded).toBe(false);
  });
  it("totals must name where they were read from, state a caveat, and not add up to more than the posts", () => {
    const noEv = tallyFile() as any; delete noEv.elections[0].evidence;
    expect(validatePanchayatFile(noEv, "TG").join()).toMatch(/evidence/);
    const noCav = tallyFile() as any; noCav.elections[0].caveats = [];
    expect(validatePanchayatFile(noCav, "TG").join()).toMatch(/caveat/);
    const over = tallyFile(); over.elections[0].tallies[0].won = 90;
    expect(validatePanchayatFile(over, "TG").join()).toMatch(/more than totalPosts/);
  });
  it("news evidence needs another report it was checked against, and a range cannot run backwards", () => {
    const news = tallyFile() as any;
    news.elections[0].evidence = { kind: "news", url: "https://example.org/a", cites: "paper A" };
    expect(validatePanchayatFile(news, "TG").join()).toMatch(/at least one other report/);
    news.elections[0].evidence.also = [{ publisher: "B", url: "https://example.org/b", date: "2026-11-09" }];
    expect(validatePanchayatFile(news, "TG")).toEqual([]);
    news.elections[0].tallies[0].wonMax = 70;
    expect(validatePanchayatFile(news, "TG")).toEqual([]);
    news.elections[0].tallies[0].wonMax = 50;
    expect(validatePanchayatFile(news, "TG").join()).toMatch(/wonMax/);
    const noRev = tallyFile() as any; delete noRev.elections[0].evidence.revision;
    expect(validatePanchayatFile(noRev, "TG").join()).toMatch(/revision/);
  });
  it("refuses any voter-level or personal field", () => {
    for (const key of ["voterId", "epic_no", "electors", "rollNo", "mobile", "address"]) {
      const f = unitFile() as any; f.elections[0].units[0][key] = "x";
      expect(validatePanchayatFile(f, "TG").join(), key).toMatch(/not accepted/);
    }
  });
});

describe("@E2E-213 the committed panchayat totals", () => {
  it("both files pass the checks, are marked secondary, and carry no unit-level or personal data", () => {
    for (const st of ["AP", "TG"] as const) {
      const f = read(st);
      expect(validatePanchayatFile(f, st), st).toEqual([]);
      expect(f.source.quality).toBe("secondary");
      expect(f.source.licence).toBe("CC BY-SA 4.0");
      expect(f.otherSources[0].quality).toBe("secondary");
      for (const e of f.elections) {
        expect(e.units, e.id).toBeUndefined();
        if (e.evidence.kind === "wikipedia") {
          expect(e.evidence.revision, e.id).toMatch(/^\d+$/);
          expect(e.evidence.url, e.id).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
        } else {
          expect(e.evidence.kind, e.id).toBe("news");
          expect(e.evidence.also.length, e.id).toBeGreaterThanOrEqual(1); // the primary report plus at least one other: two outlets in all
          expect(e.year, e.id).toBeGreaterThanOrEqual(2025);
          expect(e.caveats.length, e.id).toBeGreaterThan(0);
        }
      }
    }
  });
  it("figures match what the cited pages show, and the rounds we could not read are not invented", () => {
    const tg = read("TG").elections as { id: string; level: string; tallies: { party: string; won: number }[]; totalPosts?: number; caveats: string[]; year: number }[];
    const byId = (id: string) => tg.find((e) => e.id === id)!;
    expect(byId("tg-gp-2019").tallies.find((t) => t.party === "BRS")!.won).toBe(7774);
    expect(byId("tg-zptc-2019").totalPosts).toBe(538);
    expect(byId("tg-mptc-2014").totalPosts).toBe(6497); // the source's rows add to 6,487; stated in the caveats
    expect(byId("tg-mptc-2014").caveats.join(" ")).toMatch(/6,487/);
    const ap = read("AP").elections as { id: string; level: string; year: number; tallies: { party: string; won: number; byPhase?: number[] }[] }[];
    const gp21 = ap.find((e) => e.id === "ap-gp-2021")!;
    const y = gp21.tallies.find((t) => t.party === "YSRCP")!;
    expect(y.byPhase!.reduce((n, x) => n + x, 0)).toBe(y.won);
    // newest rounds come from news reports and are labelled so; disagreements are shown as ranges, never averaged
    const g25 = byId("tg-gp-2025") as any;
    expect(g25.evidence.kind).toBe("news");
    const inc = g25.tallies.find((t: any) => t.party === "INC");
    expect(inc.won).toBe(6794); expect(inc.wonMax).toBe(7010);
    expect(g25.caveats.join(" ")).toMatch(/No final count/);
    const apz = ap.find((e) => e.id === "ap-zptc-2026") as any;
    expect(apz.tallies.reduce((n: number, t: any) => n + t.won, 0)).toBe(582); // the contested seats; the 77 unopposed are stated separately
    expect(apz.unopposed).toBe(77);
    const apm = ap.find((e) => e.id === "ap-mptc-2026") as any;
    expect(apm.totalPosts).toBeUndefined(); // the reports disagree (9,818 against 9,821)
    expect(apm.tallies.some((t: any) => t.party === "INC")).toBe(false); // the reports disagree (0, 9, 2)
    // not loaded: AP 2021 parishad, any Telangana parishad after 2019, anything before 2014, any unit-level rows
    expect(ap.some((e) => e.year === 2021 && e.level !== "gp")).toBe(false);
    expect(tg.some((e) => e.year > 2019 && e.level !== "gp")).toBe(false);
    expect([...tg, ...ap].every((e) => e.year >= 2014)).toBe(true);
  });
});
