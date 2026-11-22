/**
 * Photo and voice-note intake for issue reports (S-24, DESIGN_2028 3.4).
 *
 * - Size caps (CIVIC_PHOTO_MAX_BYTES default 2 MB, CIVIC_VOICE_MAX_BYTES default 1 MB) and a per-person daily quota.
 * - The declared mime type must match the content sniffed from magic bytes; only JPEG/PNG photos and WAV/OGG/WebM/MP4/MP3
 *   audio are accepted. Anything else is refused (415).
 * - JPEG and PNG are re-written without metadata (EXIF/GPS, XMP, IPTC, comments, PNG text/time chunks). An ID3v2 tag is
 *   removed from MP3. Other audio containers are stored as received (tags there are not stripped; noted limitation).
 * - Files live under CIVIC_MEDIA_DIR (default data/civic-media), never in the database and never next to it, with a random
 *   128-bit name; the original filename is discarded. The DB keeps only the opaque id, mime, size, owner and a retention date.
 * - Each file is retention-tagged (CIVIC_MEDIA_RETENTION_DAYS, default 180) and purged by purgeExpiredMedia (run by sweep) and by
 *   account erasure.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { audit, getDb, registerErasureHook, registerMigration } from "../core";

registerMigration("issues_media_001", `
CREATE TABLE IF NOT EXISTS issue_media (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
  file TEXT NOT NULL, issue_id TEXT, created_at TEXT NOT NULL, retain_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_media_owner ON issue_media(owner_id, created_at);
`);

export class MediaError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export const photoMaxBytes = () => Number(process.env.CIVIC_PHOTO_MAX_BYTES || 2 * 1024 * 1024);
export const voiceMaxBytes = () => Number(process.env.CIVIC_VOICE_MAX_BYTES || 1024 * 1024);
export const mediaRetentionDays = () => Number(process.env.CIVIC_MEDIA_RETENTION_DAYS || 180);
export const mediaPerDay = () => Number(process.env.CIVIC_MEDIA_PER_DAY || 20);
export const mediaDir = () => path.resolve(process.env.CIVIC_MEDIA_DIR || path.join("data", "civic-media"));
/** Largest request body the upload route will buffer (raw or base64 or multipart overhead included). */
export const maxUploadBody = () => Math.ceil(Math.max(photoMaxBytes(), voiceMaxBytes()) * 1.4) + 4096;

export type MediaKind = "photo" | "voice";
export interface Sniffed { kind: MediaKind; mime: string; ext: string }

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** Identify a file by its leading bytes (never by the declared type or extension). */
export function sniff(b: Buffer): Sniffed | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: "photo", mime: "image/jpeg", ext: "jpg" };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "photo", mime: "image/png", ext: "png" };
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x41, 0x56, 0x45], 8)) return { kind: "voice", mime: "audio/wav", ext: "wav" };
  if (startsWith(b, [0x4f, 0x67, 0x67, 0x53])) return { kind: "voice", mime: "audio/ogg", ext: "ogg" };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "voice", mime: "audio/webm", ext: "webm" };
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return { kind: "voice", mime: "audio/mp4", ext: "m4a" };
  if (startsWith(b, [0x49, 0x44, 0x33]) || (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: "voice", mime: "audio/mpeg", ext: "mp3" };
  return null;
}
const MIME_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav", "audio/m4a": "audio/mp4", "audio/x-m4a": "audio/mp4", "audio/mp3": "audio/mpeg", "audio/opus": "audio/ogg", "video/webm": "audio/webm" };
const canonMime = (m: string) => { const x = m.split(";")[0].trim().toLowerCase(); return MIME_ALIASES[x] ?? x; };

/** Rewrite a JPEG keeping only the structure needed to display it: drops APP1..APP15 (EXIF, XMP, IPTC, ICC) and COM; keeps JFIF (APP0) and Adobe (APP14). */
export function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new MediaError(422, "corrupt JPEG");
    while (b[i] === 0xff && i < b.length) i++; // fill bytes
    const marker = b[i++];
    if (marker === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(out); }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(Buffer.from([0xff, marker])); continue; }
    if (i + 2 > b.length) throw new MediaError(422, "corrupt JPEG");
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) throw new MediaError(422, "corrupt JPEG");
    if (marker === 0xda) { // start of scan: entropy-coded data follows to the end; copy verbatim
      const eoi = b.indexOf(Buffer.from([0xff, 0xd9]), i + len); // first EOI after the scan header; anything after it (trailers) is dropped
      if (eoi === -1) throw new MediaError(422, "truncated JPEG");
      out.push(Buffer.from([0xff, marker]), b.subarray(i, eoi + 2));
      return Buffer.concat(out);
    }
    const drop = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!drop) out.push(Buffer.from([0xff, marker]), b.subarray(i, i + len));
    i += len;
  }
  throw new MediaError(422, "truncated JPEG");
}

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME", "iCCP", "sPLT", "hIST", "bKGD"]);
/** Rewrite a PNG without metadata chunks (EXIF, text, time). Critical and rendering chunks are kept. */
export function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8, sawIhdr = false, sawEnd = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    const end = i + 12 + len;
    if (len > b.length || end > b.length) throw new MediaError(422, "corrupt PNG");
    if (i === 8 && type !== "IHDR") throw new MediaError(422, "corrupt PNG");
    if (type === "IHDR") sawIhdr = true;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawIhdr || !sawEnd) throw new MediaError(422, "corrupt PNG");
  return Buffer.concat(out);
}

