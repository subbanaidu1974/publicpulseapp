/**
 * Release-gate evidence status (S-153, E2E-168).
 *
 * Reads docs/RELEASE_GATE.md (the table of rows, owners, dates and boxes) and docs/gate/NN/ (the per-row README that lists the
 * automated evidence in this repository, and the evidence/ folder where a human attaches artefacts) and prints, per row:
 *   - automated evidence found / missing (each listed path must exist; a `#@E2E-NN` suffix means the file must contain that tag),
 *   - whether a human has attached anything under docs/gate/NN/evidence/,
 *   - whether an owner and a date are set on the row,
 *   - whether the box is checked, and whether that is consistent with the rest.
 * It never checks a box and never invents an owner or date: those are human decisions. Automated evidence is supporting, never sufficient.
 *
 * Usage:  npm run gate:status                 text report
 *         npm run gate:status -- --json       JSON report
 *         npm run gate:status -- --strict     exit 1 while any row (or the sign-off) is blocked
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface GateRowDef { row: number; gate: string; evidence: string; owner: string; date: string; checked: boolean }
export interface AutomatedRef { ref: string; path: string; tag: string | null; exists: boolean; tagFound: boolean | null; note: string }
export type RowStatus = "done" | "blocked" | "inconsistent" | "deferred";
export type GateProfile = "full" | "pilot";
export interface RowReport {
  row: number; gate: string; folder: string; readme: boolean;
  checked: boolean; owner: string; date: string; ownerPresent: boolean; datePresent: boolean;
  automated: AutomatedRef[]; automatedFound: number; automatedMissing: number;
  humanEvidenceFiles: string[]; humanEvidencePresent: boolean;
  status: RowStatus; reasons: string[]; deferralCondition?: string;
}
export interface GateReport {
  /** "full" (all rows, default) or "pilot" (draft closed-pilot gate, docs/gate/pilot-profile.json, off unless enabled) */
  profile: GateProfile;
  pilotLimits: string[];
  rows: RowReport[];
  signOff: { approver1: boolean; approver2: boolean };
  summary: { total: number; done: number; blocked: number; inconsistent: number; deferred: number; blockedRows: number[]; releaseBlocked: boolean };
}

const clean = (s: string) => s.replace(/<[^>]*>/g, "").trim();
const isBlank = (s: string) => /^[\s_\-]*$/.test(s);
/** A cell starting PLACEHOLDER- stands for a person or date not yet chosen: it is shown, but never counts as an owner, a date or a signature. */
const isPlaceholder = (s: string) => /^\s*PLACEHOLDER-/i.test(s);
const isSet = (s: string) => !isBlank(s) && !isPlaceholder(s);

/** Parse the table in RELEASE_GATE.md: `| # | Gate | Evidence | Owner | Date | Done |`. */
export function parseGateTable(md: string): GateRowDef[] {
  const rows: GateRowDef[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\|\s*(\d+)\s*\|/.exec(line);
    if (!m) continue;
    const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    if (cells.length < 6) continue;
    const [n, gate, evidence, owner, date, done] = cells;
    rows.push({ row: Number(n), gate, evidence, owner: clean(owner), date: clean(date), checked: /\[\s*[xX]\s*\]/.test(done) });
  }
  return rows;
}

/** Approver lines under "## Sign-off": present when something other than blanks follows the colon (before "Date:"). */
export function parseSignOff(md: string): { approver1: boolean; approver2: boolean } {
  const grab = (re: RegExp): boolean => {
    const m = re.exec(md);
    return !!m && isSet(m[1]);
  };
  return { approver1: grab(/Approver 1:\s*([^\n]*?)\s+Date:/), approver2: grab(/Approver 2 \(independent\):\s*([^\n]*?)\s+Date:/) };
}

