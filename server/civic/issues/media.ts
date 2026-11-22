/**
 * Photo and voice-note intake for issue reports (S-24, S-138, S-147; DESIGN_2028 3.4).
 *
 * - Size caps (CIVIC_PHOTO_MAX_BYTES default 2 MB, CIVIC_VOICE_MAX_BYTES default 1 MB) and a per-person daily quota.
 * - The declared mime type must match the content sniffed from magic bytes; only JPEG/PNG photos and WAV/OGG/WebM/MP4/MP3
 *   audio are accepted. Anything else is refused (415).
 * - S-138: WebP, HEIC/HEIF and AVIF are recognised by magic bytes and refused with 415 + code "convert_on_client": the browser
 *   re-encodes them to JPEG on a canvas (which also drops EXIF/XMP) before upload; see data/civic/client-media-spec.json.
 *   The server never decodes those formats. Image dimensions are capped (CIVIC_PHOTO_MAX_DIM per side, CIVIC_PHOTO_MAX_PIXELS).
 * - JPEG and PNG are re-written without metadata (EXIF/GPS, XMP, IPTC, comments, PNG text/time chunks). An ID3v2 tag is
 *   removed from MP3. Other audio containers are stored as received (tags there are not stripped; noted limitation).
 * - S-147: the upload goes through a pluggable scanner (ClamAV-style hook; heuristic by default, CIVIC_MEDIA_SCANNER=none for the
 *   no-op), and is stored AES-256-GCM encrypted (key derived from the civic KeyProvider, or CIVIC_MEDIA_KEY), with the media id as AAD.
 * - Files live under CIVIC_MEDIA_DIR (default data/civic-media), never in the database and never next to it, with a random
 *   128-bit name; the original filename is discarded. The DB keeps only the opaque id, mime, size, owner and a retention date.
 * - Each file is retention-tagged (CIVIC_MEDIA_RETENTION_DAYS, else data/civic/retention-policy.json, default 180 days) and purged
 *   by purgeExpiredMedia (run by sweep) and by account erasure.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { audit, getKeys, getStore, registerMigration, registerStoreErasureHook } from "../core";
import { linkPerson, mediaOwnerPseudonym } from "../core/pseudonyms";
import { rateAllow, rateCount } from "../identity/service";

/** The issues store (S-74). issue_media.owner_id holds a per-upload keyed pseudonym, never a person id. */
const idb = () => getStore("issues");
/** Is the media row owned by this person? (recomputes the pseudonym; the issues store cannot tell on its own) */
export const ownsMedia = (row: { id: string; owner_id: string }, personId: string): boolean => row.owner_id === mediaOwnerPseudonym(row.id, personId);

registerMigration("issues_media_001", `
CREATE TABLE IF NOT EXISTS issue_media (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
  file TEXT NOT NULL, issue_id TEXT, created_at TEXT NOT NULL, retain_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_media_owner ON issue_media(owner_id, created_at);
`, "issues");

export class MediaError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export const photoMaxBytes = () => Number(process.env.CIVIC_PHOTO_MAX_BYTES || 2 * 1024 * 1024);
export const voiceMaxBytes = () => Number(process.env.CIVIC_VOICE_MAX_BYTES || 1024 * 1024);
export const photoMaxDim = () => Number(process.env.CIVIC_PHOTO_MAX_DIM || 6000);
export const photoMaxPixels = () => Number(process.env.CIVIC_PHOTO_MAX_PIXELS || 25_000_000);

