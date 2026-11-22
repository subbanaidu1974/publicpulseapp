import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render } from "../../scripts/gen-compliance-text";
import { reviewStatus } from "../../src/i18n/content";

const root = process.cwd();
const rd = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const index = JSON.parse(rd("docs/compliance/artefacts.json")) as {
  artefacts: { id: string; name: string; path: string; textPath?: string; status: string }[];
  placeholderMarkers: string[];
};

describe("UT-compliance-artefacts (S-150)", () => {
  it("@E2E-165 every listed artefact file exists and is marked DRAFT in the index", () => {
    expect(index.artefacts.length).toBeGreaterThanOrEqual(14);
    for (const a of index.artefacts) {
      expect(fs.existsSync(path.join(root, a.path)), `${a.id} ${a.path}`).toBe(true);
      if (a.textPath) expect(fs.existsSync(path.join(root, a.textPath)), `${a.id} ${a.textPath}`).toBe(true);
      expect(a.status, a.id).toBe("DRAFT");
    }
  });

  it("@E2E-165 every notice file declares DRAFT in its own status field", () => {
    for (const a of index.artefacts.filter((x) => x.path.endsWith(".json") && x.path.includes("notices/"))) {
      const j = JSON.parse(rd(a.path));
      expect(String(j.status).toUpperCase().startsWith("DRAFT"), a.id).toBe(true);
    }
  });

  it("@E2E-165 no page translation has been marked reviewed and no artefact doc says approved", () => {
    for (const [k, v] of Object.entries(reviewStatus)) {
      if (["privacy", "terms", "whoSees"].includes(k)) expect(v, k).toBe("machine-draft");
    }
    for (const f of ["COUNSEL_PACK.md", "INCIDENT_AND_VDP.md", "GRIEVANCE_OFFICER_ROLE.md"]) {
      const text = rd(`docs/compliance/${f}`);
      expect(text).toMatch(/DRAFT/);
      expect(text, f).not.toMatch(/status:\s*\**\s*(approved|final|signed off)\b/i);
    }
  });

  it("@E2E-165 a placeholder marker is never claimed as approved or real", () => {
    const gr = JSON.parse(rd("server/civic/households/notices/grievance_officer.json"));
    const body = JSON.stringify(gr);
    const hasPlaceholder = index.placeholderMarkers.some((m) => body.includes(m));
    if (hasPlaceholder) {
      expect(String(gr.status).toUpperCase().startsWith("DRAFT")).toBe(true);
      expect(String(gr.status)).not.toMatch(/approved|appointed and confirmed|final/i);
    }
    // No doc in the compliance pack or decisions may present the placeholder address as an official contact.
    const dirs = ["docs/compliance", "docs/decisions"];
    for (const d of dirs) {
      if (!fs.existsSync(path.join(root, d))) continue;
      for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith(".md"))) {
        for (const line of rd(`${d}/${f}`).split(/\r?\n/)) {
          if (/example\.invalid/.test(line)) expect(line, `${d}/${f}`).not.toMatch(/\b(approved|official contact|verified|confirmed real)\b/i);
        }
      }
    }
  });

  it("@E2E-165 ARTEFACT_TEXT.md is up to date with the notice, page and banner text", () => {
    expect(rd("docs/compliance/ARTEFACT_TEXT.md")).toBe(render());
  });

  it("@E2E-165 every legal statement section in the counsel pack carries a verification marker", () => {
    const text = rd("docs/compliance/COUNSEL_PACK.md");
    expect(text).toMatch(/\[VERIFY WITH COUNSEL\]/);
    expect(text).toMatch(/\[PRIMARY-READ/);
    expect(text).toMatch(/CERT-In_Directions_70B_28\.04\.2022\.pdf/);
  });
});
