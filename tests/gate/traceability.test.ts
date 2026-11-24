import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const md = fs.readFileSync(path.join(ROOT, "docs", "THREAT_MODEL.md"), "utf8");
const STATUSES = ["BUILT", "PARTIAL", "DEV-ONLY", "NOT BUILT"];
/** BUILT controls that have no test. Each is a known, documented gap; adding to this list needs a reason in THREAT_MODEL.md. */
const KNOWN_UNTESTED_BUILT: string[] = [];

interface Row { id: string; control: string; code: string[]; tests: string[]; status: string; raw: string }

function section(title: RegExp): string {
  const start = md.search(title);
  if (start < 0) return "";
  const rest = md.slice(start).replace(/^[^\n]*\n/, "");
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}
const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function parseTable(sec: string, idPrefix: string): string[][] {
  return sec.split(/\r?\n/).filter((l) => new RegExp(String.raw`^\|\s*${idPrefix}-\d+\s*\|`).test(l))
    .map((l) => l.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
}

const rows: Row[] = parseTable(section(/^## 4A\./m), "T").map((c) => ({ id: c[0], control: c[1], code: ticks(c[2]), tests: ticks(c[3]), status: c[4], raw: c[2] + "|" + c[3] }));
const lineCount = (file: string) => fs.readFileSync(file, "utf8").split(/\r?\n/).length;

describe("THREAT_MODEL traceability table (@E2E-80)", () => {
  it("@E2E-80 has a well-formed, sequential table with a legal status on every row", () => {
    expect(rows.length).toBeGreaterThanOrEqual(50);
    rows.forEach((r, i) => {
      expect(r.id).toBe("T-" + String(i + 1).padStart(2, "0"));
      expect(r.control.length, r.id).toBeGreaterThan(10);
      expect(STATUSES.some((s) => r.status.startsWith(s)), `${r.id} status "${r.status}"`).toBe(true);
    });
  });

  it("@E2E-80 every cited code file exists and every cited line is inside the file", () => {
    for (const r of rows.filter((x) => !x.status.startsWith("NOT BUILT"))) {
      expect(r.code.length, `${r.id} cites no code`).toBeGreaterThan(0);
      for (const ref of r.code) {
        const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref)!;
        const file = path.join(ROOT, m[1]);
        expect(fs.existsSync(file), `${r.id}: ${m[1]} does not exist`).toBe(true);
        if (m[2]) {
          const total = lineCount(file), a = Number(m[2]), b = m[3] ? Number(m[3]) : a;
          expect(a >= 1 && b >= a && b <= total, `${r.id}: ${ref} is outside ${m[1]} (${total} lines)`).toBe(true);
        }
      }
    }
  });

  it("@E2E-80 every cited test file exists and contains the cited @E2E tag", () => {
    for (const r of rows) for (const ref of r.tests) {
      const [p, tag] = ref.split("#");
      const file = path.join(ROOT, p);
      expect(fs.existsSync(file), `${r.id}: test file ${p} does not exist`).toBe(true);
      if (tag) expect(fs.readFileSync(file, "utf8").includes(tag), `${r.id}: ${p} does not contain ${tag}`).toBe(true);
      expect(/\.(test|spec)\.ts$/.test(p), `${r.id}: ${p} is not a test file`).toBe(true);
    }
  });

  it("@E2E-80 NOT BUILT rows cite no code or test, and BUILT rows without a test are on the known-gap list", () => {
    for (const r of rows) {
      if (r.status.startsWith("NOT BUILT")) { expect(r.code, r.id).toEqual([]); expect(r.tests, r.id).toEqual([]); }
      if (r.status.startsWith("BUILT") && r.tests.length === 0) expect(KNOWN_UNTESTED_BUILT, `${r.id} is BUILT with no test`).toContain(r.id);
    }
    for (const id of KNOWN_UNTESTED_BUILT) expect(rows.find((r) => r.id === id)?.tests.length, `${id} now has a test: remove it from the known-gap list`).toBe(0);
  });

  it("@E2E-80 DEV-ONLY and PARTIAL rows say why (not a bare status)", () => {
    for (const r of rows.filter((x) => /^(DEV-ONLY|PARTIAL)/.test(x.status))) expect(r.status.length, r.id).toBeGreaterThan(14);
  });

  it("@E2E-80 section 4 only cites controls that exist, and the corrected claims are present", () => {
    const ids = new Set(rows.map((r) => r.id));
    for (const m of section(/^## 4\. /m).matchAll(/\bT-\d{2}\b/g)) expect(ids.has(m[0]), `${m[0]} cited in section 4 but missing from 4A`).toBe(true);
    expect(md).toMatch(/address-prefix proxy/);
    expect(md).toMatch(/personal PIN/);
    expect(md).toMatch(/CIVIC_ANCHOR_URL/);
    expect(md).toMatch(/one host/i);
  });

  it("@E2E-80 stale claims are gone", () => {
    expect(md).not.toMatch(/IVR personal-PIN step not built/i);
    expect(md).not.toMatch(/shared SIMs are refused over IVR rather than guessed/i);
    expect(md).not.toMatch(/Erasure reaching the audit log by redaction[^.]*\[PLAN\]/i);
  });

  it("@E2E-80 the residual risk register has an unassigned owner column and a stated status for every risk", () => {
    const risks = parseTable(section(/^## 6\./m), "R");
    expect(risks.length).toBeGreaterThanOrEqual(15);
    for (const c of risks) {
      expect(c.length, c[0]).toBe(7);
      expect(c[1].length, c[0]).toBeGreaterThan(20);
      expect(c[5], `${c[0]} owner is a human decision; the tooling leaves it TBD`).toBe("TBD");
      expect(c[6], `${c[0]} review date is a human decision`).toBe("");
      for (const t of c[2].match(/T-\d{2}/g) ?? []) expect(rows.some((r) => r.id === t), `${c[0]} cites ${t}`).toBe(true);
    }
  });
});

describe("RELEASE_GATE reconciliation (@E2E-80)", () => {
  const gate = fs.readFileSync(path.join(ROOT, "docs", "RELEASE_GATE.md"), "utf8");
  const gateRows = gate.split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|/.test(l));

  it("@E2E-80 has 18 rows and no box is checked: checking needs human evidence", () => {
    expect(gateRows.length).toBe(18);
    for (const l of gateRows) expect(/\[\s*[xX]\s*\]/.test(l), l.slice(0, 40)).toBe(false);
  });

  it("@E2E-80 owner and date cells are blank (a human decides them)", () => {
    for (const l of gateRows) {
      const c = l.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((x) => x.trim());
      expect(c.length).toBe(6);
      expect(c[3], `row ${c[0]} owner`).toBe("");
      expect(c[4], `row ${c[0]} date`).toBe("");
    }
  });

  it("@E2E-80 rows 7, 12 and 17 reflect what is built without claiming human evidence", () => {
    const r = (n: number) => gateRows.find((l) => new RegExp(String.raw`^\|\s*${n}\s*\|`).test(l))!;
    expect(r(7)).toMatch(/load tests exist/i);
    expect(r(7)).toMatch(/address-prefix proxy/);
    expect(r(12)).toMatch(/physical low-end/i);
    expect(r(17)).toMatch(/Built/);
    expect(r(17)).toMatch(/\[ \]/);
  });
});
