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
import { sniff, stripJpeg, stripPng } from "../../server/civic/issues/media";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "civic-media-"));
process.env.CIVIC_MEDIA_DIR = dir;
process.env.CIVIC_PHOTO_MAX_BYTES = "4000";
process.env.CIVIC_VOICE_MAX_BYTES = "3000";

let server: Server, base: string;
const T0 = new Date("2026-03-01T10:00:00Z");

const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
/** Minimal structurally valid JPEG carrying EXIF with GPS, XMP, a comment, and a trailer after EOI. */
const jpeg = (pad = 100) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
  seg(0xe1, Buffer.from("Exif\0\0SECRET-GPS-16.2400N-80.1500E")),
  seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0SECRET-XMP")),
  seg(0xfe, Buffer.from("SECRET-COMMENT")),
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.alloc(pad, 0x11),
  Buffer.from([0xff, 0xd9]),
  Buffer.from("SECRET-TRAILER"),
]);
const crc = Buffer.alloc(4);
const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type, "latin1"), data, crc]); };
const png = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", Buffer.from("GPS\0SECRET-PNG-GPS")), chunk("eXIf", Buffer.from("SECRET-EXIF")),
  chunk("IDAT", Buffer.alloc(20, 7)), chunk("IEND", Buffer.alloc(0)),
]);
const wav = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(40, 1)]);
const withId3 = () => Buffer.concat([Buffer.from("ID3\x03\0\0\0\0\0\x0a"), Buffer.from("SECRET-TAG"), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(30, 2)]);

