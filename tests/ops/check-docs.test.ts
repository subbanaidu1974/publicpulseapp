import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { documentedVars, envVarsUsed, missingVars } from "../../scripts/check-docs";

describe("UT-check-docs", () => {
  let root: string;
  const write = (rel: string, text: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("@E2E-92 the real repo documents every environment variable the code reads", () => {
    expect(missingVars(process.cwd())).toEqual([]);
  });

  it("@E2E-92 finds process.env.X, process.env['X'] and injected env.X usages and reports undocumented ones", () => {
    write("server/a.ts", "const a = process.env.FOO_ONE; const b = process.env['FOO_TWO']; const c = env.FOO_THREE; const d = process.env.VITEST;");
    write("src/lib/b.ts", "export const x = process.env.FOO_FOUR;");
    write("scripts/c.ts", "const y = process.env.FOO_FIVE_API_KEY;");
    write(".env.example", "FOO_ONE=1\n# FOO_TWO: documented in a comment\n# FOO_THREE=\n# FOO_FOUR_*: x\n");
    expect([...envVarsUsed(root).keys()].sort()).toEqual(["FOO_FIVE_API_KEY", "FOO_FOUR", "FOO_ONE", "FOO_THREE", "FOO_TWO", "VITEST"]);
    // FOO_FIVE_API_KEY has no matching entry; VITEST is allow-listed; FOO_FOUR is not covered by the FOO_FOUR_ prefix
    expect(missingVars(root).map((m) => m.name)).toEqual(["FOO_FIVE_API_KEY", "FOO_FOUR"]);
  });

  it("@E2E-92 a prefix family header such as '# SMTP_*:' documents every variable with that prefix", () => {
    expect([...documentedVars("# SMTP_*: smtp settings\n")]).toContain("SMTP_*");
    write("server/a.ts", "const a = process.env.SMTP_HOST;");
    write(".env.example", "# SMTP_*: smtp settings\n");
    expect(missingVars(root)).toEqual([]);
  });
});
