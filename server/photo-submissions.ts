/**
 * Photo self-upload (S-200), mounted under /api/v1 by server/api.ts.
 *   POST /photos/submissions                    public: the raw image (image/jpeg or image/png, up to 2 MB) with the details in the
 *                                               X-Photo-Meta header (base64 of JSON; kept out of the URL). Rate limited, honeypot.
 *   GET  /photos/admin/submissions[?status=]    admin: the queue, with the contact decrypted
 *   GET  /photos/admin/submissions/:id/file     admin: the submitted image, to look at before deciding
 *   POST /photos/admin/submissions/:id/decide   admin: {status: "approved" | "rejected", note?}
 * Nothing is shown until an admin approves it. There is NO automatic identity check: the reviewer compares the claimed name with the
 * seat's winner and the contact before approving. An approved photo is then served through the same photo routes as the Commons photos
 * (server/geo-api.ts), so the election-period pause and photo takedowns apply to it too.
 * Privacy: the contact is stored encrypted and never published; JPEG/PNG metadata (EXIF GPS, camera, text chunks) is removed before the
 * file is stored; the file lives outside every served folder until approved. The page says plainly that no contact detail is shown.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import type { Request, Response } from "express";
import type { CandidateResult } from "../src/lib/elections";
import { isStateCode } from "../src/lib/states";
import { audit, getDb, getKeys, migrate, registerMigration, requireRole } from "./civic/core";
import { getMediaScanner } from "./civic/issues/media";
import { rateLimiter } from "./security";

registerMigration("photo_submissions_001", `
CREATE TABLE IF NOT EXISTS photo_submissions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL,
  ac_no INTEGER NOT NULL,
  year INTEGER NOT NULL,
  candidate TEXT NOT NULL,
  claimed_name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  holder TEXT NOT NULL,
  contact_enc TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_at TEXT,
  decided_by TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS photo_submissions_status ON photo_submissions(status, created_at);
`);

let migrated = false;
const db = () => { if (!migrated) { migrate(); migrated = true; } return getDb(); };
/** Test hook: the in-memory DB is recreated between tests. */
export function resetPhotoSubmissionsDbFlag(): void { migrated = false; }

export const MAX_BYTES = 2_000_000;
export const RELATIONSHIPS = ["candidate", "party office", "authorised representative"] as const;
const dir = () => path.resolve(process.env.PHOTO_SUBMISSIONS_DIR || path.join("data", "photo-submissions"));
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined);
const err = (res: Response, status: number, error: string, code: string) => res.status(status).json({ error, code });

/** The file's real type from its first bytes (the Content-Type header is never trusted). WebP and everything else is refused. */
export function sniff(b: Buffer): { mime: "image/jpeg" | "image/png"; ext: "jpg" | "png" } | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  return null;
}

/** Removes metadata segments (JPEG APP1..APP15 except the colour profile, COM; PNG text and EXIF chunks). Returns null if the file is malformed. */
export function stripMetadata(b: Buffer, kind: "image/jpeg" | "image/png"): Buffer | null {
  if (kind === "image/jpeg") {
    const out: Buffer[] = [b.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xda) { out.push(b.subarray(i)); return Buffer.concat(out); } // start of scan: the rest is image data
      if (m === 0xd9) { out.push(b.subarray(i)); return Buffer.concat(out); }
      const len = b.readUInt16BE(i + 2);
      if (len < 2 || i + 2 + len > b.length) return null;
      const seg = b.subarray(i, i + 2 + len);
      const drop = (m >= 0xe1 && m <= 0xef && m !== 0xe2) || m === 0xfe; // keep APP0 (JFIF) and APP2 (ICC colour profile)
      if (!drop) out.push(seg);
      i += 2 + len;
    }
    return null;
  }
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  const KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs"]);
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    if (i + 12 + len > b.length) return null;
    if (KEEP.has(type)) out.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === "IEND") return Buffer.concat(out);
  }
  return null;
}

/** The people who won the seat at the latest assembly election in the data (a tie or by-election can give more than one). */
export function seatWinner(rows: CandidateResult[], state: string, acNo: number): { year: number; names: string[] } | null {
  const seat = rows.filter((r) => r.state === state && r.type === "assembly" && r.acNo === acNo);
  if (!seat.length) return null;
  const year = Math.max(...seat.map((r) => r.year));
  const names = seat.filter((r) => r.year === year && r.position === 1).map((r) => r.candidate);
  return names.length ? { year, names } : null;
}

