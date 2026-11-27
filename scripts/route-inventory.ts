import fs from "node:fs";
import path from "node:path";
import { inventoryMarkdown, openapiYaml, scanRoutes } from "./route-inventory-lib";

// Regenerates docs/backend/ROUTE_INVENTORY.md and docs/backend/openapi.routes.yaml from server/ (S-247). `--check` only verifies they are current.
const ROOT = path.resolve(import.meta.dirname, "..");
const { routes, unmapped } = scanRoutes(ROOT);
if (unmapped.length) { console.error("route files with no MOUNT entry in scripts/route-inventory-lib.ts:\n  " + unmapped.join("\n  ")); process.exit(1); }
const md = inventoryMarkdown(routes), yaml = openapiYaml(routes);
const f1 = path.join(ROOT, "docs/backend/ROUTE_INVENTORY.md"), f2 = path.join(ROOT, "docs/backend/openapi.routes.yaml");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
if (process.argv.includes("--check")) {
  const stale = [[f1, md], [f2, yaml]].filter(([f, c]) => !fs.existsSync(f) || norm(fs.readFileSync(f, "utf8")) !== norm(c));
  if (stale.length) { console.error("stale (run npm run backend:contract): " + stale.map(([f]) => path.relative(ROOT, f)).join(", ")); process.exit(1); }
  console.log(`route inventory current (${routes.length} routes)`);
} else {
  fs.writeFileSync(f1, md + "\n"); fs.writeFileSync(f2, yaml);
  console.log(`wrote ${routes.length} routes`);
}
