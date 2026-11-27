import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keyOf, keysFromInventory, openapiYaml, scanRoutes } from "../../scripts/route-inventory-lib";

const ROOT = path.resolve(__dirname, "../..");

describe("API contract matches the code (S-247) @E2E-249", () => {
  const { routes, unmapped } = scanRoutes(ROOT);
  it("every file that declares routes has a mount entry", () => {
    expect(unmapped, "add the file to MOUNT in scripts/route-inventory-lib.ts").toEqual([]);
  });
  it("docs/backend/ROUTE_INVENTORY.md lists exactly the routes in the code", () => {
    const doc = keysFromInventory(fs.readFileSync(path.join(ROOT, "docs/backend/ROUTE_INVENTORY.md"), "utf8")).sort();
    const code = routes.map(keyOf).sort();
    expect(code.filter((k) => !doc.includes(k)), "routes in code but not in the inventory: run npm run backend:contract").toEqual([]);
    expect(doc.filter((k) => !code.includes(k)), "routes in the inventory but not in code: run npm run backend:contract").toEqual([]);
  });
  it("docs/backend/openapi.routes.yaml is current", () => {
    const f = fs.readFileSync(path.join(ROOT, "docs/backend/openapi.routes.yaml"), "utf8").replace(/\r\n/g, "\n");
    expect(f).toBe(openapiYaml(routes));
  });
  it("the contract has a sane size and no duplicate operation", () => {
    expect(routes.length).toBeGreaterThan(300);
    const ops = openapiYaml(routes).match(/operationId: \S+/g) ?? [];
    expect(new Set(ops).size).toBe(ops.length);
  });
});