export interface UploadPhotoEntry { state: string; year: number; acNo: number; candidate: string; file: string; author: string; licence: string; licenceUrl: null; source: string; origin: "upload"; submissionId: string }
/** Approved submissions in the same shape as the other winner photos; the photo routes in geo-api.ts add these (newest approval wins per seat). */
export function approvedUploads(): UploadPhotoEntry[] {
  let rows: Record<string, unknown>[];
  try { rows = db().prepare("SELECT * FROM photo_submissions WHERE status = 'approved' ORDER BY decided_at DESC").all() as Record<string, unknown>[]; } catch { return []; }
  const seen = new Set<string>();
  const out: UploadPhotoEntry[] = [];
  for (const r of rows) {
    const k = `${r.state}|${r.ac_no}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      state: String(r.state), year: Number(r.year), acNo: Number(r.ac_no), candidate: String(r.candidate), file: `upload-${r.id}${path.extname(String(r.file))}`,
      author: String(r.holder), licence: "Supplied with permission", licenceUrl: null, source: "", origin: "upload", submissionId: String(r.id),
    });
  }
  return out;
}
/** The stored file for a public upload name like upload-<id>.jpg, only if that id is currently approved. */
export function approvedUploadPath(file: string): string | null {
  const m = /^upload-(ph_[0-9a-f]{16})\.(jpg|png)$/.exec(file);
  if (!m) return null;
  const row = db().prepare("SELECT file FROM photo_submissions WHERE id = ? AND status = 'approved'").get(m[1]) as { file: string } | undefined;
  return row ? path.join(dir(), row.file) : null;
}

export function createPhotoSubmissionsRouter(data: { elections: CandidateResult[] }): Router {
  const router = express.Router();
  const limiter = rateLimiter({ burst: Number(process.env.PHOTO_SUBMIT_BURST) || (process.env.NODE_ENV === "production" ? 3 : 30), perSecond: 1 / 600 });

  router.post("/photos/submissions", limiter, express.raw({ type: ["image/jpeg", "image/png"], limit: MAX_BYTES + 1024 }), async (req: Request, res: Response) => {
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(Buffer.from(String(req.get("x-photo-meta") ?? ""), "base64").toString("utf8")); } catch { return err(res, 400, "The details were not readable", "bad_meta"); }
    if (str(meta.website, 100)) return void res.status(202).json({ ok: true }); // honeypot: pretend success so bots learn nothing
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return err(res, 400, "Send the photo as a JPEG or PNG file", "no_file");
    if (body.length > MAX_BYTES) return err(res, 413, "The photo must be 2 MB or smaller", "too_large");
    const state = String(meta.state ?? "").toUpperCase();
    const acNo = Number(meta.acNo);
    if (!isStateCode(state) || !Number.isInteger(acNo)) return err(res, 400, "Unknown constituency", "bad_seat");
    const winner = seatWinner(data.elections, state, acNo);
    if (!winner) return err(res, 404, "No election result for that constituency", "bad_seat");
    if (meta.consent !== true) return err(res, 400, "You must confirm you have the right to give this photo and allow it to be shown", "consent_required");
    const relationship = str(meta.relationship, 40);
    if (!relationship || !(RELATIONSHIPS as readonly string[]).includes(relationship)) return err(res, 400, "Say whether you are the candidate, the party office or an authorised representative", "bad_relationship");
    const claimedName = str(meta.claimedName, 120), holder = str(meta.holder, 120), contact = str(meta.contact, 200);
    if (!claimedName || !holder || !contact) return err(res, 400, "Your name, the credit line and a contact are required", "missing_fields");
    const kind = sniff(body);
    if (!kind) return err(res, 415, "Only JPEG and PNG photos are accepted", "bad_type");
    const verdict = await getMediaScanner().scan(body, { kind: "photo", mime: kind.mime });
    if (!verdict.ok) return err(res, 422, "The file was refused by the safety check", "scan_failed");
    const clean = stripMetadata(body, kind.mime);
    if (!clean) return err(res, 422, "The image file could not be read", "bad_image");

    const id = "ph_" + crypto.randomBytes(8).toString("hex");
    const file = `${id}.${kind.ext}`;
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), file), clean, { mode: 0o600 });
    db().prepare(`INSERT INTO photo_submissions (id, created_at, state, ac_no, year, candidate, claimed_name, relationship, holder, contact_enc, file, mime, bytes, sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, new Date().toISOString(), state, acNo, winner.year, winner.names[0], claimedName, relationship, holder,
      getKeys().encrypt("photo_contact", contact), file, kind.mime, clean.length, crypto.createHash("sha256").update(clean).digest("hex"));
    audit("anon", "photos.submission.create", `photo_submission:${id}`, { state, acNo });
    res.status(201).json({ ok: true, id, status: "pending" });
  });

  router.get("/photos/admin/submissions", requireRole("admin"), (req, res) => {
    const status = str(req.query.status, 10);
    const rows = db().prepare(`SELECT * FROM photo_submissions ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`).all(...(status ? [status] : [])) as Record<string, unknown>[];
    res.set("Cache-Control", "no-store").json({
      submissions: rows.map((r) => {
        let contact: string | null;
        try { contact = getKeys().decrypt("photo_contact", String(r.contact_enc)); } catch { contact = null; }
        const { contact_enc: _c, file: _f, ...rest } = r;
        return { ...rest, contact, fileUrl: `/api/v1/photos/admin/submissions/${r.id}/file` };
      }),
    });
  });

  router.get("/photos/admin/submissions/:id/file", requireRole("admin"), (req, res) => {
    const row = db().prepare("SELECT file, mime FROM photo_submissions WHERE id = ?").get(String(req.params.id)) as { file: string; mime: string } | undefined;
    if (!row) return err(res, 404, "No such submission", "not_found");
    res.set({ "Cache-Control": "no-store", "Content-Type": row.mime }).sendFile(path.join(dir(), row.file));
  });

  router.post("/photos/admin/submissions/:id/decide", requireRole("admin"), express.json({ limit: "4kb" }), (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const status = str(b.status, 10);
    if (status !== "approved" && status !== "rejected") return err(res, 400, "status must be approved or rejected", "invalid_status");
    const r = db().prepare("UPDATE photo_submissions SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?")
      .run(status, new Date().toISOString(), req.person?.id ?? "unknown", str(b.note, 500) ?? null, String(req.params.id));
    if (!r.changes) return err(res, 404, "No such submission", "not_found");
    audit(req.person?.id ?? "unknown", "photos.submission.decide", `photo_submission:${String(req.params.id)}`, { status });
    res.json({ ok: true });
  });
  return router;
}
