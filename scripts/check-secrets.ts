/** Local fallback secret scanner (S-58). Small regex set; CI also runs gitleaks. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULES: { id: string; re: RegExp }[] = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { id: "password-literal", re: /\bpass(?:word|wd)?\s*[:=]\s*["'][^"'\s]{6,}["']/i },
  { id: "smtp-creds", re: /\bsmtps?:\/\/[^\s:@/]+:[^\s@/]+@/i },
];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "playwright-report", "test-results", "data", "worktrees"]);
const SKIP_FILES = new Set(["package-lock.json", "bun.lock", "check-secrets.ts", "secrets.test.ts"]);
const EXT = /\.(ts|tsx|js|cjs|mjs|json|ya?ml|env|md|toml|html|txt|sh)$|^\.env/;

export interface Finding { file: string; line: number; rule: string }

export function scanSecrets(root: string): Finding[] {
  const out: Finding[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (SKIP_FILES.has(e.name) || e.name === ".env.example" || !EXT.test(e.name)) continue;
      const text = fs.readFileSync(p, "utf8");
      text.split(/\r?\n/).forEach((l, i) => {
        if (/secret-scan-allow/.test(l)) return;
        for (const r of RULES) if (r.re.test(l)) out.push({ file: p, line: i + 1, rule: r.id });
      });
    }
  };
  walk(root);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = scanSecrets(path.resolve(process.argv[2] || "."));
  for (const x of f) console.log(`${path.relative(process.cwd(), x.file)}:${x.line}  ${x.rule}`);
  console.log(`secret-scan: ${f.length} finding(s)`);
  process.exit(f.length ? 1 : 0);
}
