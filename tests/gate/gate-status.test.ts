import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { formatReport, gateStatus, parseAutomated, parseGateTable, parseSignOff } from "../../scripts/gate-status";

const ROOT = path.resolve(__dirname, "..", "..");

describe("release-gate evidence tooling on the real repository (@E2E-168)", () => {
  const report = gateStatus(ROOT);

  it("@E2E-168 reads all 18 rows of RELEASE_GATE.md and every row has a docs/gate README", () => {
    expect(report.rows.map((r) => r.row)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    for (const r of report.rows) expect(r.readme, `row ${r.row} has no docs/gate/${String(r.row).padStart(2, "0")}/README.md`).toBe(true);
  });

  it("@E2E-168 every README has the required sections", () => {
    for (const r of report.rows) {
      const t = fs.readFileSync(path.join(ROOT, r.folder, "README.md"), "utf8");
      for (const h of ["## Evidence required", "## Acceptance criteria", "## Automated evidence (in this repository)", "## Template", "## Attach"]) expect(t, `${r.folder} lacks ${h}`).toContain(h);
      expect(fs.existsSync(path.join(ROOT, r.folder, "evidence")), `${r.folder}/evidence`).toBe(true);
    }
  });

  it("@E2E-168 every automated evidence reference in every README exists, and tags are present in their files", () => {
    for (const r of report.rows) for (const a of r.automated) {
      expect(a.exists, `${r.folder}: ${a.ref} does not exist`).toBe(true);
      expect(a.tagFound === null || a.tagFound, `${r.folder}: ${a.ref} tag not found`).toBe(true);
    }
    expect(report.rows.reduce((n, r) => n + r.automated.length, 0)).toBeGreaterThan(20);
  });

  it("@E2E-168 with no human evidence in the repository, no row is done and the release is blocked", () => {
    expect(report.summary.done).toBe(0);
    expect(report.summary.blockedRows).toHaveLength(18);
    expect(report.summary.releaseBlocked).toBe(true);
    expect(report.signOff).toEqual({ approver1: false, approver2: false });
    for (const r of report.rows) { expect(r.ownerPresent).toBe(false); expect(r.datePresent).toBe(false); expect(r.humanEvidencePresent).toBe(false); }
  });

  it("@E2E-168 the CLI prints the text report and a parseable JSON report, and --strict fails while blocked", () => {
    const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const text = execFileSync(process.execPath, [tsx, "scripts/gate-status.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(text).toContain("Blocked rows: 1, 2, 3");
    expect(text).toContain("Release: BLOCKED");
    const json = JSON.parse(execFileSync(process.execPath, [tsx, "scripts/gate-status.ts", "--json"], { cwd: ROOT, encoding: "utf8" }));
    expect(json.summary.total).toBe(18);
    expect(json.rows[0]).toHaveProperty("automated");
    expect(() => execFileSync(process.execPath, [tsx, "scripts/gate-status.ts", "--strict"], { cwd: ROOT, stdio: "pipe" })).toThrow();
  });
});

describe("gate-status parsing and status logic on fixtures (@E2E-168)", () => {
  let root: string;
  const write = (rel: string, body: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  const gateMd = (owner: string, date: string, done: string, ap1 = "____________") => `# Gate
| # | Gate | Evidence to attach | Owner | Date | Done |
|---|---|---|---|---|---|
| 1 | First | thing | ${owner} | ${date} | ${done} |
| 2 | Second | other | | | [ ] |

- Approver 1: ${ap1}  Date: ______
- Approver 2 (independent): ____________  Date: ______
`;
  const readme = (auto: string) => `# Row\n\n## Evidence required\n\n1. x\n\n## Automated evidence (in this repository)\n\n${auto}\n\n## Template\n\nt\n`;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-status-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("@E2E-168 parses rows, ticks and sign-off", () => {
    const rows = parseGateTable(gateMd("Asha", "2027-01-05", "[x]"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ row: 1, owner: "Asha", date: "2027-01-05", checked: true });
    expect(rows[1]).toMatchObject({ row: 2, owner: "", checked: false });
    expect(parseSignOff(gateMd("", "", "[ ]"))).toEqual({ approver1: false, approver2: false });
    expect(parseSignOff(gateMd("", "", "[ ]", "A. Person"))).toEqual({ approver1: true, approver2: false });
  });

  it("@E2E-168 parses automated evidence bullets with optional tags and notes", () => {
    const a = parseAutomated(readme("- `tests/a.test.ts#@E2E-01` - does a thing\n- `scripts/x.ts`\n- (none)\n- `not a path`"));
    expect(a).toEqual([
      { ref: "tests/a.test.ts#@E2E-01", path: "tests/a.test.ts", tag: "@E2E-01", note: "does a thing" },
      { ref: "scripts/x.ts", path: "scripts/x.ts", tag: null, note: "" },
    ]);
  });

  it("@E2E-168 a row is blocked until owner, date, attached evidence and the box are all present; missing automated references are reported", () => {
    write("docs/RELEASE_GATE.md", gateMd("", "", "[ ]"));
    write("tests/a.test.ts", "it('@E2E-01 x')");
    write("docs/gate/01/README.md", readme("- `tests/a.test.ts#@E2E-01`\n- `tests/missing.test.ts`\n- `tests/a.test.ts#@E2E-99`"));
    const r = gateStatus(root).rows[0];
    expect(r.status).toBe("blocked");
    expect(r.automatedFound).toBe(1);
    expect(r.automatedMissing).toBe(2);
    expect(r.reasons).toEqual(expect.arrayContaining(["no human evidence attached", "owner not set", "date not set", "box not checked"]));
    expect(gateStatus(root).rows[1].reasons).toContain("no docs/gate README for this row");
    expect(formatReport(gateStatus(root))).toContain("MISSING tests/missing.test.ts");
  });

  it("@E2E-168 a checked box without owner, date and evidence is inconsistent, never done", () => {
    write("docs/RELEASE_GATE.md", gateMd("", "", "[x]"));
    write("docs/gate/01/README.md", readme("- (none)"));
    const r = gateStatus(root).rows[0];
    expect(r.status).toBe("inconsistent");
    expect(r.reasons[0]).toMatch(/checked without owner, date and attached evidence/);
  });

  it("@E2E-168 a row is done only with box, owner, date and an attached file (.gitkeep does not count)", () => {
    write("docs/RELEASE_GATE.md", gateMd("Asha", "2027-01-05", "[x]"));
    write("docs/gate/01/README.md", readme("- (none)"));
    write("docs/gate/01/evidence/.gitkeep", "");
    expect(gateStatus(root).rows[0].status).toBe("inconsistent");
    write("docs/gate/01/evidence/report.pdf", "x");
    const s = gateStatus(root);
    expect(s.rows[0].status).toBe("done");
    expect(s.summary.blockedRows).toEqual([2]);
    expect(s.summary.releaseBlocked).toBe(true);
  });
});
