import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CandidateResult } from "../../src/lib/elections";
import { normalizeCensus } from "../../pipeline/census";
import { canonicalParty, normalizeTcpd, parseCsv } from "../../pipeline/normalize";
import { validateElections } from "../../pipeline/quality";

const ROOT = resolve(__dirname, "../..");
const FX = (f: string) => readFileSync(resolve(ROOT, "pipeline/fixtures", f), "utf8");
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pp-")); tmps.push(d); return d; };
afterAll(() => tmps.forEach(d => rmSync(d, { recursive: true, force: true })));

function run(script: string, outDir: string, env: Record<string, string | undefined> = {}, args: string[] = []) {
  const e: Record<string, string | undefined> = { ...process.env, PIPELINE_OUT_DIR: outDir, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), resolve(ROOT, "scripts", script), ...args],
    { env: e as NodeJS.ProcessEnv, encoding: "utf8", cwd: ROOT });
}

describe("UT-ingest csv + normalization", () => {
  it("parses quoted fields, escaped quotes, CRLF and BOM", () => {
    const rows = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n2,3\r\n');
    expect(rows).toEqual([{ a: "x,1", b: 'he said "hi"' }, { a: "2", b: "3" }]);
  });
  it("canonicalises party aliases", () => {
    expect(canonicalParty("TRS")).toBe("BRS");
    expect(canonicalParty("JnP")).toBe("JSP");
    expect(canonicalParty(" ysrcp ")).toBe("YSRCP");
    expect(canonicalParty("")).toBe("IND");
    expect(canonicalParty("XYZ")).toBe("XYZ");
  });
  it("maps states, skips other states and invalid rows", () => {
    const h = "State_Name,Year,Constituency_No,Constituency_Name,District_Name,Position,Candidate,Party,Votes,Valid_Votes,Electors\n";
    const csv = h +
      "Andhra_Pradesh,2019,1,A,D,1,X,TRS,100,200,300\n" +
      "Telangana,2023,1,B,D,1,Y,TRS,100,200,300\n" +
      "Kerala,2019,1,C,D,1,Z,INC,100,200,300\n" +
      "Telangana,2023,2,B2,D,1,Neg,INC,-5,200,300\n" +
      "Telangana,2023,3,B3,D,1,,INC,5,200,300\n" +
      "Telangana,abc,4,B4,D,1,Bad,INC,5,200,300\n";
    const out = normalizeTcpd(csv, "assembly", "TCPD");
    expect(out.map(r => [r.state, r.party, r.provenance])).toEqual([["AP", "BRS", "TCPD"], ["TG", "BRS", "TCPD"]]);
  });
});

describe("@E2E-23 UT-ingest fixture CSV to golden snapshot", () => {
  const golden = JSON.parse(FX("elections.golden.json"));
  it("normalised fixture equals golden file", () => {
    const rows = normalizeTcpd(FX("elections.demo.csv"), "assembly", "demo");
    expect(rows).toEqual(golden.results);
    expect(rows.every(r => r.acName.startsWith("DEMO-"))).toBe(true);
    expect(rows.some(r => r.state === "AP" && r.year === 2024)).toBe(true);
    expect(rows.some(r => r.state === "TG" && r.year === 2023)).toBe(true);
  });
  it("CLI writes snapshot equal to golden and re-run is idempotent", () => {
    const out = tmp();
    const r1 = run("fetch-elections.ts", out, { TCPD_CSV_URL: undefined });
    expect(r1.status).toBe(0);
    expect(r1.stdout + r1.stderr).toMatch(/WARNING/);
    const f = join(out, "elections.json");
    const first = readFileSync(f, "utf8");
    expect(JSON.parse(first)).toEqual(golden);
    expect(run("fetch-elections.ts", out, { TCPD_CSV_URL: undefined }).status).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(first);
  });
  it("includes a marginal (<2%) seat", () => {
    const byAc = new Map<string, CandidateResult[]>();
    for (const r of golden.results as CandidateResult[]) byAc.set(`${r.state}${r.year}${r.acNo}`, [...(byAc.get(`${r.state}${r.year}${r.acNo}`) ?? []), r]);
    const margins = [...byAc.values()].map(l => { const s = [...l].sort((a, b) => b.votes - a.votes); return (s[0].votes - s[1].votes) / s[0].validVotes * 100; });
    expect(margins.some(m => m < 2)).toBe(true);
    expect(margins.some(m => m > 10)).toBe(true);
  });
});

