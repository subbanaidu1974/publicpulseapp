import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAudio, sha256File } from "../../scripts/audio-manifest-check";

describe("UT-audio-manifest-check (S-151)", () => {
  it("@E2E-166 the real repo: every prompt id has a script and the manifest stays placeholder", () => {
    expect(checkAudio(process.cwd())).toEqual([]);
    const m = JSON.parse(fs.readFileSync("data/civic/audio-manifest.json", "utf8"));
    // No recording exists yet; nothing may claim otherwise. A human flips this after a linguist signs off.
    const exists = fs.existsSync("public/audio");
    if (!exists) {
      expect(m.status).toBe("placeholder");
      for (const p of m.prompts) expect(p.status).toBe("placeholder");
    }
  });

  describe("synthetic repo", () => {
    let root: string;
    const write = (rel: string, text: string | Buffer) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
    const script = (id: string, formal = "ఒకటి") => ({ id, textTe: { formal, plain: "x", machineDraft: true }, textEn: "one", maxDurationSec: 3, dialects: { coastal: { needed: true } } });
    const setup = (prompt: Record<string, unknown>, status = "placeholder") => {
      write("server/civic/channels/routes.ts", "export const PROMPTS: Record<string, unknown> = {\n  a: { textTe: \"x\" },\n};\n");
      write("data/civic/audio-manifest.json", JSON.stringify({ status, dialects: ["coastal"], prompts: [{ id: "a", file: "audio/te/a.wav", textTe: "ఒకటి", ...prompt }] }));
      write("data/civic/audio-scripts/prompts.json", JSON.stringify({ prompts: [script("a")] }));
    };
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "audio-")); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("@E2E-166 passes for a placeholder with no file", () => {
      setup({ status: "placeholder" });
      expect(checkAudio(root)).toEqual([]);
    });

    it("@E2E-166 a file on disk does not change status: it stays placeholder until a human edits the manifest", () => {
      setup({ status: "placeholder" });
      write("public/audio/te/a.wav", Buffer.from("RIFF"));
      expect(checkAudio(root)).toEqual([]);
      const m = JSON.parse(fs.readFileSync(path.join(root, "data/civic/audio-manifest.json"), "utf8"));
      expect(m.prompts[0].status).toBe("placeholder");
    });

    it("@E2E-166 rejects recorded status without a file, without a hash, or with the wrong hash", () => {
      setup({ status: "recorded", sha256: "ab" });
      expect(checkAudio(root).join("\n")).toMatch(/does not exist/);
      write("public/audio/te/a.wav", Buffer.from("RIFFdata"));
      expect(checkAudio(root).join("\n")).toMatch(/sha256 does not match/);
      setup({ status: "recorded" });
      expect(checkAudio(root).join("\n")).toMatch(/no sha256/);
    });

    it("@E2E-166 accepts recorded with a matching sha256 and requires sign-off for reviewed", () => {
      write("public/audio/te/a.wav", Buffer.from("RIFFdata"));
      const h = sha256File(path.join(root, "public/audio/te/a.wav"));
      setup({ status: "recorded", sha256: h });
      expect(checkAudio(root)).toEqual([]);
      setup({ status: "reviewed", sha256: h });
      expect(checkAudio(root).join("\n")).toMatch(/signoff/);
      setup({ status: "reviewed", sha256: h, signoff: { reviewer: "R", date: "2026-01-01", formRef: "F1" } }, "reviewed");
      expect(checkAudio(root)).toEqual([]);
    });

    it("@E2E-166 rejects a placeholder that carries a hash, a missing script, a drifted text, and a premature reviewed manifest", () => {
      setup({ status: "placeholder", sha256: "abc" });
      expect(checkAudio(root).join("\n")).toMatch(/placeholder but a sha256/);
      setup({ status: "placeholder" });
      write("data/civic/audio-scripts/prompts.json", JSON.stringify({ prompts: [script("a", "వేరే")] }));
      expect(checkAudio(root).join("\n")).toMatch(/differs from manifest/);
      write("data/civic/audio-scripts/prompts.json", JSON.stringify({ prompts: [] }));
      expect(checkAudio(root).join("\n")).toMatch(/no script/);
      setup({ status: "placeholder" }, "reviewed");
      expect(checkAudio(root).join("\n")).toMatch(/manifest status is reviewed/);
    });

    it("@E2E-166 an IVR prompt missing from the manifest is reported", () => {
      setup({ status: "placeholder" });
      write("server/civic/channels/routes.ts", "export const PROMPTS: Record<string, unknown> = {\n  a: { textTe: \"x\" },\n  b: { textTe: \"y\" },\n};\n");
      expect(checkAudio(root).join("\n")).toMatch(/b: IVR prompt missing/);
    });
  });
});
