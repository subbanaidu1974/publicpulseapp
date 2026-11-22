import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getDb, migrate, resetDbForTests, runErasureHooks, getStore } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createIssuesRouter } from "../../server/civic/issues/routes";
import { clock, sweep } from "../../server/civic/issues/service";
import {
  HeuristicScanner, NoopScanner, decryptMedia, encryptMedia, getMedia, imageDimensions, mediaRetentionDays, readMediaFile, retentionPolicy, roundCoord,
  setMediaScanner, sniff, unsupportedImage,
} from "../../server/civic/issues/media";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "civic-media-fmt-"));
process.env.CIVIC_MEDIA_DIR = dir;
process.env.CIVIC_PHOTO_MAX_BYTES = "20000";
process.env.CIVIC_PHOTO_MAX_DIM = "4000";

let server: Server, base: string;
const T0 = new Date("2026-03-01T10:00:00Z");

const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
/** Tiny JPEG with a SOF0 header carrying the given size, EXIF with GPS, and a trailer. */
const jpeg = (w = 640, h = 480) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
  seg(0xe1, Buffer.from("Exif\0\0SECRET-GPS-16.2400N-80.1500E")),
  seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])),
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.alloc(60, 0x11), Buffer.from([0xff, 0xd9]), Buffer.from("SECRET-TRAILER"),
]);
const crc = Buffer.alloc(4);
const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type, "latin1"), data, crc]); };
const png = (w = 32, h = 32) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.alloc(20, 7)), chunk("IEND", Buffer.alloc(0))]); };
/** Tiny container fixtures: only the magic bytes matter to the server. */
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(30, 3)]);
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(12, 0)]);
const wav = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(40, 1)]);

