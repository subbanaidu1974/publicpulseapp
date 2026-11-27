import fs from "node:fs";
import path from "node:path";

// Rewrites tests/backend/legacy-sync-db-files.json from the server code (see tests/backend/syncDbGuard.test.ts). Run after a store is ported.
const ROOT = path.resolve(import.meta.dirname, "..");
const PATTERN = /node:sqlite|\.prepare\(|\bgetDb\(|\bgetStore\(/;
const out: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === "node_modules" || p === path.join(ROOT, "server", "data")) continue; walk(p); }
    else if (/\.ts$/.test(e.name) && PATTERN.test(fs.readFileSync(p, "utf8"))) out.push(path.relative(ROOT, p).replace(/\\/g, "/"));
  }
};
walk(path.join(ROOT, "server"));
out.sort();
fs.writeFileSync(path.join(ROOT, "tests", "backend", "legacy-sync-db-files.json"), JSON.stringify({ note: "Server files that still use the synchronous database handle. Only ever shrinks (tests/backend/syncDbGuard.test.ts).", files: out }, null, 2) + "\n");
console.log(out.length + " files");
