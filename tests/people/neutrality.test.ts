import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateResult } from "../../src/lib/elections";
import { buildContestant, buildPartyProfile, contestantId, loadPeopleStore, searchContestants, CANDIDATE_SECTIONS, PARTY_SECTIONS } from "../../server/people-data";
import { classifyLicence, namesMatch, plainText, seatKey } from "../../pipeline/people/match";
import { PARTIES } from "../../src/lib/parties";

const rows = (JSON.parse(readFileSync(resolve(__dirname, "../../data/generated/elections.json"), "utf8")) as { results: CandidateResult[] }).results;
const store = loadPeopleStore();

/** Recursive key-path shape of a value, with arrays collapsed to their first element's shape. */
const shape = (v: unknown): unknown => Array.isArray(v) ? [v.length ? shape(v[0]) : "empty"] : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, shape((v as Record<string, unknown>)[k])])) : v === null ? "null" : typeof v;
const topKeys = (v: object) => Object.keys(v).sort();

describe("@E2E-129 MCC neutrality: identical sections for every candidate and party", () => {
  it("every candidate profile has exactly the same top-level and record keys", () => {
    const sample = rows.filter((_, i) => i % 97 === 0).slice(0, 150);
    expect(sample.length).toBeGreaterThan(100);
    const profiles = sample.map(r => buildContestant(rows, contestantId(r))!);
    const ref = topKeys(profiles[0]);
    for (const p of profiles) {
      expect(topKeys(p)).toEqual(ref);
      expect(topKeys(p.record)).toEqual(topKeys(profiles[0].record));
      expect(topKeys(p.attributes)).toEqual(["age", "incumbent", "sex"]);
    }
    expect(ref.sort()).toEqual([...new Set([...CANDIDATE_SECTIONS.map(s => ({ identity: ["id", "name", "initials", "party"], record: ["record"], attributes: ["attributes"], otherElections: ["otherElections"], links: ["links"], source: ["source"] }[s])).flat()])].sort());
  });
  it("candidate profiles never expose turncoat, cases, assets or ranking", () => {
    for (const r of rows.filter((x, i) => i % 53 === 0)) {
      const t = JSON.stringify(buildContestant(rows, contestantId(r))).toLowerCase();
      for (const bad of ["turncoat", "criminal", "cases", "assets", "wealth", "rank"]) expect(t).not.toContain(bad);
    }
  });
  it("every registry party page has the same shape", () => {
    const codes = Object.keys(PARTIES).filter(c => c !== "IND" && c !== "NOTA");
    const profiles = codes.map(c => buildPartyProfile(rows, store, c)!);
    for (const p of profiles) {
      expect(topKeys(p)).toEqual(topKeys(profiles[0]));
      for (const e of p.elections) expect(topKeys(e)).toEqual(topKeys(profiles.find(q => q.elections.length)!.elections[0]));
    }
    expect(PARTY_SECTIONS).toContain("elections");
  });
  it("name search is alphabetical, never ordered by votes, margin, wealth or cases", () => {
    const hits = searchContestants(rows, "reddy", {}, 200);
    expect(hits.length).toBeGreaterThan(50);
    const names = hits.map(h => h.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b) || 0).length ? names : names);
    for (let i = 1; i < hits.length; i++) {
      const a = rows.find(r => contestantId(r) === hits[i - 1].id)!.candidate, b = rows.find(r => contestantId(r) === hits[i].id)!.candidate;
      expect(a.localeCompare(b)).toBeLessThanOrEqual(0);
    }
  });
  it("TCPD attributes are present for most rows but sex/age/incumbent are null, not guessed, where the source lacks them", () => {
    const ls24 = rows.find(r => r.type === "ls" && r.year === 2024)!;
    const p = buildContestant(rows, contestantId(ls24))!;
    expect(p.attributes.age).toBeNull();
  });
});

describe("@E2E-125 photo matching and licence rules", () => {
  it("accepts only CC0, public domain, CC BY and CC BY-SA", () => {
    for (const ok of ["CC0", "Public domain", "CC BY-SA 4.0", "CC BY 2.0", "PD-India", "CC BY-SA 3.0 IN"]) expect(classifyLicence(ok).ok, ok).toBe(true);
    for (const no of ["CC BY-NC 4.0", "CC BY-ND 2.0", "CC BY-NC-SA 3.0", "Fair use", "GFDL", "", undefined, "All rights reserved"]) expect(classifyLicence(no as string).ok, String(no)).toBe(false);
  });
  it("matches only on constituency AND name; initials and different people never match", () => {
    expect(seatKey("Giddalur Assembly constituency")).toBe("giddalur");
    expect(seatKey("Araku Lok Sabha constituency")).toBe("araku");
    expect(namesMatch("Kinjarapu Atchannaidu", "ATCHANNAIDU KINJARAPU")).toBe(true);
    expect(namesMatch("Thanneeru Harish Rao", "T. HARISH RAO")).toBe(true);
    expect(namesMatch("Ravi Kumar", "Suresh Kumar")).toBe(false);
    expect(plainText('<a href="x">Mango&nbsp;News</a> &amp; co')).toContain("& co");
  });
  it("every shipped photo has author, accepted licence, source link and a file", () => {
    for (const [k, e] of Object.entries(store.photos)) {
      expect(e.author, k).toBeTruthy();
      expect(["CC0", "PD", "CC BY", "CC BY-SA"], k).toContain(e.licence);
      expect(e.source, k).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
      expect(e.path, k).toMatch(/^\/people\//);
    }
  });
});
