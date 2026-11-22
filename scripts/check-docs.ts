/**
 * Docs completeness check (S-77). Every environment variable the code reads must be documented in .env.example
 * (as `NAME=...` or `# NAME=...` / `# NAME: ...`) or appear in ALLOWLIST with a reason.
 * Scans server/**, src/lib/**, scripts/** and playwright.config.ts for `process.env.X`, `process.env["X"]` and `env.X` (injected env objects).
 * Usage: tsx scripts/check-docs.ts   (exit 1 and a list on failure)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Variables deliberately not listed in .env.example. Keep this short and justified. */
export const ALLOWLIST: Record<string, string> = {
  VITEST: "set by the Vitest runner; not configuration",
  CI: "set by CI providers; not configuration",
  NODE_ENV: "standard Node variable (documented in .env.example anyway)",
};

const SCAN_DIRS = ["server", path.join("src", "lib"), "scripts"];
const SCAN_FILES = ["playwright.config.ts", "server.ts", "vite.config.ts"];
const EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP = new Set(["node_modules", "dist", ".git"]);
const NAME = "[A-Z][A-Z0-9_]{2,}";
const USE_RES = [new RegExp(String.raw`process\.env\.(${NAME})`, "g"), new RegExp(String.raw`process\.env\[\s*["'](${NAME})["']\s*\]`, "g"), new RegExp(String.raw`(?<![\w.])env\.(${NAME})`, "g")];

export function envVarsUsed(root: string): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const add = (name: string, file: string) => used.set(name, [...(used.get(name) ?? []), file]);
  const scan = (p: string) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (SKIP.has(path.basename(p))) return;
      for (const f of fs.readdirSync(p)) scan(path.join(p, f));
    } else if (EXT.test(p)) {
      const text = fs.readFileSync(p, "utf8");
      for (const re of USE_RES) for (const m of text.matchAll(re)) add(m[1], path.relative(root, p).split(path.sep).join("/"));
    }
  };
  SCAN_DIRS.forEach((d) => scan(path.join(root, d)));
  SCAN_FILES.forEach((f) => scan(path.join(root, f)));
  return used;
}

export function documentedVars(envExample: string): Set<string> {
  const out = new Set<string>();
  for (const line of envExample.split(/\r?\n/)) {
    const m = new RegExp(String.raw`^#?\s*(${NAME})\s*[=:]`).exec(line);
    if (m) out.add(m[1]);
    // "SMTP_*:" style group headers document a prefix family
    const g = new RegExp(String.raw`^#\s*(${NAME.replace("{2,}", "{1,}")})_\*\s*:`).exec(line);
    if (g) out.add(g[1] + "_*");
  }
  return out;
}

export function missingVars(root: string): { name: string; files: string[] }[] {
  const used = envVarsUsed(root);
  const docs = documentedVars(fs.readFileSync(path.join(root, ".env.example"), "utf8"));
  const prefixes = [...docs].filter((d) => d.endsWith("_*")).map((d) => d.slice(0, -1));
  const out: { name: string; files: string[] }[] = [];
  for (const [name, files] of [...used].sort()) {
    if (docs.has(name) || name in ALLOWLIST || prefixes.some((p) => name.startsWith(p))) continue;
    out.push({ name, files: [...new Set(files)] });
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const missing = missingVars(root);
  if (missing.length) {
    console.error("check-docs: environment variables used in code but missing from .env.example:");
    for (const m of missing) console.error(`  ${m.name}  (${m.files.join(", ")})`);
    console.error("Add each to .env.example (commented, with its default and a one-line purpose) or justify it in scripts/check-docs.ts ALLOWLIST.");
    process.exit(1);
  }
  console.log("check-docs: .env.example documents every environment variable the code reads");
}
