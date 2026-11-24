/**
 * Staff-side and media routes of a consultation (S-154), mounted with the registry (see ./index):
 *
 *  GET  /:id/corrections                          officer of the department | owner | panel | admin: corrections with ids, status and a per-clause diff
 *  POST /:id/audio/upload?clause=&group=          owner (officer / admin): raw audio body; type sniffed (audio only), size capped, sha256 recorded
 *  GET  /:id/clauses/:n/audio/:group              public: streams the stored file ONLY once a panel reviewer marked that exact recording reviewed
 *
 * Stored files live under CONSULT_AUDIO_DIR (default <CIVIC_MEDIA_DIR>/consultation-audio) in a folder per consultation, with a generated
 * file name; a client-supplied name never reaches the file system. An upload keeps the recording `recorded`/`placeholder` in the content;
 * only the human review row (POST /:id/audio/review) makes it playable.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { audit, requireAuth, runInStore } from "../core";
import { rateAllow } from "../identity/service";
import { registryNow } from "../surveys/types";
import { currentContent, getConsultation, isOwner, logEvent, staffRole, visible } from "./registry";
import { cdb } from "./schema";
import { consultActor, fail, iso, lim, str, trim, wrap } from "./types";
import type { ClauseContent, ConsultationContent, ConsultationRow } from "./types";

export const staffRouter = Router();

// ---------------------------------------------------------------------------------------------
// Corrections (staff view)
// ---------------------------------------------------------------------------------------------

const DIFF_FIELDS = ["original_text", "original_ref", "summary_en", "summary_te", "audio"] as const;
export interface ClauseDiff { clause: number; field: (typeof DIFF_FIELDS)[number]; before: unknown; after: unknown }

/** Field-by-field difference between two versions of the clause list. */
export function diffContent(before: ConsultationContent, after: ConsultationContent): ClauseDiff[] {
  const out: ClauseDiff[] = [];
  for (const a of after.clauses) {
    const b = before.clauses.find((x) => x.n === a.n);
    for (const f of DIFF_FIELDS) {
      const x = b ? (b as ClauseContent)[f] : undefined, y = (a as ClauseContent)[f];
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ clause: a.n, field: f, before: x ?? null, after: y ?? null });
    }
  }
  return out;
}

staffRouter.get("/:id/corrections", requireAuth, wrap((req, res) => {
  const c = getConsultation(req.params.id);
  if (!c || !visible(c)) return fail(res, 404, "not_found");
  const me = req.person!.id, role = staffRole(me, c);
  if (!(role === "admin" || role === "officer" || role === "panel" || isOwner(me, c))) return fail(res, 403, "staff_only");
  const status = str(req.query.status);
  const rows = cdb().prepare(`SELECT id, from_version, to_version, content_json, content_hash, reason_en, reason_te, status, created_at, decided_at FROM consultation_corrections
    WHERE consultation_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at, rowid`).all(...(status ? [c.id, status] : [c.id])) as unknown as
    { id: string; from_version: number; to_version: number; content_json: string; content_hash: string; reason_en: string; reason_te: string | null; status: string; created_at: string; decided_at: string | null }[];
  const versionContent = (v: number): ConsultationContent | null => {
    if (v === c.version) return currentContent(c);
    const r = cdb().prepare("SELECT content_json FROM consultation_versions WHERE consultation_id = ? AND version = ?").get(c.id, v) as { content_json: string } | undefined;
    return r ? (JSON.parse(r.content_json) as ConsultationContent) : null;
  };
  const approvals = cdb().prepare("SELECT content_hash, SUM(decision = 'approve') AS a, SUM(decision = 'reject') AS r FROM consultation_panel_reviews WHERE consultation_id = ? GROUP BY content_hash").all(c.id) as unknown as { content_hash: string; a: number; r: number }[];
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    consultation_id: c.id, current_version: c.version,
    corrections: rows.map((r) => {
      const to = JSON.parse(r.content_json) as ConsultationContent;
      const from = versionContent(r.from_version);
      const ap = approvals.find((x) => x.content_hash === r.content_hash);
      return {
        id: r.id, from_version: r.from_version, to_version: r.to_version, content_hash: r.content_hash, status: r.status, reason_en: r.reason_en, reason_te: r.reason_te,
        created_at: r.created_at, decided_at: r.decided_at, approvals: ap?.a ?? 0, rejections: ap?.r ?? 0, diff: from ? diffContent(from, to) : [],
      };
    }),
  });
}));

