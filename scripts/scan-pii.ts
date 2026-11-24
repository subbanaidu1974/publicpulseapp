/**
 * Internal secrets / PII scan over the files git tracks (INTERNAL SELF-ASSESSMENT, NOT INDEPENDENT).
 * Broader than scripts/check-secrets.ts (which CI runs): provider tokens, JWTs, long literals assigned to secret-like names, real-looking
 * Indian mobile numbers and Aadhaar-shaped numbers outside tests and fixtures, e-mail addresses on non-reserved domains, log statements
 * that name a personal field, and tracked files that should never be tracked (env files, databases, key material, backups).
 *
 *   npx tsx scripts/scan-pii.ts            # human readable, exit 1 on any "high" finding
 *   npx tsx scripts/scan-pii.ts --json     # machine readable
 *
 * Findings are triaged by a human; "info" findings are expected shapes (fixtures, documentation) and never fail the run.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Severity = "high" | "medium" | "info";
export interface PiiFinding { file: string; line: number; rule: string; severity: Severity; excerpt: string }

const TEXT = /\.(ts|tsx|js|cjs|mjs|json|ya?ml|env|md|toml|html|css|txt|sh|sql|csv)$|(^|\/)\.env/;
const isTest = (f: string) => /(^|\/)(tests?|e2e|__tests__|scratch_tmp)\//.test(f) || /\.(test|spec)\.[tj]sx?$/.test(f);
const isDoc = (f: string) => /^docs\/|\.md$|README/.test(f);
const isData = (f: string) => /^(data|public)\//.test(f);

const SECRET_RULES: { id: string; re: RegExp; sev: Severity }[] = [
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/, sev: "high" },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, sev: "high" },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, sev: "high" },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, sev: "high" },
  { id: "stripe-live-key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/, sev: "high" },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, sev: "high" },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, sev: "high" },
  { id: "basic-auth-url", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:[^\s@/'"]{3,}@[^\s/'"]+/i, sev: "high" },
  { id: "secret-literal", re: /\b(?:api[_-]?key|secret|passw(?:or)?d|auth[_-]?token|access[_-]?token|private[_-]?key)\w*\s*[:=]\s*["'`][A-Za-z0-9+/=_.-]{24,}["'`]/i, sev: "medium" },
];

const PII_RULES: { id: string; re: RegExp; sev: Severity }[] = [
  { id: "indian-mobile", re: /(?<![\w.])(?:\+91[\s-]?)?[6-9]\d{9}(?![\w.])/, sev: "medium" },
  { id: "aadhaar-shaped", re: /(?<![\d.])[2-9]\d{3}\s\d{4}\s\d{4}(?![\d.])/, sev: "medium" },
  { id: "pan-shaped", re: /\b[A-Z]{5}\d{4}[A-Z]\b/, sev: "medium" },
  { id: "email", re: /\b[A-Za-z0-9._%+-]+@(?!example\.|.*\.invalid\b|.*\.test\b|.*\.example\b|localhost)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, sev: "info" },
];

/** A logging call that mentions a personal field by name. Matching a name is a lead, not proof: the line is shown for a human. */
const LOG_RULE = /\b(?:console\.(?:log|info|warn|error|debug)|log\.(?:debug|info|warn|error)|logger\.\w+)\s*\(.*\b(?:phone|otp|pin|passw\w*|token|authorization|secret|e164|msisdn)\b/i;

const FORBIDDEN_TRACKED = [
  { id: "env-file", re: /(^|\/)\.env(\.(?!example$)[^/]*)?$/ },
  { id: "database-file", re: /\.(db|sqlite3?|db-wal|db-shm)$/i },
  { id: "key-material", re: /\.(pem|key|p12|pfx|jks|keystore)$/i },
  { id: "backup-archive", re: /(^|\/)(backups?|dumps?)\/|\.(bak|dump)$|\.sql\.gz$/i },
];

export function trackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
  return out.split("\0").filter(Boolean).filter((f) => !f.startsWith(".claude/"));
}

function sevFor(base: Severity, rule: string, file: string): Severity {
  if (base === "info") return base;
  // fixtures, tests and documentation use realistic-looking values on purpose; a human still reads them, but they do not fail the run
  if (file === "tests/tooling/secrets.test.ts") return "info"; // the scanner's own fixture: writes a fake key header on purpose
  if (isTest(file) || isDoc(file)) return rule === "private-key-block" || rule === "aws-access-key" || rule === "github-token" ? base : "info";
  if (isData(file) && (rule === "indian-mobile" || rule === "aadhaar-shaped" || rule === "pan-shaped")) return "medium";
  return base;
}

export function scanTracked(root: string, files = trackedFiles(root)): PiiFinding[] {
  const found: PiiFinding[] = [];
  const add = (file: string, line: number, rule: string, sev: Severity, text: string) => found.push({ file, line, rule, severity: sevFor(sev, rule, file), excerpt: text.trim().slice(0, 140).replace(/[A-Za-z0-9+/=_-]{20,}/g, (m) => m.slice(0, 6) + "...") });
  for (const f of files) {
    for (const r of FORBIDDEN_TRACKED) if (r.re.test(f)) add(f, 0, "tracked-" + r.id, "high", f);
    if (!TEXT.test(f) || /package-lock\.json$|bun\.lock$/.test(f)) continue;
    const p = path.join(root, f);
    let st: fs.Stats; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile() || st.size > 3_000_000) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/secret-scan-allow|pii-scan-allow/.test(l)) return;
      for (const r of SECRET_RULES) if (r.re.test(l)) add(f, i + 1, r.id, r.sev, l);
      if (!/\.(json|csv)$/.test(f) || isData(f)) for (const r of PII_RULES) if (r.re.test(l)) add(f, i + 1, r.id, r.sev, l);
      if (!isTest(f) && /\.(ts|tsx|js|cjs|mjs)$/.test(f) && LOG_RULE.test(l)) add(f, i + 1, "log-names-personal-field", "medium", l);
    });
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.cwd());
  const all = scanTracked(root);
  if (process.argv.includes("--json")) console.log(JSON.stringify(all, null, 2));
  else {
    const by = (s: Severity) => all.filter((x) => x.severity === s);
    for (const s of ["high", "medium", "info"] as Severity[]) {
      const list = by(s);
      console.log(`\n== ${s.toUpperCase()} (${list.length}) ==`);
      const counts = new Map<string, number>();
      for (const x of list) counts.set(x.rule, (counts.get(x.rule) ?? 0) + 1);
      console.log([...counts].map(([k, v]) => `${k}: ${v}`).join(", ") || "none");
      for (const x of list.slice(0, s === "info" ? 0 : 200)) console.log(`${x.file}:${x.line}  ${x.rule}  ${x.excerpt}`);
    }
    console.log(`\nscan-pii (internal self-assessment, not independent): ${by("high").length} high, ${by("medium").length} medium, ${by("info").length} info`);
  }
  process.exit(all.some((x) => x.severity === "high") ? 1 : 0);
}
