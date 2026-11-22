/**
 * Client-side photo preparation for issue reports (S-137, spec: data/civic/client-media-spec.json).
 * Decodes with the EXIF orientation applied, scales so the longer side is at most maxSide (never upscales), draws on white and
 * re-encodes to JPEG, which also drops EXIF/XMP/GPS. Defaults come straight from the spec file so the two cannot drift.
 */
import spec from "../../data/civic/client-media-spec.json";

export type ConvertErrorCode = "convert_on_client" | "decode_failed" | "too_large";
export class ConvertError extends Error {
  code: ConvertErrorCode;
  constructor(code: ConvertErrorCode, message = code) { super(message); this.code = code; }
}

export interface ConvertOptions { maxSide?: number; quality?: number; maxBytes?: number }
export const CONVERT_DEFAULTS = spec.helper.defaults as { maxSide: number; quality: number; maxBytes: number };
/** Server limits the spec documents (also the hard ceiling for maxSide). */
export const SERVER_LIMITS = spec.server_contract.limits;
const MAX_ATTEMPTS = 5;

/** Scale (w,h) so the longer side is at most `max`, never upscaling. */
export function fitSize(w: number, h: number, max: number): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

export const isHeic = (f: { type: string; name?: string }) => /^image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name ?? "");

/** The retry schedule of the spec: lower quality by 0.1 (floor 0.5) until it stops helping, then shrink maxSide by 25%. */
export function nextAttempt(a: { quality: number; maxSide: number }): { quality: number; maxSide: number } {
  if (a.quality - 0.1 >= 0.5 - 1e-9) return { quality: Math.round((a.quality - 0.1) * 100) / 100, maxSide: a.maxSide };
  return { quality: a.quality, maxSide: Math.floor(a.maxSide * 0.75) };
}

async function decode(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try { const b = await createImageBitmap(file, { imageOrientation: "from-image" }); return { src: b, w: b.width, h: b.height, close: () => b.close?.() }; } catch { /* try <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("decode")); img.src = url; });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch { URL.revokeObjectURL(url); throw new Error("decode"); }
}

async function encode(src: CanvasImageSource, w: number, h: number, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === "function") {
    try {
      const oc = new OffscreenCanvas(w, h);
      const ctx = oc.getContext("2d");
      if (ctx) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(src, 0, 0, w, h); return await oc.convertToBlob({ type: "image/jpeg", quality }); }
    } catch { /* fall back to <canvas> */ }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // transparent pixels would turn black in JPEG
  ctx.drawImage(src, 0, 0, w, h);
  return new Promise((ok) => canvas.toBlob(ok, "image/jpeg", quality));
}

/**
 * Re-encode any image the browser can decode (JPEG, PNG, WebP, HEIC/AVIF where supported) to a JPEG under `maxBytes`.
 * If the browser cannot decode a HEIC/HEIF it throws ConvertError("convert_on_client") (the UI says to pick a JPEG or take a new photo);
 * other undecodable files throw "decode_failed"; if five attempts stay over the byte limit it throws "too_large".
 */
export async function reencodeToJpeg(file: Blob & { name?: string }, opts: ConvertOptions = {}): Promise<Blob> {
  const maxBytes = opts.maxBytes ?? CONVERT_DEFAULTS.maxBytes;
  let attempt = { quality: opts.quality ?? CONVERT_DEFAULTS.quality, maxSide: opts.maxSide ?? CONVERT_DEFAULTS.maxSide };
  let d;
  try { d = await decode(file); } catch { throw new ConvertError(isHeic(file as File) ? "convert_on_client" : "decode_failed"); }
  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const { w, h } = fitSize(d.w, d.h, attempt.maxSide);
      const out = await encode(d.src, w, h, attempt.quality);
      if (!out) throw new ConvertError("decode_failed");
      if (out.size <= maxBytes) return out;
      attempt = nextAttempt(attempt);
    }
    throw new ConvertError("too_large");
  } finally { d.close(); }
}

/** Kept for existing callers. */
export const toJpeg = reencodeToJpeg;