// ---------------------------------------------------------------------------------------------
// Audio: storage, upload, serve
// ---------------------------------------------------------------------------------------------

export const audioDir = (): string => path.resolve(process.env.CONSULT_AUDIO_DIR || path.join(process.env.CIVIC_MEDIA_DIR || path.join(process.cwd(), "data", "civic-media"), "consultation-audio"));
export const audioMaxBytes = (): number => { const n = Number(process.env.CONSULT_AUDIO_MAX_BYTES); return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 5 * 1024 * 1024; };

/** The audio type from the file's own bytes (never from the header or the name). Null = not audio we accept. */
export function sniffAudio(b: Buffer): { mime: string; ext: string } | null {
  if (b.length < 12) return null;
  const at = (o: number, s: string) => b.subarray(o, o + s.length).toString("latin1") === s;
  if (at(0, "OggS")) return { mime: "audio/ogg", ext: "ogg" };
  if (at(0, "RIFF") && at(8, "WAVE")) return { mime: "audio/wav", ext: "wav" };
  if (at(0, "fLaC")) return { mime: "audio/flac", ext: "flac" };
  if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return { mime: "audio/mpeg", ext: "mp3" };
  if (at(4, "ftyp")) return { mime: "audio/mp4", ext: "m4a" };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: "audio/webm", ext: "webm" };
  return null;
}

const rawAudio = (req: Request, res: Response, next: NextFunction): void => {
  const max = audioMaxBytes();
  express.raw({ type: () => true, limit: max })(req, res, (err?: unknown) => {
    if (!err) return next();
    const e = err as { status?: number; type?: string };
    if (e.status === 413 || e.type === "entity.too.large") return fail(res, 413, "audio_too_large", { max_bytes: max });
    return fail(res, 400, "audio_invalid");
  });
};

interface AudioFileRow { id: string; consultation_id: string; clause_n: number; group_key: string; file_id: string; mime: string; bytes: number; sha256: string; path: string; uploaded_at: string }
const fileRow = (cid: string, fileId: string) => cdb().prepare("SELECT * FROM consultation_audio_files WHERE consultation_id = ? AND file_id = ?").get(cid, fileId) as unknown as AudioFileRow | undefined;
const isReviewed = (cid: string, n: number, group: string, fileId: string): boolean =>
  !!cdb().prepare("SELECT 1 AS x FROM consultation_audio_reviews WHERE consultation_id = ? AND clause_n = ? AND group_key = ? AND file_id = ?").get(cid, n, group, fileId);

