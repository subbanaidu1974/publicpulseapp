import { describe, it, expect } from "vitest";
import { scanText } from "../../scripts/lint-copy";

describe("copy lint @E2E-143", () => {
  it("flags banned English words in string literals and JSX text", () => {
    expect(scanText("src/components/Survey.tsx", `const a = "Cast your vote";`)).toHaveLength(1);
    expect(scanText("src/components/Survey.tsx", `<h1>Survey results</h1>`)).toHaveLength(1);
    expect(scanText("src/components/Survey.tsx", `const b = 'Your ballot';`)).toHaveLength(1);
  });
  it("flags Telugu equivalents", () => {
    expect(scanText("src/i18n/index.tsx", `  "nav.survey": "మీ ఓటు వేయండి",`)).toHaveLength(1);
    expect(scanText("src/i18n/index.tsx", `  "x.y": "బ్యాలెట్",`)).toHaveLength(1);
  });
  it("allows allow-listed files and key prefixes", () => {
    expect(scanText("src/components/ElectionsPage.tsx", `const a = "Election results";`)).toHaveLength(0);
    expect(scanText("src/i18n/index.tsx", `  "elections.results": "Results",`)).toHaveLength(0);
    expect(scanText("src/i18n/index.tsx", `  "fc.vote": "Vote share",`)).toHaveLength(0);
    expect(scanText("src/i18n/index.tsx", `  "nav.survey": "Vote now",`)).toHaveLength(1);
  });
  it("honours inline escape and ignores comments and identifiers", () => {
    expect(scanText("src/a.tsx", `const a = "results"; // copy-lint-allow: API path`)).toHaveLength(0);
    expect(scanText("src/a.tsx", `// copy-lint-allow: legal\nconst a = "vote";`)).toHaveLength(0);
    expect(scanText("src/a.tsx", `// the vote count\nconst voteCount = 1;`)).toHaveLength(0);
    expect(scanText("src/a.tsx", `import { results } from "./results";`)).toHaveLength(0);
  });
});
