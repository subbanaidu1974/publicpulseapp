import fs from "node:fs";
import path from "node:path";

/**
 * Route inventory (S-247): every Express route declared in server/, with the mount it lives under. The inventory in
 * docs/backend/ROUTE_INVENTORY.md and the OpenAPI paths in docs/backend/openapi.routes.yaml are generated from this, and
 * tests/backend/routeInventory.test.ts fails when the code and the committed files disagree, so a route cannot be added, removed or moved
 * without the contract being regenerated (`npm run backend:contract`).
 */
export const MOUNT: Record<string, string> = {
  "server/civic/identity/routes.ts": "/api/v1/civic/identity", "server/civic/identity/email.ts": "/api/v1/civic/identity",
  "server/civic/households/routes.ts": "/api/v1/civic/households", "server/civic/geo/routes.ts": "/api/v1/civic/geo",
  "server/civic/issues/routes.ts": "/api/v1/civic/issues", "server/civic/channels/routes.ts": "/api/v1/civic/channels",
  "server/civic/scope/routes.ts": "/api/v1/civic/scope", "server/civic/admin/routes.ts": "/api/v1/civic/admin (and /audit)",
  "server/civic/broadcast/index.ts": "/api/v1/civic/broadcast", "server/civic/videocast/index.ts": "/api/v1/civic/videocast",
  "server/civic/mediahub/index.ts": "/api/v1/civic/media", "server/civic/officers/index.ts": "/api/v1/civic/officers",
  "server/civic/representatives/index.ts": "/api/v1/civic/representatives", "server/civic/assisted/routes.ts": "/api/v1/civic/assisted",
  "server/civic/notify/routes.ts": "/api/v1/civic/notify", "server/civic/consultations/registry.ts": "/api/v1/civic/consultations",
  "server/civic/consultations/report.ts": "/api/v1/civic/consultations", "server/civic/consultations/feedback.ts": "/api/v1/civic/consultations",
  "server/civic/consultations/staff.ts": "/api/v1/civic/consultations", "server/civic/surveys/registry.ts": "/api/v1/civic/surveys",
  "server/civic/surveys/credential.ts": "/api/v1/civic/surveys", "server/civic/surveys/results.ts": "/api/v1/civic/surveys",
  "server/civic/demo.ts": "/api/v1/civic/demo (dev only)", "server/civic/e2e-seed.ts": "/api/v1/civic/e2e (test only)", "server/civic/index.ts": "/api/v1/civic", "server/civic/providers/sms.ts": "/api/v1/civic/channels/sms-receipt",
  "server/api.ts": "/api/v1 (public)", "server/analytics-api.ts": "/api/v1 (public)", "server/geo-api.ts": "/api/v1 (public)",
  "server/people-api.ts": "/api/v1 (public)", "server/history/api.ts": "/api/v1 (public)", "server/countday/router.ts": "/api/v1/countday",
  "server/photo-submissions.ts": "/api/v1 (public)", "server/refresh.ts": "/api/v1 (ops)", "server/obs.ts": "/ (ops)", "server/basemap.ts": "/ (static map)",
};
const DOMAIN: Record<string, string> = {
  identity: "Identity and sessions", households: "Households", geo: "Geography", issues: "Issues (citizen reports)", channels: "Phone channels (missed call, IVR, voice note)",
  scope: "Role dashboards", admin: "Admin and audit", broadcast: "Broadcast polls", videocast: "Video broadcasts", mediahub: "Media hub (news, live, reports)",
  officers: "Officer onboarding", representatives: "Representatives", assisted: "Assisted participation", notify: "Government notifications",
  consultations: "Bill consultations", surveys: "Pulse surveys",
};
const RX = /\b(?:r|router|api|app|[a-zA-Z]+Router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

export interface Route { file: string; method: string; path: string; mount: string; group: string }

const groupOf = (rel: string): string => (rel.startsWith("server/civic/") ? (DOMAIN[rel.split("/")[2]] ?? rel.split("/")[2]) : "Public data and ops");

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); } else if (e.name.endsWith(".ts")) out.push(p);
  }
}

