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
    const files = fs.readdirSync(dir).filter((f) => f !== "index.json").sort();
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