describe("UT-census normalisation", () => {
  it("computes percentages and sex ratio, maps state codes", () => {
    const out = normalizeCensus(FX("census.demo.csv"), "demo");
    expect(out).toHaveLength(4);
    const a = out.find(d => d.district === "DEMO-District-A")!;
    expect(a.state).toBe("AP");
    expect(a.censusYear).toBe(2011);
    expect(a.literacyPct).toBe(65);
    expect(a.scPct).toBe(15);
    expect(a.stPct).toBe(5);
    expect(a.sexRatio).toBe(980);
    expect(out.filter(d => d.state === "TG")).toHaveLength(2);
  });
  it("skips other states and malformed rows", () => {
    const csv = "State,District,TOT_P,TOT_M,TOT_F,P_SC,P_ST,P_LIT\n29,K,10,5,5,1,1,5\n28,Bad,x,5,5,1,1,5\n28,Zero,0,0,0,0,0,0\n36,Ok,10,5,5,1,1,5\n";
    expect(normalizeCensus(csv, "t").map(d => d.district)).toEqual(["Ok"]);
  });
});

describe("@E2E-24 UT-census missing API key falls back to fixture", () => {
  it("exits 0, logs a warning, never leaks key, uses demo fixture", () => {
    const out = tmp();
    const r = run("fetch-census.ts", out, { DATA_GOV_IN_API_KEY: undefined, DATA_GOV_IN_RESOURCE_ID: undefined });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/WARNING.*DATA_GOV_IN_API_KEY/);
    const snap = JSON.parse(readFileSync(join(out, "census.json"), "utf8"));
    expect(snap.provenance).toBe("demo");
    expect(snap.districts.length).toBe(4);
  });
  it("key set without resource id still falls back and does not print the key", () => {
    const out = tmp();
    const r = run("fetch-census.ts", out, { DATA_GOV_IN_API_KEY: "SECRET-KEY-123", DATA_GOV_IN_RESOURCE_ID: undefined });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("SECRET-KEY-123");
    expect(JSON.parse(readFileSync(join(out, "census.json"), "utf8")).provenance).toBe("demo");
  });
});

describe("@E2E-08 data quality gate", () => {
  const rows = () => JSON.parse(FX("elections.golden.json")).results as CandidateResult[];
  it("passes on clean demo data (seat counts not enforced for demo)", () => {
    expect(validateElections(rows(), false)).toEqual([]);
  });
  it("flags duplicate (state,year,type,acNo,candidate)", () => {
    const r = rows(); r.push({ ...r[0] });
    expect(validateElections(r, false).join()).toMatch(/duplicate/);
  });
  it("flags negative votes and margin exceeding valid votes", () => {
    const r = rows(); r[0] = { ...r[0], votes: -1 };
    expect(validateElections(r, false).join()).toMatch(/negative/);
    const r2 = rows(); r2[0] = { ...r2[0], validVotes: 10 };
    expect(validateElections(r2, false).join()).toMatch(/exceed/);
  });
  it("enforces seat counts only when not demo", () => {
    expect(validateElections(rows(), true).join()).toMatch(/seat count AP 2019 assembly: expected 175, got 3/);
  });
  it("validate CLI exits 0 on generated demo data and non-zero on violation", () => {
    const out = tmp();
    expect(run("fetch-elections.ts", out).status).toBe(0);
    expect(run("fetch-census.ts", out).status).toBe(0);
    expect(run("validate-data.ts", out, {}, [out]).status).toBe(0);
    const snap = JSON.parse(readFileSync(join(out, "elections.json"), "utf8"));
    snap.results.push({ ...snap.results[0] });
    writeFileSync(join(out, "elections.json"), JSON.stringify(snap));
    const bad = run("validate-data.ts", out, {}, [out]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/duplicate/);
  });
  it("validate CLI fails when real-provenance data has wrong seat counts", () => {
    const out = tmp();
    run("fetch-elections.ts", out);
    const snap = JSON.parse(readFileSync(join(out, "elections.json"), "utf8"));
    snap.provenance = "TCPD";
    writeFileSync(join(out, "elections.json"), JSON.stringify(snap));
    expect(run("validate-data.ts", out, {}, [out]).status).not.toBe(0);
  });
  it("boundaries fetch tolerates network failure (exit 0)", () => {
    const out = tmp();
    const r = run("fetch-boundaries.ts", out, { BOUNDARIES_AP_URL: "http://127.0.0.1:9/x.geojson", BOUNDARIES_TG_URL: "http://127.0.0.1:9/y.geojson" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/WARNING/);
    expect(existsSync(join(out, "boundaries-ap.geojson"))).toBe(false);
  });
});
