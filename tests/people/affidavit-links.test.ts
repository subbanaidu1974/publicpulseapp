import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { affidavitLinks } from "../../server/people-data";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("@E2E-126 affidavit link-outs", () => {
  it("every candidate gets the same two links, bilingual, flagged external", () => {
    const a = affidavitLinks("Some Name"), b = affidavitLinks("Other Person");
    expect(a.map(l => l.label)).toEqual(b.map(l => l.label));
    expect(a.map(l => l.labelTe)).toEqual(b.map(l => l.labelTe));
    expect(a).toHaveLength(2);
    for (const l of a) { expect(l.label && l.labelTe).toBeTruthy(); expect(l.external).toBe(true); expect(l.url).toMatch(/^https:\/\//); }
    expect(a[0].url).toBe("https://www.myneta.info/search_myneta.php?q=Some%20Name");
    expect(a[1].url).toBe("https://affidavit.eci.gov.in/");
  });
  it("encodes the name and never fetches or embeds affidavit content", () => {
    expect(affidavitLinks("A&B=C/#")[0].url).toContain("A%26B%3DC%2F%23");
    const src = read("server/people-data.ts");
    expect(src).not.toMatch(/fetch\(\s*[`"']https?:\/\/(www\.)?myneta/i);
  });
  it("page shows the external-site note in EN and TE, and the ADR and consent draft exist", () => {
    const text = read("src/components/people/peopleText.ts");
    expect(text.match(/"ppl\.cand\.links\.note"/g)).toHaveLength(2);
    expect(read("src/components/people/pages.tsx")).toContain("affidavit-note");
    expect(read("docs/decisions/02-affidavit-link-outs.md")).toMatch(/written consent/i);
    expect(read("docs/decisions/affidavit-consent-request-draft.md")).toMatch(/NOT SENT/);
  });
});

describe("candidate page party changes", () => {
  it("includes the cited party-changes section with neutral wording", () => {
    expect(read("src/components/people/pages.tsx")).toContain("<PartyChangesSection");
    const t = read("src/components/analytics/analyticsText.ts");
    const pc = t.split("\n").filter(l => l.includes('"an2.pc.'));
    expect(pc.length).toBeGreaterThan(10);
    for (const l of pc) expect(l).not.toMatch(/turncoat|defect|traitor|betray/i);
  });
});