/** Retention table for issue data (data/civic/retention-policy.json), aligned with docs/RETENTION.md "Issue reports". */
export interface RetentionPolicy { media_days: number; gps_exact_days: number; ivr_call_state_minutes: number; unattached_media_hours: number; ref: string }
const POLICY_DEFAULT: RetentionPolicy = { media_days: 180, gps_exact_days: 30, ivr_call_state_minutes: 15, unattached_media_hours: 24, ref: "docs/RETENTION.md" };
let policyCache: RetentionPolicy | null = null;
export function retentionPolicy(): RetentionPolicy {
  if (policyCache) return policyCache;
  try { policyCache = { ...POLICY_DEFAULT, ...(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data/civic/retention-policy.json"), "utf8")) as Partial<RetentionPolicy>) }; }
  catch { policyCache = { ...POLICY_DEFAULT }; }
  return policyCache;
}
export const mediaRetentionDays = () => Number(process.env.CIVIC_MEDIA_RETENTION_DAYS || retentionPolicy().media_days);
export const mediaPerDay = () => Number(process.env.CIVIC_MEDIA_PER_DAY || 20);
export const mediaDir = () => path.resolve(process.env.CIVIC_MEDIA_DIR || path.join("data", "civic-media"));
/** Largest request body the upload route will buffer (raw or base64 or multipart overhead included). */
export const maxUploadBody = () => Math.ceil(Math.max(photoMaxBytes(), voiceMaxBytes()) * 1.4) + 4096;

export type MediaKind = "photo" | "voice";
export interface Sniffed { kind: MediaKind; mime: string; ext: string }

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** Image containers we deliberately do not decode on the server; the client converts them to JPEG first. */
export interface ClientConvert { format: "webp" | "heic" | "avif"; mime: string }
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
export function unsupportedImage(b: Buffer): ClientConvert | null {
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return { format: "webp", mime: "image/webp" };
  if (b.length >= 12 && startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = b.toString("latin1", 8, 12).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return { format: "heic", mime: "image/heic" };
    if (brand === "avif" || brand === "avis") return { format: "avif", mime: "image/avif" };
  }
  return null;
}

/** Identify a file by its leading bytes (never by the declared type or extension). */
export function sniff(b: Buffer): Sniffed | null {
  if (unsupportedImage(b)) return null;
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

/** Pixel size from the header without decoding: JPEG SOFn or PNG IHDR. Null when it cannot be read. */
export function imageDimensions(b: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png") return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  if (mime !== "image/jpeg") return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff && i < b.length) i++;
    const m = b[i++];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (i + 2 > b.length) return null;
    const len = b.readUInt16BE(i);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 7 <= b.length ? { height: b.readUInt16BE(i + 3), width: b.readUInt16BE(i + 5) } : null;
    if (m === 0xda || len < 2) return null;
    i += len;
  }
  return null;
}

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

// ---------------------------------------------------------------------------------------------
// S-147: scanner hook (ClamAV-style)
// ---------------------------------------------------------------------------------------------

export interface ScanVerdict { ok: boolean; reason?: string }
/**
 * Scan hook run on the uploaded bytes before anything is stored. A ClamAV adapter implements `scan` against clamd (INSTREAM) and
 * may return a Promise; install it with setMediaScanner(). A scanner that throws fails closed (the upload is refused with 503).
 */
export interface MediaScanner { name: string; scan(data: Buffer, ctx: { kind: MediaKind; mime: string }): ScanVerdict | Promise<ScanVerdict> }

export class NoopScanner implements MediaScanner {
  name = "noop";
  scan(): ScanVerdict { return { ok: true }; }
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
/**
 * Size/type/pattern heuristics: executables and scripts disguised as media, the EICAR test string, polyglot markers (a valid
 * image or audio file carrying an HTML/PHP/shell payload or an embedded archive/executable), and absurd sizes. Not a malware
 * engine; it is the dev and fallback layer below a real scanner.
 */
export class HeuristicScanner implements MediaScanner {
  name = "heuristic";
  scan(data: Buffer, ctx: { kind: MediaKind; mime: string }): ScanVerdict {
    const cap = ctx.kind === "photo" ? photoMaxBytes() : voiceMaxBytes();
    if (data.length > cap * 4) return { ok: false, reason: "size" };
    const head = data.subarray(0, 4);
    if ((head[0] === 0x4d && head[1] === 0x5a) || startsWith(data, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(data, [0x23, 0x21]) || startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x25, 0x50, 0x44, 0x46])) return { ok: false, reason: "executable_or_container" };
    const text = data.toString("latin1");
    if (text.includes(EICAR)) return { ok: false, reason: "eicar" };
    if (/<\s*script\b|<\?php|<%@|<\s*iframe\b|javascript:\s*[a-z]|\bpowershell\b[^\n]{0,40}-enc/i.test(text)) return { ok: false, reason: "embedded_script" };
    // an executable or archive header buried inside an image/audio file
    if (data.length > 64 && /MZ[\x00-\xff]{58}PE\x00\x00/.test(text.slice(0, 1 << 20))) return { ok: false, reason: "embedded_executable" };
    return { ok: true };
  }
}

let scanner: MediaScanner | null = null;
export function getMediaScanner(): MediaScanner {
  if (scanner) return scanner;
  scanner = process.env.CIVIC_MEDIA_SCANNER === "none" ? new NoopScanner() : new HeuristicScanner();
  return scanner;
}
export function setMediaScanner(s: MediaScanner | null): void { scanner = s; }

// ---------------------------------------------------------------------------------------------
// S-147: encryption at rest
// ---------------------------------------------------------------------------------------------

const MAGIC = Buffer.from("PPM1");
/** 32-byte data key. CIVIC_MEDIA_KEY wins when set (any string; hashed); otherwise derived from the civic KeyProvider (HSM-backed in production). */
function mediaKey(): Buffer {
  const env = process.env.CIVIC_MEDIA_KEY;
  if (env) return crypto.createHash("sha256").update("civic-media:" + env).digest();
  return Buffer.from(getKeys().hmac("media-at-rest", "key-v1"), "hex");
}
export function encryptMedia(plain: Buffer, id: string): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", mediaKey(), iv);
  c.setAAD(Buffer.from(id));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
export function decryptMedia(stored: Buffer, id: string): Buffer {
  if (!stored.subarray(0, 4).equals(MAGIC)) return stored; // legacy plaintext file written before encryption at rest
  const d = crypto.createDecipheriv("aes-256-gcm", mediaKey(), stored.subarray(4, 16));
  d.setAAD(Buffer.from(id));
  d.setAuthTag(stored.subarray(16, 32));
  return Buffer.concat([d.update(stored.subarray(32)), d.final()]);
}

// ---------------------------------------------------------------------------------------------
// S-147: GPS policy
// ---------------------------------------------------------------------------------------------

/** Public coordinates are rounded to 3 decimals (about 111 m north-south): enough to place a problem on a street, not a doorstep. */
export const PUBLIC_GPS_DECIMALS = 3;
export const roundCoord = (v: number, decimals = PUBLIC_GPS_DECIMALS): number => Math.round(v * 10 ** decimals) / 10 ** decimals;

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

export interface StoredMedia { id: string; ref: string; kind: MediaKind; mime: string; bytes: number; retain_until: string }
export interface StoreOptions { expectKind?: MediaKind }

/** Validate, scan, sanitise, encrypt and store an upload. `declaredMime` is checked against the sniffed type. */
export async function storeMedia(ownerId: string, data: Buffer, declaredMime: string | undefined, now = new Date(), opts: StoreOptions = {}): Promise<StoredMedia> {
  if (!data.length) throw new MediaError(400, "empty upload");
  const conv = unsupportedImage(data);
  if (conv) {
    throw new MediaError(415, "this image format must be converted to JPEG on the device before upload", {
      code: "convert_on_client", detected: conv.mime, convert_to: "image/jpeg", client_spec: "data/civic/client-media-spec.json",
      accepted: ["image/jpeg", "image/png"],
    });
  }
  const s = sniff(data);
  if (!s) throw new MediaError(415, "unsupported file type", { code: "unsupported_type", accepted: ["image/jpeg", "image/png", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4", "audio/mpeg"] });
  if (opts.expectKind && s.kind !== opts.expectKind) throw new MediaError(415, `expected a ${opts.expectKind} file`, { code: "wrong_kind" });
  const cap = s.kind === "photo" ? photoMaxBytes() : voiceMaxBytes();
  if (data.length > cap) throw new MediaError(413, `${s.kind} too large`, { code: "too_large", max_bytes: cap });
  if (declaredMime && canonMime(declaredMime) !== s.mime && canonMime(declaredMime) !== "application/octet-stream") throw new MediaError(415, "declared type does not match file content");
  if (s.kind === "photo") {
    const dim = imageDimensions(data, s.mime);
    if (dim && (dim.width > photoMaxDim() || dim.height > photoMaxDim() || dim.width * dim.height > photoMaxPixels())) {
      throw new MediaError(422, "image dimensions too large", { code: "dimensions_too_large", width: dim.width, height: dim.height, max_side: photoMaxDim(), max_pixels: photoMaxPixels() });
    }
  }

  const db = idb();
  // the per-person daily quota is counted in the identity store (the issues store only holds per-upload pseudonyms)
  const dayWindowMs = Math.max(1, now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (rateCount("media:" + ownerId, dayWindowMs, now.getTime()) >= mediaPerDay()) throw new MediaError(429, "daily upload limit reached", { limit: mediaPerDay() });

  const sc = getMediaScanner();
  let verdict: ScanVerdict;
  try { verdict = await sc.scan(data, { kind: s.kind, mime: s.mime }); }
  catch { throw new MediaError(503, "scanner unavailable, try again later", { code: "scanner_unavailable" }); }
  if (!verdict.ok) {
    audit(ownerId, "issue.media_rejected", "issue_media", { scanner: sc.name, reason: verdict.reason });
    throw new MediaError(422, "file rejected by the safety scan", { code: "scan_rejected" });
  }

  const clean = sanitise(data, s);
  const id = crypto.randomBytes(16).toString("hex");
  const file = `${id}.${s.ext}`;
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  fs.writeFileSync(path.join(dir, file), encryptMedia(clean, id), { mode: 0o600 });
  const retain = new Date(now.getTime() + mediaRetentionDays() * 86400_000).toISOString();
  db.prepare("INSERT INTO issue_media (id,owner_id,kind,mime,bytes,file,issue_id,created_at,retain_until) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(id, mediaOwnerPseudonym(id, ownerId), s.kind, s.mime, clean.length, file, now.toISOString(), retain);
  rateAllow("media:" + ownerId, Number.MAX_SAFE_INTEGER, dayWindowMs, now.getTime()); // record the upload against the daily quota
  linkPerson(ownerId, "media", id, null, now);
  audit(ownerId, "issue.media_upload", `media:${id}`, { kind: s.kind, bytes: clean.length, scanner: sc.name });
  return { id, ref: `media:${id}`, kind: s.kind, mime: s.mime, bytes: clean.length, retain_until: retain };
}

interface MediaRow { id: string; owner_id: string; kind: MediaKind; mime: string; bytes: number; file: string; issue_id: string | null; retain_until: string }
export function getMedia(id: string): MediaRow | null {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return (idb().prepare("SELECT * FROM issue_media WHERE id=?").get(id) as unknown as MediaRow | undefined) ?? null;
}
/** Decrypted bytes of a stored file, or null when it is missing or fails authentication. */
export function readMediaFile(row: MediaRow): Buffer | null {
  try { return decryptMedia(fs.readFileSync(path.join(mediaDir(), path.basename(row.file))), row.id); } catch { return null; }
}

/** Parse "media:<id>" for a report; the media must exist, belong to the reporter and be of the expected kind. */
export function claimMedia(ref: string, ownerId: string, kind: MediaKind): string {
  const id = ref.startsWith("media:") ? ref.slice(6) : "";
  const row = getMedia(id);
  if (!row || !ownsMedia(row, ownerId) || row.kind !== kind || row.issue_id) throw new MediaError(400, `invalid ${kind} reference`);
  return id;
}
export function attachMedia(id: string, issueId: string): void {
  idb().prepare("UPDATE issue_media SET issue_id=? WHERE id=?").run(issueId, id);
}

function removeRows(rows: { id: string; file: string }[]): number {
  const del = idb().prepare("DELETE FROM issue_media WHERE id=?");
  for (const r of rows) {
    try { fs.unlinkSync(path.join(mediaDir(), path.basename(r.file))); } catch { /* already gone */ }
    del.run(r.id);
  }
  return rows.length;
}
/** Delete files past their retention date, and unattached uploads older than the policy window (default a day). */
export function purgeExpiredMedia(now = new Date()): number {
  const rows = idb().prepare("SELECT id, file FROM issue_media WHERE retain_until<=? OR (issue_id IS NULL AND created_at<?)")
    .all(now.toISOString(), new Date(now.getTime() - retentionPolicy().unattached_media_hours * 3600_000).toISOString()) as { id: string; file: string }[];
  if (rows.length) audit("system", "issue.media_purge", "issue_media", { count: rows.length });
  return removeRows(rows);
}

registerStoreErasureHook("issues", "issue_media", (subjects) => {
  for (let i = 0; i < subjects.length; i += 500) {
    const c = subjects.slice(i, i + 500);
    removeRows(idb().prepare(`SELECT id, file FROM issue_media WHERE owner_id IN (${c.map(() => "?").join(",")})`).all(...c) as { id: string; file: string }[]);
  }
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