/** Drop a leading ID3v2 tag from an MP3 (artist/title/comments/geo frames). */
export function stripId3(b: Buffer): Buffer {
  if (!startsWith(b, [0x49, 0x44, 0x33]) || b.length < 10) return b;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const total = 10 + size + (b[5] & 0x10 ? 10 : 0);
  if (total >= b.length) throw new MediaError(422, "corrupt MP3");
  return b.subarray(total);
}

export function sanitise(b: Buffer, s: Sniffed): Buffer {
  if (s.mime === "image/jpeg") return stripJpeg(b);
  if (s.mime === "image/png") return stripPng(b);
  if (s.mime === "audio/mpeg") return stripId3(b);
  return b;
}

export interface StoredMedia { id: string; ref: string; kind: MediaKind; mime: string; bytes: number; retain_until: string }

/** Validate, sanitise and store an upload. `declaredMime` is checked against the sniffed type. */
export function storeMedia(ownerId: string, data: Buffer, declaredMime: string | undefined, now = new Date()): StoredMedia {
  if (!data.length) throw new MediaError(400, "empty upload");
  const s = sniff(data);
  if (!s) throw new MediaError(415, "unsupported file type", { accepted: ["image/jpeg", "image/png", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4", "audio/mpeg"] });
  const cap = s.kind === "photo" ? photoMaxBytes() : voiceMaxBytes();
  if (data.length > cap) throw new MediaError(413, `${s.kind} too large`, { max_bytes: cap });
  if (declaredMime && canonMime(declaredMime) !== s.mime && canonMime(declaredMime) !== "application/octet-stream") throw new MediaError(415, "declared type does not match file content");

  const db = getDb();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const used = (db.prepare("SELECT COUNT(*) c FROM issue_media WHERE owner_id=? AND created_at>=?").get(ownerId, dayStart) as { c: number }).c;
  if (used >= mediaPerDay()) throw new MediaError(429, "daily upload limit reached", { limit: mediaPerDay() });

  const clean = sanitise(data, s);
  const id = crypto.randomBytes(16).toString("hex");
  const file = `${id}.${s.ext}`;
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  fs.writeFileSync(path.join(dir, file), clean, { mode: 0o600 });
  const retain = new Date(now.getTime() + mediaRetentionDays() * 86400_000).toISOString();
  db.prepare("INSERT INTO issue_media (id,owner_id,kind,mime,bytes,file,issue_id,created_at,retain_until) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(id, ownerId, s.kind, s.mime, clean.length, file, now.toISOString(), retain);
  audit(ownerId, "issue.media_upload", `media:${id}`, { kind: s.kind, bytes: clean.length });
  return { id, ref: `media:${id}`, kind: s.kind, mime: s.mime, bytes: clean.length, retain_until: retain };
}

interface MediaRow { id: string; owner_id: string; kind: MediaKind; mime: string; bytes: number; file: string; issue_id: string | null; retain_until: string }
export function getMedia(id: string): MediaRow | null {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return (getDb().prepare("SELECT * FROM issue_media WHERE id=?").get(id) as unknown as MediaRow | undefined) ?? null;
}
export function readMediaFile(row: MediaRow): Buffer | null {
  try { return fs.readFileSync(path.join(mediaDir(), path.basename(row.file))); } catch { return null; }
}

/** Parse "media:<id>" for a report; the media must exist, belong to the reporter and be of the expected kind. */
export function claimMedia(ref: string, ownerId: string, kind: MediaKind): string {
  const id = ref.startsWith("media:") ? ref.slice(6) : "";
  const row = getMedia(id);
  if (!row || row.owner_id !== ownerId || row.kind !== kind || row.issue_id) throw new MediaError(400, `invalid ${kind} reference`);
  return id;
}
export function attachMedia(id: string, issueId: string): void {
  getDb().prepare("UPDATE issue_media SET issue_id=? WHERE id=?").run(issueId, id);
}

function removeRows(rows: { id: string; file: string }[]): number {
  const del = getDb().prepare("DELETE FROM issue_media WHERE id=?");
  for (const r of rows) {
    try { fs.unlinkSync(path.join(mediaDir(), path.basename(r.file))); } catch { /* already gone */ }
    del.run(r.id);
  }
  return rows.length;
}
/** Delete files past their retention date, and unattached uploads older than a day. */
export function purgeExpiredMedia(now = new Date()): number {
  const rows = getDb().prepare("SELECT id, file FROM issue_media WHERE retain_until<=? OR (issue_id IS NULL AND created_at<?)")
    .all(now.toISOString(), new Date(now.getTime() - 86400_000).toISOString()) as { id: string; file: string }[];
  if (rows.length) audit("system", "issue.media_purge", "issue_media", { count: rows.length });
  return removeRows(rows);
}

registerErasureHook("issue_media", (personId) => {
  removeRows(getDb().prepare("SELECT id, file FROM issue_media WHERE owner_id=?").all(personId) as { id: string; file: string }[]);
});

// ---------- request body decoding ----------
/** Extract the first file part of a multipart/form-data body. */
export function parseMultipart(body: Buffer, contentType: string): { data: Buffer; mime?: string } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const delim = Buffer.from("--" + (m[1] ?? m[2]).trim());
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === "--") return null;
    const hdrEnd = body.indexOf("\r\n\r\n", start);
    if (hdrEnd === -1) return null;
    const headers = body.toString("latin1", start, hdrEnd);
    const next = body.indexOf(delim, hdrEnd + 4);
    if (next === -1) return null;
    if (/filename=/i.test(headers)) {
      const ct = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1];
      return { data: body.subarray(hdrEnd + 4, next - 2), mime: ct };
    }
    pos = next;
  }
  return null;
}
