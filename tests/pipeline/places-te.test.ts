import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { minPopulationAt } from "../../src/components/maps/placeZoom";

// S-192: Telugu town names for the map background come from a committed Wikidata (CC0) extract. These checks guard its shape.
const load = (st: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "generated", "geo", `places-${st}.json`), "utf8"));
const TELUGU = /[\u0C00-\u0C7F]/;

describe("Telugu town names for the map (S-192)", () => {
  for (const st of ["AP", "TG"]) {
    it(`${st}: every row has a Telugu name, English name, coordinates inside the two states and a population`, () => {
      const d = load(st);
      expect(d.licence).toBe("CC0-1.0");
      expect(d.places.length).toBeGreaterThan(40);
      const seen = new Set<string>();
      for (const [en, te, lon, lat, pop] of d.places as [string, string, number, number, number][]) {
        expect(TELUGU.test(te), `${en} has no Telugu text`).toBe(true);
        expect(en.length).toBeGreaterThan(1);
        expect(lon).toBeGreaterThan(76); expect(lon).toBeLessThan(85);
        expect(lat).toBeGreaterThan(12.5); expect(lat).toBeLessThan(20);
        expect(pop).toBeGreaterThanOrEqual(30000);
        expect(seen.has(te), `duplicate ${te}`).toBe(false); seen.add(te);
        expect(/district|mandal|constituency|జిల్లా|మండలం/i.test(en + te), `${en} is not a town`).toBe(false);
      }
      const pops = d.places.map((p: unknown[]) => p[4] as number);
      expect([...pops].sort((a, b) => b - a)).toEqual(pops); // biggest first
    });
  }
  it("the biggest cities are present with their Telugu names", () => {
    const names = new Map<string, string>([...load("AP").places, ...load("TG").places].map((p: string[]) => [p[0], p[1]]));
    expect(names.get("Hyderabad")).toBe("హైదరాబాద్");
    expect(names.get("Visakhapatnam")).toBe("విశాఖపట్నం");
    expect(names.get("Vijayawada")).toBe("విజయవాడ");
  });
  it("fewer towns are labelled when zoomed out, all of them when zoomed in", () => {
    const z = [5, 7, 8, 9, 10].map(minPopulationAt);
    expect([...z].sort((a, b) => b - a)).toEqual(z);
    expect(z[0]).toBeGreaterThan(z[4]);
    expect(z[4]).toBe(0);
  });
});
