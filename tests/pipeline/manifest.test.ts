import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MANIFEST_NAME, REFERENCE_FILES, buildManifest, licenceDecisions, loadLicenceKeys, sha256Of, verifyManifest } from "../../pipeline/manifest";
import { renderAttribution } from "../../scripts/gen-attribution";

const ROOT = resolve(__dirname, "../..");
const GEN = resolve(ROOT, "data/generated");
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pp-man-")); tmps.push(d); return d; };
afterAll(() => tmps.forEach(d => rmSync(d, { recursive: true, force: true })));

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1).split("\\").join("/")];
  });
}
const tsx = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), resolve(ROOT, "scripts", script), ...args], { env: { ...process.env, ...env } as NodeJS.ProcessEnv, encoding: "utf8", cwd: ROOT });

describe("@E2E-108 dataset manifest", () => {
  const m = JSON.parse(readFileSync(resolve(GEN, MANIFEST_NAME), "utf8"));

  it("every dataset file under data/generated and the reference files has a manifest entry", () => {
    const listed = new Set(m.datasets.map((d: { path: string }) => d.path));
    for (const f of walk(GEN).filter(f => f !== MANIFEST_NAME && /\.(geo)?json$/.test(f))) expect(listed.has(`data/generated/${f}`), f).toBe(true);
    for (const f of REFERENCE_FILES) expect(listed.has(f), f).toBe(true);
  });

  it("entries carry id, sources, licences, sha256, asOf, row counts, provenance and attribution", () => {
    for (const d of m.datasets) {
      expect(d.id).toBeTruthy();
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(d.rows).toBeGreaterThan(0);
      expect(d.licences.length).toBeGreaterThan(0);
      expect(d.attribution).toBeTruthy();
      expect(d.provenance).toBeTruthy();
      expect(d.id.startsWith("unclassified-"), `${d.path} needs a rule in pipeline/manifest.ts`).toBe(false);
      if (d.provenance !== "hand-curated") expect(d.sources.length, d.id).toBeGreaterThan(0);
    }
    const byId = Object.fromEntries(m.datasets.map((d: { id: string }) => [d.id, d]));
    expect(byId.elections.licences).toContain("tcpd-nc");
    expect(byId.elections.rows).toBe(15233);
    expect(byId["census-districts"].provenance).toBe("census-dchb-2011");
    expect(byId["census-districts"].asOf).toBe("2011-03-01");
  });

  it("the committed manifest verifies against disk (checksums, licence keys, completeness)", () => {
    expect(verifyManifest()).toEqual([]);
    expect(buildManifest().datasets.map((d: { sha256: string }) => d.sha256)).toEqual(m.datasets.map((d: { sha256: string }) => d.sha256));
  });

  it("a checksum mismatch fails verification and the pipeline:validate CLI", () => {
    const dir = tmp();
    for (const f of ["elections.json", "census.json", MANIFEST_NAME]) cpSync(resolve(GEN, f), join(dir, f));
    // Keep only what the copied manifest lists so the only defect is the checksum.
    const man = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8"));
    man.datasets = man.datasets.filter((d: { path: string }) => ["data/generated/elections.json", "data/generated/census.json", ...REFERENCE_FILES].includes(d.path));
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(man));
    expect(verifyManifest(dir)).toEqual([]);
    const snap = JSON.parse(readFileSync(join(dir, "census.json"), "utf8"));
    snap.districts[0].population += 1;
    writeFileSync(join(dir, "census.json"), JSON.stringify(snap));
    expect(verifyManifest(dir).join()).toMatch(/checksum mismatch for data\/generated\/census\.json/);
    const r = tsx("validate-data.ts", [dir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/checksum mismatch/);
  });

  it("an unlisted file and an unknown licence key are reported", () => {
    const dir = tmp();
    for (const f of ["elections.json", MANIFEST_NAME]) cpSync(resolve(GEN, f), join(dir, f));
    writeFileSync(join(dir, "extra.json"), JSON.stringify({ rows: [1] }));
    const man = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8"));
    man.datasets = man.datasets.filter((d: { path: string }) => d.path === "data/generated/elections.json");
    man.datasets[0].licences = ["not-in-register"];
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(man));
    const e = verifyManifest(dir).join("\n");
    expect(e).toMatch(/extra\.json has no manifest entry/);
    expect(e).toMatch(/licence key 'not-in-register'/);
  });

  it("checksums are stable across CRLF checkouts", () => {
    const dir = tmp();
    const a = join(dir, "a.json"), b = join(dir, "b.json");
    writeFileSync(a, '{\n  "x": 1\n}\n');
    writeFileSync(b, '{\r\n  "x": 1\r\n}\r\n');
    expect(sha256Of(a)).toBe(sha256Of(b));
  });
});

describe("@E2E-109 licence compliance register", () => {
  const reg = JSON.parse(readFileSync(resolve(ROOT, "data/reference/licences.json"), "utf8")).licences as Record<string, {
    status: string; constraints: string[]; needsDecision: boolean; decision?: string; attribution: string; evidence: string;
  }>;
  const m = JSON.parse(readFileSync(resolve(GEN, MANIFEST_NAME), "utf8"));

  it("every licence key used by a manifest dataset exists in the register", () => {
    const keys = new Set(loadLicenceKeys());
    for (const d of m.datasets) for (const k of d.licences) expect(keys.has(k), `${d.id} -> ${k}`).toBe(true);
  });

  it("flags TCPD non-commercial, DataMeet NC-SA do-not-ship, Esri tiles and unstated census/LGD terms for a human decision", () => {
    expect(reg["tcpd-nc"].constraints).toContain("non-commercial");
    expect(reg["tcpd-nc"].needsDecision).toBe(true);
    expect(reg["datameet-nc-sa"].status).toBe("do-not-ship");
    expect(reg["datameet-nc-sa"].constraints).toEqual(expect.arrayContaining(["non-commercial", "share-alike"]));
    expect(reg["esri-basemap-terms"].needsDecision).toBe(true);
    expect(reg["census-orgi-2011"].needsDecision).toBe(true);
    expect(reg["odbl"].constraints.join()).toMatch(/share-alike/);
    expect(reg["wikimedia-cc-by-sa"].constraints.join()).toMatch(/attribution/);
  });

  it("no shipped dataset relies on a do-not-ship licence", () => {
    for (const d of m.datasets) for (const k of d.licences) expect(reg[k].status, `${d.id} uses ${k}`).not.toBe("do-not-ship");
  });

  it("every entry that needs a decision explains it; every entry has attribution and evidence", () => {
    for (const [k, v] of Object.entries(reg)) {
      expect(v.attribution, k).toBeTruthy();
      expect(v.evidence, k).toBeTruthy();
      if (v.needsDecision) expect(v.decision, k).toBeTruthy();
    }
    const dec = licenceDecisions();
    expect(dec.find(d => d.key === "tcpd-nc")!.datasets).toContain("elections");
    expect(dec.find(d => d.key === "census-orgi-2011")!.datasets).toContain("census-districts");
  });

  it("docs/ATTRIBUTION.md is generated from the register and is up to date", () => {
    const onDisk = readFileSync(resolve(ROOT, "docs/ATTRIBUTION.md"), "utf8").replace(/\r\n/g, "\n");
    expect(onDisk).toBe(renderAttribution().replace(/\r\n/g, "\n"));
    expect(onDisk).toMatch(/Needs a human decision/);
    expect(onDisk).toMatch(/Telugu Desam Party Flag 2024\.png/);
  });
});