/** Pull `- \`path[#@E2E-NN]\`` bullets from the "Automated evidence" section of a row README. */
export function parseAutomated(readme: string): { ref: string; path: string; tag: string | null; note: string }[] {
  const start = readme.search(/^## Automated evidence/m);
  if (start < 0) return [];
  const rest = readme.slice(start).replace(/^[^\n]*\n/, "");
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const out: { ref: string; path: string; tag: string | null; note: string }[] = [];
  for (const line of section.split(/\r?\n/)) {
    const b = /^-\s+`([^`]+)`\s*(?:-\s*(.*))?$/.exec(line.trim());
    if (!b) continue;
    const [p, tag] = b[1].split("#");
    if (!/[\/.]/.test(p)) continue;
    out.push({ ref: b[1], path: p, tag: tag ?? null, note: (b[2] ?? "").trim() });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

interface PilotProfileFile { enabled?: boolean; limits?: string[]; rows?: Record<string, { state: "required" | "deferred"; why?: string; condition?: string }> }
function loadPilotProfile(root: string): PilotProfileFile | null {
  try { return JSON.parse(fs.readFileSync(path.join(root, "docs", "gate", "pilot-profile.json"), "utf8")) as PilotProfileFile; } catch { return null; }
}

/** profile: explicit choice (tests, --profile); otherwise "pilot" only when docs/gate/pilot-profile.json has enabled: true, else "full". */
export function gateStatus(root: string, opts: { profile?: GateProfile } = {}): GateReport {
  const pf = loadPilotProfile(root);
  const profile: GateProfile = opts.profile ?? (pf?.enabled === true ? "pilot" : "full");
  if (profile === "pilot" && !pf?.rows) throw new Error("pilot profile requested but docs/gate/pilot-profile.json is missing or has no rows");
  const gateMd = fs.readFileSync(path.join(root, "docs", "RELEASE_GATE.md"), "utf8");
  const defs = parseGateTable(gateMd);
  const rows: RowReport[] = defs.map((d) => {
    const folder = path.join("docs", "gate", pad(d.row));
    const readmePath = path.join(root, folder, "README.md");
    const hasReadme = fs.existsSync(readmePath);
    const automated: AutomatedRef[] = hasReadme
      ? parseAutomated(fs.readFileSync(readmePath, "utf8")).map((a) => {
          const abs = path.join(root, a.path);
          const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
          const tagFound = a.tag && exists ? fs.readFileSync(abs, "utf8").includes(a.tag) : a.tag ? false : null;
          return { ...a, exists, tagFound };
        })
      : [];
    const automatedMissing = automated.filter((a) => !a.exists || a.tagFound === false).length;
    const evDir = path.join(root, folder, "evidence");
    const humanEvidenceFiles = fs.existsSync(evDir)
      ? fs.readdirSync(evDir).filter((f) => f !== ".gitkeep" && !f.startsWith(".")).sort()
      : [];
    const ownerPresent = isSet(d.owner), datePresent = isSet(d.date);
    const reasons: string[] = [];
    if (!hasReadme) reasons.push("no docs/gate README for this row");
    if (automatedMissing) reasons.push(`${automatedMissing} automated evidence reference(s) missing in the repository`);
    if (!humanEvidenceFiles.length) reasons.push("no human evidence attached");
    if (!ownerPresent) reasons.push("owner not set");
    if (!datePresent) reasons.push("date not set");
    if (!d.checked) reasons.push("box not checked");
    const humanOk = ownerPresent && datePresent && humanEvidenceFiles.length > 0;
    const deferral = profile === "pilot" ? pf!.rows![String(d.row)] : undefined;
    if (profile === "pilot" && !deferral) reasons.push("row is not classified in the pilot profile (treated as required)");
    let status: RowStatus;
    if (deferral?.state === "deferred" && !d.checked) status = "deferred";
    else if (d.checked && humanOk && hasReadme && !automatedMissing) status = "done";
    else if (d.checked) { status = "inconsistent"; reasons.unshift("box is checked without owner, date and attached evidence"); }
    else status = "blocked";
    return {
      row: d.row, gate: d.gate, folder: folder.split(path.sep).join("/"), readme: hasReadme,
      checked: d.checked, owner: d.owner, date: d.date, ownerPresent, datePresent,
      automated, automatedFound: automated.length - automatedMissing, automatedMissing,
      humanEvidenceFiles, humanEvidencePresent: humanEvidenceFiles.length > 0, status, reasons,
      ...(status === "deferred" ? { deferralCondition: deferral!.condition ?? deferral!.why ?? "" } : {}),
    };
  });
  const signOff = parseSignOff(gateMd);
  const blockedRows = rows.filter((r) => r.status !== "done" && r.status !== "deferred").map((r) => r.row);
  return {
    profile, pilotLimits: profile === "pilot" ? pf!.limits ?? [] : [], rows, signOff,
    summary: {
      total: rows.length, done: rows.filter((r) => r.status === "done").length,
      blocked: rows.filter((r) => r.status === "blocked").length, inconsistent: rows.filter((r) => r.status === "inconsistent").length, deferred: rows.filter((r) => r.status === "deferred").length,
      blockedRows, releaseBlocked: blockedRows.length > 0 || !signOff.approver1 || !signOff.approver2 || rows.length === 0,
    },
  };
}

export function formatReport(r: GateReport): string {
  const L: string[] = [];
  L.push("Release gate status (automated evidence is supporting only; owners, dates and boxes are human decisions)");
  L.push(r.profile === "pilot" ? "PROFILE: pilot (DRAFT closed-pilot gate; the full gate must still pass before any public launch)" : "PROFILE: full", "");
  if (r.profile === "pilot") { L.push("Pilot limits that make the deferrals valid:", ...r.pilotLimits.map((x) => "  - " + x), ""); }
  for (const x of r.rows) {
    L.push(`Row ${x.row} [${x.status.toUpperCase()}] ${x.gate}`);
    if (x.status === "deferred") { L.push(`  deferred while: ${x.deferralCondition}`); continue; }
    L.push(`  automated evidence: ${x.automatedFound} found, ${x.automatedMissing} missing${x.automated.length ? "" : " (none listed)"}`);
    for (const a of x.automated) if (!a.exists || a.tagFound === false) L.push(`    MISSING ${a.ref}`);
    L.push(`  human evidence:     ${x.humanEvidencePresent ? x.humanEvidenceFiles.length + " file(s) in " + x.folder + "/evidence" : "MISSING (nothing in " + x.folder + "/evidence)"}`);
    L.push(`  owner: ${x.ownerPresent ? x.owner : isPlaceholder(x.owner) ? "MISSING (placeholder " + x.owner + ")" : "MISSING"}   date: ${x.datePresent ? x.date : isPlaceholder(x.date) ? "MISSING (placeholder)" : "MISSING"}   box: ${x.checked ? "checked" : "unchecked"}`);
  }
  L.push("");
  L.push(`Summary: ${r.summary.done} of ${r.summary.total} rows done, ${r.summary.blocked} blocked, ${r.summary.inconsistent} inconsistent${r.summary.deferred ? ", " + r.summary.deferred + " deferred (pilot profile)" : ""}`);
  L.push(`Blocked rows: ${r.summary.blockedRows.length ? r.summary.blockedRows.join(", ") : "none"}`);
  L.push(`Sign-off: approver 1 ${r.signOff.approver1 ? "present" : "MISSING"}, approver 2 (independent) ${r.signOff.approver2 ? "present" : "MISSING"}`);
  L.push(`Release: ${r.summary.releaseBlocked ? "BLOCKED" : "all rows and approvers present"}`);
  return L.join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const pi = args.indexOf("--profile");
  const wanted = pi >= 0 ? args[pi + 1] : undefined;
  if (wanted && wanted !== "full" && wanted !== "pilot") { console.error("--profile must be full or pilot"); process.exit(2); }
  const report = gateStatus(root, wanted ? { profile: wanted as GateProfile } : {});
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  if (args.includes("--strict") && report.summary.releaseBlocked) process.exit(1);
}