async function up(who: string, body: Buffer | string, headers: Record<string, string>) {
  const r = await fetch(base + "/media", { method: "POST", headers: { "x-person": who, ...headers }, body });
  return { status: r.status, body: (await r.json()) as any };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/issues", createIssuesRouter((req, res, next) => {
    const p = req.header("x-person");
    if (!p) return void res.status(401).json({ error: "auth" });
    req.person = { id: p, tier: "T1" }; next();
  }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/issues`;
});
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  resetDbForTests(); migrate(); loadDemoGeo();
  clock.now = () => T0;
  setMediaScanner(null);
  for (const f of fs.readdirSync(dir)) if (f !== ".gitignore") fs.rmSync(path.join(dir, f));
});

describe("WebP and HEIC/HEIF photos (S-138)", () => {
  it("@E2E-153 recognises WebP, HEIC/HEIF and AVIF by magic bytes, never by the declared type", () => {
    expect(unsupportedImage(webp())).toMatchObject({ format: "webp", mime: "image/webp" });
    for (const b of ["heic", "heix", "hevc", "mif1", "msf1"]) expect(unsupportedImage(ftyp(b))).toMatchObject({ format: "heic" });
    expect(unsupportedImage(ftyp("avif"))).toMatchObject({ format: "avif" });
    expect(unsupportedImage(ftyp("M4A "))).toBeNull(); // real audio keeps working
    expect(unsupportedImage(wav())).toBeNull();
    expect(sniff(webp())).toBeNull();
    expect(sniff(ftyp("heic"))).toBeNull();
    expect(sniff(ftyp("M4A "))).toMatchObject({ mime: "audio/mp4" });
  });

  it("@E2E-153 refuses WebP/HEIC/AVIF with 415 and code convert_on_client plus a pointer to the client re-encode spec", async () => {
    for (const [file, mime, detected] of [[webp(), "image/webp", "image/webp"], [ftyp("heic"), "image/heic", "image/heic"], [ftyp("mif1"), "image/heif", "image/heic"], [ftyp("avif"), "image/avif", "image/avif"]] as const) {
      const r = await up("p1", file, { "content-type": mime });
      expect(r.status).toBe(415);
      expect(r.body).toMatchObject({ code: "convert_on_client", detected, convert_to: "image/jpeg" });
      expect(r.body.client_spec).toBe("data/civic/client-media-spec.json");
    }
    // a lying content type does not help: the bytes decide
    expect((await up("p1", webp(), { "content-type": "image/jpeg" })).body.code).toBe("convert_on_client");
    expect(fs.readdirSync(dir).filter((f) => f !== ".gitignore")).toEqual([]);
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue_media").get()).toMatchObject({ c: 0 });
  });

  it("@E2E-153 the client re-encode spec exists and names the helper, the canvas steps and the error handling", () => {
    const spec = JSON.parse(fs.readFileSync("data/civic/client-media-spec.json", "utf8"));
    expect(spec.helper.name).toBe("reencodeToJpeg");
    expect(spec.helper.steps.join(" ")).toMatch(/createImageBitmap/);
    expect(spec.helper.steps.join(" ")).toMatch(/toBlob\('image\/jpeg'/);
    expect(spec.helper.errors_to_handle).toHaveProperty("415 convert_on_client");
  });

  it("@E2E-153 JPEG and PNG pass; EXIF/GPS is stripped; dimensions come from the header", async () => {
    expect(imageDimensions(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(png(32, 16), "image/png")).toEqual({ width: 32, height: 16 });
    const r = await up("p1", jpeg(), { "content-type": "image/jpeg" });
    expect(r.status).toBe(201);
    const row = getMedia(r.body.id)!;
    const plain = readMediaFile(row)!;
    expect(plain.toString("latin1")).not.toMatch(/SECRET|Exif/);
    expect((await up("p1", png(), { "content-type": "image/png" })).status).toBe(201);
  });

  it("@E2E-153 refuses oversize dimensions and oversize files", async () => {
    const big = await up("p1", jpeg(5000, 100), { "content-type": "image/jpeg" });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ code: "dimensions_too_large", width: 5000, max_side: 4000 });
    expect((await up("p1", png(4001, 10), { "content-type": "image/png" })).body.code).toBe("dimensions_too_large");
    process.env.CIVIC_PHOTO_MAX_PIXELS = "10000";
    try { expect((await up("p1", jpeg(200, 200), { "content-type": "image/jpeg" })).body.code).toBe("dimensions_too_large"); } finally { delete process.env.CIVIC_PHOTO_MAX_PIXELS; }
    const huge = Buffer.concat([jpeg(), Buffer.alloc(25000, 1)]);
    expect([413, 422]).toContain((await up("p1", huge, { "content-type": "image/jpeg" })).status);
  });
});

describe("media hardening (S-147)", () => {
  it("@E2E-162 files are AES-256-GCM encrypted at rest, bound to their id, and tampering is detected", async () => {
    const r = await up("p1", jpeg(), { "content-type": "image/jpeg" });
    const file = path.join(dir, `${r.body.id}.jpg`);
    const onDisk = fs.readFileSync(file);
    expect(onDisk.subarray(0, 4).toString()).toBe("PPM1");
    expect(onDisk.subarray(4).includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false); // no JPEG signature visible
    expect(readMediaFile(getMedia(r.body.id)!)!.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // the id is the AAD: a ciphertext moved under another id does not decrypt
    expect(() => decryptMedia(onDisk, "0".repeat(32))).toThrow();
    const bad = Buffer.from(onDisk); bad[bad.length - 1] ^= 1;
    fs.writeFileSync(file, bad);
    expect(readMediaFile(getMedia(r.body.id)!)).toBeNull();
    // round trip with the explicit key from the environment
    process.env.CIVIC_MEDIA_KEY = "unit-test-key";
    try {
      const enc = encryptMedia(Buffer.from("hello"), "abc");
      expect(decryptMedia(enc, "abc").toString()).toBe("hello");
    } finally { delete process.env.CIVIC_MEDIA_KEY; }
  });

  it("@E2E-162 a legacy plaintext file written before encryption still reads", () => {
    expect(decryptMedia(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "x")).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("@E2E-162 the heuristic scanner refuses scripts, executables and the EICAR string hidden in valid-looking media", async () => {
    const sc = new HeuristicScanner();
    const ctx = { kind: "photo" as const, mime: "image/jpeg" };
    expect(sc.scan(jpeg(), ctx)).toEqual({ ok: true });
    expect(sc.scan(Buffer.concat([jpeg(), Buffer.from("<script>alert(1)</script>")]), ctx)).toMatchObject({ ok: false, reason: "embedded_script" });
    expect(sc.scan(Buffer.concat([jpeg(), Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]), ctx)).toMatchObject({ ok: false, reason: "eicar" });
    expect(sc.scan(Buffer.from("MZ\x90\0" + "x".repeat(100)), ctx)).toMatchObject({ ok: false, reason: "executable_or_container" });
    // over the wire: a script appended inside a JPEG comment is refused (default scanner = heuristic) and audited
    const evil = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xfe, Buffer.from("<?php system($_GET[1]); ?>")), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.alloc(20, 1), Buffer.from([0xff, 0xd9])]);
    const r = await up("p1", evil, { "content-type": "image/jpeg" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("scan_rejected");
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action='issue.media_rejected'").get()).toMatchObject({ c: 1 });
    expect(fs.readdirSync(dir).filter((f) => f !== ".gitignore")).toEqual([]);
  });

  it("@E2E-162 the scanner is a hook: a custom (async) scanner can reject, and one that throws fails closed", async () => {
    setMediaScanner({ name: "clamav-stub", scan: async (d) => (d.includes(Buffer.from("VIRUS")) ? { ok: false, reason: "Eicar-Signature" } : { ok: true }) });
    expect((await up("p1", Buffer.concat([jpeg(), Buffer.from("VIRUS")]), { "content-type": "image/jpeg" })).body.code).toBe("scan_rejected");
    expect((await up("p1", jpeg(), { "content-type": "image/jpeg" })).status).toBe(201);
    setMediaScanner({ name: "down", scan: () => { throw new Error("clamd unreachable"); } });
    const down = await up("p1", jpeg(), { "content-type": "image/jpeg" });
    expect(down.status).toBe(503);
    expect(down.body.code).toBe("scanner_unavailable");
    setMediaScanner(new NoopScanner());
    expect((await up("p1", Buffer.concat([jpeg(), Buffer.from("<script>")]), { "content-type": "image/jpeg" })).status).toBe(201); // no-op dev scanner lets it through
  });

  it("@E2E-162 retention follows data/civic/retention-policy.json (aligned with docs/RETENTION.md) and purges on schedule", async () => {
    const pol = retentionPolicy();
    expect(pol.ref).toBe("docs/RETENTION.md");
    expect(mediaRetentionDays()).toBe(pol.media_days);
    expect(fs.readFileSync("docs/RETENTION.md", "utf8")).toMatch(/Issue reports/);
    const r = await up("p1", jpeg(), { "content-type": "image/jpeg" });
    expect(Date.parse(r.body.retain_until) - T0.getTime()).toBe(pol.media_days * 86400_000);
    getStore("issues").prepare("UPDATE issue_media SET issue_id='some-issue' WHERE id=?").run(r.body.id); // attached, so only the retention date applies
    clock.now = () => new Date(T0.getTime() + (pol.media_days - 1) * 86400_000);
    expect(sweep().mediaPurged).toBe(0);
    clock.now = () => new Date(T0.getTime() + (pol.media_days + 1) * 86400_000);
    expect(sweep().mediaPurged).toBe(1);
    expect(fs.existsSync(path.join(dir, `${r.body.id}.jpg`))).toBe(false);
  });

  it("@E2E-162 account erasure deletes the person's media files", async () => {
    const r = await up("gone", jpeg(), { "content-type": "image/jpeg" });
    const keep = await up("stays", jpeg(), { "content-type": "image/jpeg" });
    runErasureHooks("gone");
    expect(getMedia(r.body.id)).toBeNull();
    expect(fs.existsSync(path.join(dir, `${r.body.id}.jpg`))).toBe(false);
    expect(getMedia(keep.body.id)).not.toBeNull();
  });

  it("@E2E-162 GPS rounding helper", () => {
    expect(roundCoord(16.240493)).toBe(16.24);
    expect(roundCoord(80.150517)).toBe(80.151);
    expect(roundCoord(-0.0004)).toBeCloseTo(0, 6);
  });
});