/** Routes declared in mapped files, plus the unmapped files that also declare routes (a new router that needs a MOUNT entry). */
export function scanRoutes(root: string): { routes: Route[]; unmapped: string[] } {
  const files: string[] = [];
  walk(path.join(root, "server"), files);
  const routes: Route[] = []; const unmapped: string[] = [];
  for (const f of files.sort()) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    const src = fs.readFileSync(f, "utf8");
    const found = [...src.matchAll(RX)];
    if (!found.length) continue;
    if (!MOUNT[rel]) { unmapped.push(rel); continue; }
    for (const m of found) routes.push({ file: rel, method: m[1].toUpperCase(), path: m[2], mount: MOUNT[rel], group: groupOf(rel) });
  }
  routes.sort((a, b) => a.group.localeCompare(b.group) || a.file.localeCompare(b.file) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { routes, unmapped };
}

export const keyOf = (r: Route): string => `${r.method} ${r.mount} ${r.path} ${r.file}`;

export function inventoryMarkdown(routes: Route[]): string {
  const by = new Map<string, Route[]>();
  for (const r of routes) by.set(r.group, [...(by.get(r.group) ?? []), r]);
  const out = ["# Route inventory (generated)", "", "Generated from the route declarations in `server/` by `npm run backend:contract` (scripts/route-inventory.ts). It lists what exists today; it is the baseline the backend stories must keep working (or version) when the database moves to MySQL. Do not edit by hand: `tests/backend/routeInventory.test.ts` fails when this file and the code disagree.", "", `Total: ${routes.length} routes in ${by.size} groups.`, ""];
  for (const [g, rs] of by) {
    out.push(`## ${g} (${rs.length})`, "", "| Method | Path (relative to mount) | Mount | Source |", "|---|---|---|---|");
    for (const r of rs) out.push(`| ${r.method} | \`${r.path}\` | \`${r.mount}\` | \`${r.file}\` |`);
    out.push("");
  }
  return out.join("\n");
}

/** Parse the inventory table back into route keys (what the test compares with a fresh scan). */
export function keysFromInventory(md: string): string[] {
  const keys: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]*)` \| `([^`]*)` \| `([^`]*)` \|$/.exec(line);
    if (m) keys.push(`${m[1]} ${m[3]} ${m[2]} ${m[4]}`);
  }
  return keys;
}

const opId = (r: Route): string => (r.method.toLowerCase() + "_" + (r.mount + r.path).replace(/\(.*?\)/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")).slice(0, 120);

/** OpenAPI 3 paths for every route. Request and response shapes are not derived from code: each operation carries the standard error responses and
 * `x-auth: unclassified` until story S-263 labels it, and the hand-written shared rules and media endpoints stay in openapi.yaml. */
export function openapiYaml(routes: Route[]): string {
  const paths = new Map<string, Route[]>();
  for (const r of routes) {
    if (!r.mount.startsWith("/api/v1")) continue; // ops and static routes are not part of the public contract
    const base = r.mount.replace(/ \(.*\)$/, "").replace(/^\/api\/v1/, "");
    const full = (base + (r.path === "/" ? "" : r.path)).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}") || "/";
    paths.set(full, [...(paths.get(full) ?? []), r]);
  }
  const lines = ["# GENERATED by scripts/route-inventory.ts (npm run backend:contract). Do not edit by hand.", "# Paths of every route under /api/v1 in the code. Shapes are added by hand in openapi.yaml; auth labels come with S-263.",
    "openapi: 3.0.3", "info:", "  title: People Pulse API (routes in code)", "  version: 1.0.0-routes", "servers:", "  - url: /api/v1", "paths:"];
  for (const [p, rs] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${JSON.stringify(p)}:`);
    const params = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const seen = new Set<string>();
    for (const r of rs) {
      const m = r.method.toLowerCase();
      if (seen.has(m)) continue; seen.add(m);
      lines.push(`    ${m}:`, `      operationId: ${opId(r)}`, `      tags: [${JSON.stringify(r.group)}]`, "      x-auth: unclassified", `      x-source: ${JSON.stringify(r.file)}`);
      if (params.length) { lines.push("      parameters:"); for (const n of params) lines.push(`        - { name: ${n}, in: path, required: true, schema: { type: string } }`); }
      lines.push("      responses:", "        \"200\": { description: Success }", "        \"4XX\": { $ref: \"./openapi.yaml#/components/responses/Error\" }");
    }
  }
  return lines.join("\n") + "\n";
}
