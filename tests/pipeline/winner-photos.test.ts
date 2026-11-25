import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// S-198: every winner photo on the site is a file we hold, with a credit and a free licence, and matches a curated list entry.
const dir = path.join("data", "generated", "photos");
const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")).photos as { state: string; year: number; acNo: number; file: string; author: string | null; licence: string; source: string }[];
const curated = JSON.parse(fs.readFileSync(path.join("data", "reference", "winner-photos.json"), "utf8")) as { state: string; year: number; acNo: number }[];

describe("winner photos (S-198)", () => {
  it("has photos and no extra files", () => {
    expect(index.length).toBeGreaterThan(20);
    const files = fs.readdirSync(dir).filter((f) => f !== "index.json" && f !== "leaders.json" && !f.startsWith("leader-")).sort();
    expect(files).toEqual(index.map((p) => p.file).sort());
  });
  it("each photo is a real image file, named by seat, with a free licence and a Commons source page", () => {
    for (const p of index) {
      expect(p.file).toBe(`${p.state}-${p.year}-${p.acNo}${path.extname(p.file)}`);
      expect(fs.statSync(path.join(dir, p.file)).size).toBeGreaterThan(2000);
      expect(p.licence).toMatch(/^(CC0|Public domain|CC BY(-SA)? [0-9.]+|GODL-India)$/i);
      expect(p.source).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
    }
  });
  it("every photo comes from the hand-checked list and one seat has one photo", () => {
    const key = (p: { state: string; year: number; acNo: number }) => `${p.state}-${p.year}-${p.acNo}`;
    const listed = new Set(curated.map(key));
    for (const p of index) expect(listed.has(key(p))).toBe(true);
    expect(new Set(index.map(key)).size).toBe(index.length);
  });
});

// S-199: party-head photos follow the same rules, and every party named must exist in the party registry
describe("party leader photos (S-199)", () => {
  const leaders = JSON.parse(fs.readFileSync(path.join(dir, "leaders.json"), "utf8")).photos as { party: string; name: string; role: string; file: string; licence: string; source: string }[];
  const registry = (JSON.parse(fs.readFileSync(path.join("data", "reference", "parties.json"), "utf8")).parties as { code: string }[]).map((p) => p.code);
  it("holds each file with a free licence, a credit page and a known party, one per party", () => {
    expect(leaders.length).toBeGreaterThan(5);
    for (const l of leaders) {
      expect(registry).toContain(l.party);
      expect(l.file).toBe(`leader-${l.party}${path.extname(l.file)}`);
      expect(fs.statSync(path.join(dir, l.file)).size).toBeGreaterThan(2000);
      expect(l.licence).toMatch(/^(CC0|Public domain|CC BY(-SA)? [0-9.]+|GODL-India)$/i);
      expect(l.source).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
      expect(l.role.length).toBeGreaterThan(2);
    }
    expect(new Set(leaders.map((l) => l.party)).size).toBe(leaders.length);
  });
  it("leaves no stray files in the photos folder", () => {
    const known = new Set([...index.map((p) => p.file), ...leaders.map((l) => l.file), "index.json", "leaders.json"]);
    expect(fs.readdirSync(dir).filter((f) => !known.has(f))).toEqual([]);
  });
});
