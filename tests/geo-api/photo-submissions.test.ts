import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApiRouter, loadDatasets } from "../../server/api";
import { getDb, migrate } from "../../server/civic/core";
import { sniff, stripMetadata } from "../../server/photo-submissions";

// S-200: people can send a photo for a constituency page; nothing is shown until an admin approves it; metadata is removed.
const jpeg = (extra: Buffer = Buffer.alloc(0)) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  extra,
  Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9]),
]);
const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x1c]), Buffer.from("Exif\0\0GPSLATITUDE-SECRET!!", "latin1")]);

describe("sniff and stripMetadata", () => {
  it("recognises only JPEG and PNG by their bytes", () => {
    expect(sniff(jpeg())?.mime).toBe("image/jpeg");
    expect(sniff(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]))?.mime).toBe("image/png");
    expect(sniff(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(8), Buffer.from("WEBP")]))).toBeNull();
  });
  it("removes EXIF and keeps the picture data", () => {
    const withExif = jpeg(exif);
    expect(withExif.includes("GPSLATITUDE")).toBe(true);
    const clean = stripMetadata(withExif, "image/jpeg")!;
    expect(clean.includes("GPSLATITUDE")).toBe(false);
    expect(clean.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(clean.length).toBe(jpeg().length);
  });
  it("refuses a malformed file", () => { expect(stripMetadata(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(30, 1)]), "image/jpeg")).toBeNull(); });
});

describe("photo submissions API", () => {
  let server: Server, base = "", dir = "";
  const meta = (o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ state: "TG", acNo: 5, relationship: "candidate", claimedName: "A Person", holder: "Photo: A Person", contact: "person@example.org", consent: true, ...o })).toString("base64");
  const send = (body: Buffer | string, m: string, type = "image/jpeg") => fetch(`${base}/photos/submissions`, { method: "POST", headers: { "Content-Type": type, "X-Photo-Meta": m }, body: body as BodyInit });
  beforeAll(async () => {
    process.env.PEOPLE_BLACKOUT = "0";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-sub-"));
    process.env.PHOTO_SUBMISSIONS_DIR = dir;
    migrate();
    const app = express();
    app.use("/api/v1", createApiRouter(loadDatasets()));
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => { server.close(); delete process.env.PEOPLE_BLACKOUT; delete process.env.PHOTO_SUBMISSIONS_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it("refuses without consent, with a wrong type, an unknown seat, or missing details", async () => {
    expect((await send(jpeg(), meta({ consent: false }))).status).toBe(400);
    expect((await send(Buffer.from("<script>alert(1)</script>".padEnd(40, " ")), meta())).status).toBe(415);
    expect((await send(jpeg(), meta({ acNo: 9999 }))).status).toBe(404);
    expect((await send(jpeg(), meta({ contact: "" }))).status).toBe(400);
    expect((await send(jpeg(), meta({ relationship: "fan" }))).status).toBe(400);
    expect((await send(Buffer.alloc(2_100_000, 1), meta())).status).toBe(413);
  });
  it("silently accepts a honeypot fill without storing anything", async () => {
    const before = (getDb().prepare("SELECT COUNT(*) AS n FROM photo_submissions").get() as { n: number }).n;
    expect((await send(jpeg(), meta({ website: "http://spam.example" }))).status).toBe(202);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM photo_submissions").get() as { n: number }).n).toBe(before);
  });
  it("stores a pending photo without metadata, hides it from everyone, and shows it only after approval", async () => {
    const r = await send(jpeg(exif), meta());
    expect(r.status).toBe(201);
    const { id } = await r.json() as { id: string };
    const stored = fs.readdirSync(dir).filter((f) => f.startsWith(id));
    expect(stored.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, stored[0])).includes("GPSLATITUDE")).toBe(false);
    const row = getDb().prepare("SELECT * FROM photo_submissions WHERE id = ?").get(id) as Record<string, string>;
    expect(row.status).toBe("pending");
    expect(row.contact_enc).not.toContain("person@example.org");
    const listed = async () => ((await (await fetch(`${base}/photos/index.json`)).json()) as { photos: { file: string; acNo: number; state: string; origin?: string }[] }).photos;
    expect((await listed()).some((p) => p.origin === "upload")).toBe(false);
    expect((await fetch(`${base}/photos/upload-${id}.jpg`)).status).toBe(404);
    // the queue needs an admin
    expect((await fetch(`${base}/photos/admin/submissions`)).status).toBe(401);
    // approval (done directly in the store: the admin sign-in is covered by the civic tests)
    getDb().prepare("UPDATE photo_submissions SET status = 'approved', decided_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    const up = (await listed()).find((p) => p.origin === "upload")!;
    expect(up).toMatchObject({ state: "TG", acNo: 5, file: `upload-${id}.jpg` });
    expect((await fetch(`${base}/photos/upload-${id}.jpg`)).status).toBe(200);
    // the pause hides it again
    process.env.PEOPLE_BLACKOUT = "1";
    try { expect((await fetch(`${base}/photos/upload-${id}.jpg`)).status).toBe(404); } finally { process.env.PEOPLE_BLACKOUT = "0"; }
  });
});
