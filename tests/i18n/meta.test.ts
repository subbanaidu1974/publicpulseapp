import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MESSAGES } from "../../src/i18n";

const html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
const css = fs.readFileSync(path.join(process.cwd(), "src", "index.css"), "utf8");

describe("metadata and third-party requests (S-127, S-130)", () => {
  it("@E2E-142 index.html has title, description, Open Graph and Twitter tags matching the English strings", () => {
    expect(html).toContain(`<title>${MESSAGES.en["meta.title"]}</title>`);
    for (const p of ["og:title", "og:description", "og:type", "og:site_name", "og:locale", "og:locale:alternate"]) expect(html, p).toContain(`property="${p}"`);
    for (const n of ["description", "twitter:card", "twitter:title", "twitter:description"]) expect(html, n).toContain(`name="${n}"`);
    expect(html).toContain(MESSAGES.en["meta.description"]);
  });
  it("@E2E-142 titles and descriptions exist per language and differ", () => {
    expect(MESSAGES.te["meta.title"]).not.toBe(MESSAGES.en["meta.title"]);
    expect(MESSAGES.te["meta.description"]).not.toBe(MESSAGES.en["meta.description"]);
    expect(MESSAGES.en["meta.locale"]).toBe("en_IN");
    expect(MESSAGES.te["meta.locale"]).toBe("te_IN");
  });
  it("@E2E-142 no AI Studio leftovers in the page shell", () => {
    expect(html).not.toMatch(/ai studio|aistudio|gemini/i);
  });
  it("@E2E-145 the page shell and stylesheet make no Google Fonts requests and ship a woff2 with swap", () => {
    expect(html + css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(css).toMatch(/@font-face[\s\S]*font-display:\s*swap/);
    expect(css).toMatch(/url\("\/fonts\/NotoSansTelugu-subset\.woff2"\)/);
    const font = path.join(process.cwd(), "public", "fonts", "NotoSansTelugu-subset.woff2");
    expect(fs.existsSync(font)).toBe(true);
    const buf = fs.readFileSync(font);
    expect(buf.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(buf.length).toBeLessThan(200 * 1024);
    expect(fs.readFileSync(path.join(process.cwd(), "public", "fonts", "LICENSE"), "utf8")).toMatch(/SIL OPEN FONT LICENSE/);
  });
  it("@E2E-145 the font fallback stack covers Latin system fonts and a Telugu system font", () => {
    expect(css).toMatch(/--font-sans:[^;]*system-ui[^;]*Nirmala UI/);
  });
  it("@E2E-145 no source file loads fonts from a third party", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(path.join(process.cwd(), "src")).filter((p) => /\.(tsx?|css)$/.test(p))) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
});
