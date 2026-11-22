import { describe, expect, it } from "vitest";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** PWA-lite budget (DESIGN_2028 3.9): the civic entry bundle, gzip, target about 150 KB; no map tiles. */
const BUDGET_BYTES = 150 * 1024;

describe("PWA-lite (@E2E-55)", () => {
  it("@E2E-55 civic entry bundle is under the 150 KB gzip budget and ships no map code", async () => {
    const out = (await build({
      configFile: false, logLevel: "silent", plugins: [react()],
      build: { write: false, minify: "esbuild", rollupOptions: { input: path.resolve("src/components/civic/lite-entry.tsx") } },
      define: { "process.env.NODE_ENV": '"production"' },
    })) as any;
    const outputs = (Array.isArray(out) ? out[0] : out).output as { type: string; fileName: string; code?: string }[];
    const js = outputs.filter((o) => o.type === "chunk");
    const gz = js.reduce((n, c) => n + gzipSync(c.code ?? "").length, 0);
    console.log(`civic lite bundle: ${(gz / 1024).toFixed(1)} KB gzip`);
    expect(gz).toBeGreaterThan(10_000); // sanity: it really bundled React
    expect(gz).toBeLessThan(BUDGET_BYTES);
    expect(js.map((c) => c.code).join("")).not.toMatch(/leaflet|tile\.openstreetmap/i);
  }, 120_000);

  it("service worker and manifest exist and never cache API or tiles", () => {
    expect(existsSync("public/civic.webmanifest")).toBe(true);
    const sw = readFileSync("public/civic-sw.js", "utf8");
    expect(sw).toMatch(/startsWith\("\/api\/"\)/);
    expect(sw).toMatch(/tile/);
    expect(JSON.parse(readFileSync("public/civic.webmanifest", "utf8")).display).toBe("standalone");
  });
});