async function up(who: string, body: Buffer | string, headers: Record<string, string>, p = "/media") {
  const r = await fetch(base + p, { method: "POST", headers: { "x-person": who, ...headers }, body });
  return { status: r.status, body: (await r.json()) as any };
}
async function call(method: string, p: string, who: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-person": who }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const stored = (id: string) => fs.readdirSync(dir).filter((f) => f.startsWith(id));

beforeAll(async () => {
  const app = express();
  app.use(express.json()); // as server.ts does globally (100 kb): raw and multipart uploads are unaffected
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
  for (const f of fs.readdirSync(dir)) if (f !== ".gitignore") fs.rmSync(path.join(dir, f));
});

describe("photo and voice intake (S-24)", () => {
  it("strips EXIF/XMP/comments/trailers from JPEG and text chunks from PNG", () => {
    const j = stripJpeg(jpeg());
    expect(j.toString("latin1")).not.toMatch(/SECRET|Exif|xap/);
    expect(j.toString("latin1")).toContain("JFIF");
    expect([j[0], j[1], j[j.length - 2], j[j.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    const p = stripPng(png());
    expect(p.toString("latin1")).not.toMatch(/SECRET|tEXt|eXIf/);
    expect(p.toString("latin1")).toMatch(/IHDR[\s\S]*IDAT[\s\S]*IEND/);
    expect(() => stripJpeg(jpeg().subarray(0, 40))).toThrow();
    expect(() => stripPng(png().subarray(0, 30))).toThrow();
  });

  it("sniffs by magic bytes only", () => {
    expect(sniff(jpeg())?.mime).toBe("image/jpeg");
    expect(sniff(png())?.mime).toBe("image/png");
    expect(sniff(wav())?.mime).toBe("audio/wav");
    expect(sniff(Buffer.from("MZ\x90\0 this is an exe"))).toBeNull();
    expect(sniff(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(sniff(Buffer.from("<?php echo 1;"))).toBeNull();
  });

  it("raw upload: stored outside the DB with a random name, sanitised, retention-tagged, and attachable to a report", async () => {
    const r = await up("p1", jpeg(), { "content-type": "image/jpeg" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "photo", mime: "image/jpeg" });
    expect(r.body.ref).toBe(`media:${r.body.id}`);
    expect(r.body.id).toMatch(/^[0-9a-f]{32}$/);
    const files = stored(r.body.id);
    expect(files).toEqual([`${r.body.id}.jpg`]);
    const onDisk = fs.readFileSync(path.join(dir, files[0]));
    expect(onDisk.toString("latin1")).not.toMatch(/SECRET/);
    expect(onDisk.length).toBe(r.body.bytes + 32); // encrypted at rest: magic(4) + iv(12) + tag(16) + ciphertext
    expect(onDisk.subarray(0, 4).toString()).toBe("PPM1");
    const row = getStore("issues").prepare("SELECT * FROM issue_media WHERE id=?").get(r.body.id) as any;
    expect(row.file).toBe(`${r.body.id}.jpg`);
    expect(row).not.toHaveProperty("original_name");
    expect(Date.parse(row.retain_until) - Date.parse(row.created_at)).toBe(180 * 86400_000);
    expect(path.resolve(dir)).not.toContain(path.resolve("data", "civic.db"));
    const rep = await call("POST", "/", "p1", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Big pothole", photo_ref: r.body.ref });
    expect(rep.status).toBe(201);
    expect(getStore("issues").prepare("SELECT photo_ref, voice_ref FROM issue WHERE id=?").get(rep.body.id)).toMatchObject({ photo_ref: r.body.ref, voice_ref: null });
    expect((getStore("issues").prepare("SELECT issue_id FROM issue_media WHERE id=?").get(r.body.id) as any).issue_id).toBe(rep.body.id);
    // already attached: cannot be reused
    expect((await call("POST", "/", "p1", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Another one elsewhere", photo_ref: r.body.ref })).status).toBe(400);
  });

  it("accepts base64 JSON and multipart, PNG and voice notes (WAV, MP3 with ID3 tag removed)", async () => {
    const b64 = await up("p1", JSON.stringify({ data_base64: png().toString("base64"), mime: "image/png" }), { "content-type": "application/json" });
    expect(b64.status).toBe(201);
    expect(b64.body.mime).toBe("image/png");
    expect(fs.readFileSync(path.join(dir, stored(b64.body.id)[0])).toString("latin1")).not.toMatch(/SECRET/);

    const boundary = "----civicTest";
    const mp = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../evil.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg(), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const m = await up("p1", mp, { "content-type": `multipart/form-data; boundary=${boundary}` });
    expect(m.status).toBe(201);
    expect(stored(m.body.id)).toEqual([`${m.body.id}.jpg`]); // client filename is never used

    const v = await up("p1", wav(), { "content-type": "audio/wav" });
    expect(v).toMatchObject({ status: 201, body: { kind: "voice", mime: "audio/wav" } });
    const mp3 = await up("p1", withId3(), { "content-type": "audio/mpeg" });
    expect(mp3.status).toBe(201);
    expect(fs.readFileSync(path.join(dir, stored(mp3.body.id)[0])).toString("latin1")).not.toContain("SECRET-TAG");
    const rep = await call("POST", "/", "p1", { category: "water", village_lgd: "DEMO-V-KLR", description_te: "నీరు రావడం లేదు", voice_ref: v.body.ref });
    expect(rep.status).toBe(201);
    expect(getStore("issues").prepare("SELECT voice_ref, photo_ref FROM issue WHERE id=?").get(rep.body.id)).toMatchObject({ voice_ref: v.body.ref, photo_ref: null });
    // a voice file is not a photo
    expect((await call("POST", "/", "p1", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "x y z not duplicate", photo_ref: mp3.body.ref })).status).toBe(400);
  });

  it("rejects wrong types, mismatched declarations, oversize, corrupt and empty uploads", async () => {
    expect((await up("p1", Buffer.from("MZ\x90\0exe"), { "content-type": "image/jpeg" })).status).toBe(415);
    expect((await up("p1", Buffer.from("<script>alert(1)</script>"), { "content-type": "text/html" })).status).toBe(415);
    expect((await up("p1", wav(), { "content-type": "image/jpeg" })).status).toBe(415); // declared image, content is audio
    expect((await up("p1", jpeg(5000), { "content-type": "image/jpeg" })).status).toBe(413);
    expect((await up("p1", Buffer.concat([wav(), Buffer.alloc(4000)]), { "content-type": "audio/wav" })).status).toBe(413);
    expect((await up("p1", jpeg().subarray(0, 40), { "content-type": "image/jpeg" })).status).toBe(422);
    expect((await up("p1", JSON.stringify({ data_base64: "***not base64***" }), { "content-type": "application/json" })).status).toBe(400);
    expect((await up("p1", JSON.stringify({}), { "content-type": "application/json" })).status).toBe(400);
    expect((await up("", jpeg(), { "content-type": "image/jpeg" })).status).toBe(401);
    expect(fs.readdirSync(dir).filter((f) => f !== ".gitignore")).toEqual([]); // nothing was stored
  });

  it("enforces a per-person daily quota and ownership of references", async () => {
    process.env.CIVIC_MEDIA_PER_DAY = "2";
    try {
      expect((await up("p1", jpeg(), { "content-type": "image/jpeg" })).status).toBe(201);
      const second = await up("p1", jpeg(), { "content-type": "image/jpeg" });
      expect(second.status).toBe(201);
      expect((await up("p1", jpeg(), { "content-type": "image/jpeg" })).status).toBe(429);
      // someone else's upload cannot be attached to my report
      const rep = await call("POST", "/", "p2", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Hole in road", photo_ref: second.body.ref });
      expect(rep.status).toBe(400);
      expect((await call("POST", "/", "p2", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Hole in road", photo_ref: "media:" + "0".repeat(32) })).status).toBe(400);
    } finally { delete process.env.CIVIC_MEDIA_PER_DAY; }
  });

  it("serves a file to its owner only until it is attached to a visible issue; sends hardening headers", async () => {
    const r = await up("p1", jpeg(), { "content-type": "image/jpeg" });
    const get = (who: string) => fetch(`${base}/media/${r.body.id}`, { headers: { "x-person": who } });
    expect((await get("p2")).status).toBe(404);
    const own = await get("p1");
    expect(own.status).toBe(200);
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(own.headers.get("content-type")).toBe("image/jpeg");
    await call("POST", "/", "p1", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Big pothole", photo_ref: r.body.ref });
    expect((await get("p2")).status).toBe(200);
    expect((await fetch(`${base}/media/..%2F..%2Fetc%2Fpasswd`, { headers: { "x-person": "p1" } })).status).toBe(404);
  });

  it("purges at the retention date (and orphan uploads after a day), and on account erasure", async () => {
    const a = await up("p1", jpeg(), { "content-type": "image/jpeg" });
    await call("POST", "/", "p1", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: "Big pothole", photo_ref: a.body.ref });
    const orphan = await up("p1", wav(), { "content-type": "audio/wav" });
    const mine = await up("p9", jpeg(), { "content-type": "image/jpeg" });
    await call("POST", "/", "p9", { category: "water", village_lgd: "DEMO-V-BPL", description_en: "Dry tap here", photo_ref: mine.body.ref });

    expect(sweep(new Date(T0.getTime() + 3600_000)).mediaPurged).toBe(0);
    expect(sweep(new Date(T0.getTime() + 2 * 86400_000)).mediaPurged).toBe(1); // unattached orphan
    expect(stored(orphan.body.id)).toEqual([]);
    expect(stored(a.body.id)).toHaveLength(1);

    runErasureHooks("p9");
    expect(stored(mine.body.id)).toEqual([]);
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue_media WHERE owner_id='p9'").get()).toMatchObject({ c: 0 });

    expect(sweep(new Date(T0.getTime() + 181 * 86400_000)).mediaPurged).toBe(1); // retention elapsed
    expect(stored(a.body.id)).toEqual([]);
  });
});
