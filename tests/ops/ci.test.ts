import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");

describe("UT-ci-workflow", () => {
  it("@E2E-85 CI builds, lints, scans secrets, checks docs and runs coverage on a Windows+Linux matrix", () => {
    for (const needle of ["npm run build", "lint:eslint", "scan:secrets", "check:docs", "--coverage", "windows-latest", "ubuntu-latest", "gitleaks"]) {
      expect(ci, needle).toContain(needle);
    }
  });
  it("@E2E-85 the banned-wording lint is a blocking step", () => {
    const i = ci.indexOf("npm run lint:copy");
    expect(i).toBeGreaterThan(0);
    const next = ci.indexOf("- name:", i);
    expect(ci.slice(i, next === -1 ? undefined : next)).not.toContain("continue-on-error");
  });
});