staffRouter.post("/:id/audio/upload", requireAuth, rawAudio, wrap((req, res) => {
  const now = registryNow(), me = req.person!.id;
  const c = getConsultation(req.params.id) as ConsultationRow | undefined;
  if (!c) return fail(res, 404, "not_found");
  if (!isOwner(me, c)) return fail(res, c.status === "draft" ? 404 : 403, c.status === "draft" ? "not_found" : "owner_only");
  if (!rateAllow(`consult:audio:${me}`, 20, 60_000)) return fail(res, 429, "too_many_requests");
  const n = Number(req.query.clause), group = trim(req.query.group, lim("max_group_chars"));
  const a = currentContent(c).clauses.find((x) => x.n === n)?.audio.find((x) => x.group === group);
  if (!a) return fail(res, 404, "audio_not_found", { hint: "add the recording (group, file_id, duration) to the clause first" });
  if (!a.file_id) return fail(res, 409, "audio_file_id_missing");
  if (isReviewed(c.id, n, group, a.file_id)) return fail(res, 409, "audio_already_reviewed", { hint: "a reviewed recording cannot be replaced; propose a correction with a new file id" });
  const declared = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (declared && !declared.startsWith("audio/") && declared !== "application/octet-stream") return fail(res, 415, "audio_type_unsupported", { declared });
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) return fail(res, 400, "audio_empty");
  const kind = sniffAudio(body);
  if (!kind) return fail(res, 415, "audio_type_unsupported", { hint: "ogg, wav, mp3, m4a, webm or flac audio only" });
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const rel = path.join(c.id, `${crypto.randomUUID()}.${kind.ext}`);
  const abs = path.join(audioDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, { mode: 0o640 });
  const old = fileRow(c.id, a.file_id);
  runInStore("survey", () => {
    cdb().prepare("DELETE FROM consultation_audio_files WHERE consultation_id = ? AND file_id = ?").run(c.id, a.file_id);
    cdb().prepare("INSERT INTO consultation_audio_files (id, consultation_id, clause_n, group_key, file_id, mime, bytes, sha256, path, uploader_pseudonym, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), c.id, n, group, a.file_id, kind.mime, body.length, sha, rel, consultActor(me), iso(now));
    if (c.registered_at) logEvent(c.id, "audio_uploaded", { clause: n, group, file_id: a.file_id, sha256: sha, bytes: body.length }, now);
    audit(me, "consultation.audio.upload", "consultation:" + c.id, { clause: n, group, bytes: body.length });
  });
  if (old) { try { fs.unlinkSync(path.join(audioDir(), old.path)); } catch { /* already gone */ } }
  res.status(201).json({ ok: true, clause: n, group, file_id: a.file_id, mime: kind.mime, bytes: body.length, sha256: sha, status: a.status, reviewed: false, hint: "playable only after a panel reviewer marks it reviewed" });
}));

/** `Range: bytes=a-b` -> [start, end] inclusive; null = no/ignored header; "bad" = unsatisfiable. */
export function parseRange(h: string | undefined, size: number): [number, number] | null | "bad" {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") { const len = Number(m[2]); if (!len) return "bad"; start = Math.max(0, size - len); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return "bad";
  return [start, end];
}

staffRouter.get("/:id/clauses/:n/audio/:group", wrap((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const miss = (status: number, code: string, extra: Record<string, unknown> = {}) => { res.setHeader("Cache-Control", "no-store"); fail(res, status, code, extra); };
  if (!rateAllow(`consultpub:audio:${req.ip || "?"}`, 240, 60_000)) return miss(429, "too_many_requests");
  const c = getConsultation(req.params.id);
  if (!visible(c)) return miss(404, "not_found");
  const n = Number(req.params.n), group = req.params.group;
  const a = currentContent(c).clauses.find((x) => x.n === n)?.audio.find((x) => x.group === group);
  if (!a || !a.file_id) return miss(404, "audio_not_found");
  if (a.status !== "recorded" || !isReviewed(c.id, n, group, a.file_id)) return miss(409, "audio_not_reviewed", { status: a.status === "recorded" ? "recorded" : "placeholder" });
  const f = fileRow(c.id, a.file_id);
  const abs = f ? path.join(audioDir(), f.path) : "";
  if (!f || !abs.startsWith(audioDir() + path.sep) || !fs.existsSync(abs)) return miss(404, "audio_file_missing");
  // Content that may still be replaced by a correction (in review) is never cached; settled content may be.
  res.setHeader("Cache-Control", c.status === "in_review" ? "no-store" : "public, max-age=300");
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", `"${f.sha256}"`);
  res.setHeader("Content-Disposition", 'inline; filename="audio"');
  if (req.headers["if-none-match"] === `"${f.sha256}"`) { res.status(304).end(); return; }
  const size = f.bytes;
  const rg = parseRange(req.headers.range, size);
  if (rg === "bad") { res.setHeader("Content-Range", `bytes */${size}`); res.status(416).end(); return; }
  const [start, end] = rg ?? [0, size - 1];
  if (rg) { res.status(206); res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`); }
  res.setHeader("Content-Length", String(end - start + 1));
  if (req.method === "HEAD") { res.end(); return; }
  const stream = fs.createReadStream(abs, { start, end });
  stream.on("error", () => { if (!res.headersSent) fail(res, 500, "internal_error"); else res.destroy(); });
  stream.pipe(res);
}));
