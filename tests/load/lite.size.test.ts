import { describe, expect, it } from "vitest";
import { build } from "vite";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** S-75 / E2E-90: first load of /lite (HTML + JS + CSS, real gzip of the built files) must stay within 150 KB; the Telugu font is separate and lazy. */
const BUDGET = 150 * 1024;

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

describe("lite page size budget (@E2E-90)", () => {
  it("@E2E-90 built lite.html + JS + CSS is under 150 KB gzip, has no map code, no third-party URLs and does not load the Telugu font eagerly", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "lite-build-"));
    try {
      await build({
        configFile: false, logLevel: "silent", publicDir: false, root: process.cwd(),
        build: { outDir: out, emptyOutDir: true, minify: "esbuild", modulePreload: { polyfill: false }, rollupOptions: { input: path.resolve("lite.html") } },
      });
      const files = walk(out);
      const html = files.filter((f) => f.endsWith(".html")), js = files.filter((f) => f.endsWith(".js")), css = files.filter((f) => f.endsWith(".css"));
      expect(html.length).toBe(1);
      expect(js.length).toBe(1); // one script, no shared chunk, no react
      const gz = [...html, ...js, ...css].reduce((n, f) => n + gzipSync(fs.readFileSync(f), { level: 9 }).length, 0);
      console.log(`lite first load: ${(gz / 1024).toFixed(1)} KB gzip (html+js+css), budget ${BUDGET / 1024} KB`);
      expect(gz).toBeGreaterThan(1000);
      expect(gz).toBeLessThan(BUDGET);
      const text = [...html, ...js, ...css].map((f) => fs.readFileSync(f, "utf8")).join("\n");
      expect(text).not.toMatch(/leaflet|tile\.openstreetmap|arcgisonline/i);
      expect(text).not.toMatch(/react-dom|createRoot/);
      // Third-party requests: no absolute http(s) URLs except XML namespaces.
      const urls = (text.match(/https?:\/\/[^\s"'`)<>]+/g) ?? []).filter((u) => !/^https?:\/\/(www\.w3\.org|localhost)/.test(u));
      expect(urls).toEqual([]);
      // The Telugu font is never in the HTML or CSS (so never fetched on first load); only the script can request it, after the language is chosen.
      expect(fs.readFileSync(html[0], "utf8")).not.toMatch(/woff2?|font/i);
      expect(css.map((f) => fs.readFileSync(f, "utf8")).join("")).not.toMatch(/@font-face|woff/i);
      expect(fs.readFileSync(js[0], "utf8")).toMatch(/NotoSansTelugu-subset\.woff2/);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  }, 120_000);

  it("@E2E-90 the self-hosted Telugu subset exists, is listed separately and the worker/manifest point at /lite", () => {
    expect(fs.existsSync("public/fonts/NotoSansTelugu-subset.woff2")).toBe(true);
    const man = JSON.parse(fs.readFileSync("public/civic.webmanifest", "utf8"));
    expect(man.start_url).toMatch(/^\/lite/);
    expect(man.display).toBe("standalone");
    const sw = fs.readFileSync("public/civic-sw.js", "utf8");
    expect(sw).toMatch(/"\/lite"/);
    expect(sw).toMatch(/startsWith\("\/api\/"\)/);
  });
});
