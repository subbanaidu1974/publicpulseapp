import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ratchet for the move to the async data layer (S-248). Server code that still reaches the database through the synchronous legacy handle
 * (node:sqlite, .prepare(, getDb(, getStore() is listed in legacy-sync-db-files.json. NEW code must use server/data; a listed file that no longer
 * matches must be removed from the list, so the list only ever shrinks. Run `npx tsx scripts/sync-db-allowlist.ts` after a port story to rewrite it.
 */
const ROOT = path.resolve(__dirname, "../..");
const LIST = path.join(__dirname, "legacy-sync-db-files.json");
/** The bridge between legacy sync code and the async layer is the one allowed exception (see its header). */
const BRIDGE = ["server/civic/core/asyncBridge.ts"];
const PATTERN = /node:sqlite|\.prepare\(|\bgetDb\(|\bgetStore\(/;

export function scan(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name === "node_modules" || p === path.join(ROOT, "server", "data")) continue; walk(p); }
      else if (/\.ts$/.test(e.name) && !BRIDGE.includes(path.relative(ROOT, p).replace(/\\/g, "/")) && PATTERN.test(fs.readFileSync(p, "utf8"))) out.push(path.relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  walk(path.join(ROOT, "server"));
  return out.sort();
}

describe("synchronous database use only shrinks (S-248) @E2E-248", () => {
  const allowed: string[] = JSON.parse(fs.readFileSync(LIST, "utf8")).files;
  const now = scan();
  it("no new server file reaches the database through the synchronous handle", () => {
    expect(now.filter((f) => !allowed.includes(f)), "use server/data (Db) in new code").toEqual([]);
  });
  it("a file that moved to the data layer is removed from the list", () => {
    expect(allowed.filter((f) => !now.includes(f)), "remove these from tests/backend/legacy-sync-db-files.json").toEqual([]);
  });
});
