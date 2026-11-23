/**
 * /api/v1/countday (S-41): serves the static, signed snapshot tree written by scripts/countday-ingest.ts. Read-only except the admin review gate.
 *  GET  /keys                      public verification keys
 *  GET  /:state/latest             newest snapshot + unsigned `live` block (delayed_minutes, banner EN/TE); short max-age
 *  GET  /:state/index              hash-chained index; short max-age
 *  GET  /:state/snapshots/:seq     immutable numbered snapshot; one-year immutable cache
 *  GET  /:state/ac/:acNo           latest per-seat envelope
 *  GET  /:state/review             admin: held items            POST /:state/review/:id/approve | reject   admin; two different admins release an anomaly
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { audit, auditPrivilegedRead, requireRole } from "../civic/core";
import { isStateCode } from "../../src/lib/states";
import { APPROVALS_NEEDED, readJson, stateDir, writeAtomic } from "../../pipeline/countday/ingest";
import type { Decisions, PendingItem } from "../../pipeline/countday/ingest";
import type { Envelope, KeysFile, SnapshotBody } from "../../pipeline/countday/types";

export type LiveState = "live" | "stale" | "source-down" | "delayed-fallback" | "synthetic";
export interface LiveBlock { state: LiveState; delayed_minutes: number; snapshot_age_minutes: number; stale_after_minutes: number; as_of: string; banner: { en: string; te: string } | null; forecast_hidden: boolean }

export const countDir = (env: NodeJS.ProcessEnv = process.env) => env.COUNTDAY_DIR || path.join(process.cwd(), "data", "generated", "countday");
export const staleMinutes = (env: NodeJS.ProcessEnv = process.env) => { const n = Number(env.COUNTDAY_STALE_MINUTES); return Number.isFinite(n) && n > 0 ? n : 10; };

/** Never silently serves stale as live: every state other than "live" carries a visible banner in both languages. */
export function liveBlock(body: Pick<SnapshotBody, "asOf" | "delayLabel" | "synthetic">, status: { sourceAsOf?: string; consecutiveFailures?: number } | null, now: Date, env: NodeJS.ProcessEnv = process.env): LiveBlock {
  const ref = Math.max(Date.parse(body.asOf), status?.sourceAsOf ? Date.parse(status.sourceAsOf) : 0);
  const delayed = Math.max(0, Math.floor((now.getTime() - ref) / 60000));
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(body.asOf)) / 60000));
  const limit = staleMinutes(env);
  let state: LiveState = "live", banner: LiveBlock["banner"] = null;
  if (body.synthetic) { state = "synthetic"; banner = { en: "SYNTHETIC test data. These are not real counts.", te: "కృత్రిమ పరీక్ష డేటా. ఇవి నిజమైన లెక్కింపు గణాంకాలు కావు." }; }
  else if (body.delayLabel === "delayed-fallback") { state = "delayed-fallback"; banner = { en: `The live feed is not available. Showing delayed archive figures as of ${body.asOf}.`, te: `ప్రత్యక్ష ఫీడ్ అందుబాటులో లేదు. ${body.asOf} నాటి ఆలస్య ఆర్కైవ్ గణాంకాలు చూపబడుతున్నాయి.` }; }
  else if (delayed > limit) { state = "stale"; banner = { en: `This is not live. The feed has not updated for ${delayed} minutes. Showing the last snapshot as of ${body.asOf}.`, te: `ఇది ప్రత్యక్షం కాదు. ఫీడ్ ${delayed} నిమిషాలుగా నవీకరించబడలేదు. ${body.asOf} నాటి చివరి స్నాప్‌షాట్ చూపబడుతోంది.` }; }
  else if ((status?.consecutiveFailures ?? 0) >= 3) { state = "source-down"; banner = { en: "The live feed is failing. Figures may be behind. Showing the last snapshot.", te: "ప్రత్యక్ష ఫీడ్ విఫలమవుతోంది. గణాంకాలు వెనుకబడి ఉండవచ్చు. చివరి స్నాప్‌షాట్ చూపబడుతోంది." }; }
  return { state, delayed_minutes: delayed, snapshot_age_minutes: age, stale_after_minutes: limit, as_of: body.asOf, banner, forecast_hidden: env.COUNT_DAY_ACTIVE === "1" };
}

const etagOf = (s: string) => `"${crypto.createHash("sha256").update(s).digest("base64url").slice(0, 32)}"`;
const IMMUTABLE = "public, max-age=31536000, immutable";

export function createCountdayRouter(opts: { dir?: string; env?: NodeJS.ProcessEnv; now?: () => Date } = {}): Router {
  const r = Router();
  const env = opts.env ?? process.env;
  const dir = () => opts.dir ?? countDir(env);
  const now = () => (opts.now ? opts.now() : new Date());
  const synthOk = () => env.NODE_ENV !== "production" || env.COUNTDAY_ALLOW_SYNTHETIC === "1";

  // small read cache keyed by path + mtime + size: the static path must not touch the disk per request under load
  const cache = new Map<string, { sig: string; text: string; meta: { synthetic: boolean; asOf: string; delayLabel: SnapshotBody["delayLabel"] } | null }>();
  const read = (file: string) => {
    let st: fs.Stats; try { st = fs.statSync(file); } catch { return null; }
    const sig = `${st.mtimeMs}-${st.size}`;
    const hit = cache.get(file);
    if (hit && hit.sig === sig) return hit;
    const text = fs.readFileSync(file, "utf8");
    let meta: { synthetic: boolean; asOf: string; delayLabel: SnapshotBody["delayLabel"] } | null = null;
    try { const b = (JSON.parse(text) as Envelope<SnapshotBody>).body; meta = { synthetic: b.synthetic === true, asOf: b.asOf, delayLabel: b.delayLabel }; } catch { /* not an envelope */ }
    if (cache.size > 400) cache.clear();
    const e = { sig, text, meta }; cache.set(file, e); return e;
  };
  const send = (req: Request, res: Response, text: string, cacheControl: string) => {
    const et = etagOf(text);
    res.set({ "Cache-Control": cacheControl, ETag: et, "Content-Type": "application/json; charset=utf-8" });
    if (req.headers["if-none-match"] === et) return void res.status(304).end();
    res.send(text);
  };
  const none = (res: Response, code: string, msg: string, status = 404) => { res.set("Cache-Control", "no-store"); res.status(status).json({ error: msg, code }); };
  const stateOf = (req: Request, res: Response): string | null => {
    const s = String(req.params.state || "").toUpperCase();
    if (!isStateCode(s)) { none(res, "bad_state", "Unknown state", 400); return null; }
    return s;
  };

  r.get("/keys", (req, res) => {
    const f = read(path.join(dir(), "keys.json"));
    if (!f) return none(res, "no_keys", "No count-day keys published yet");
    send(req, res, f.text, "public, max-age=300");
  });

  r.get("/:state/latest", (req, res) => {
    const st = stateOf(req, res); if (!st) return;
    const f = read(path.join(stateDir(dir(), st), "latest.json"));
    if (!f || !f.meta) return none(res, "no_snapshot", "No count-day snapshot for this state");
    if (f.meta.synthetic && !synthOk()) return none(res, "no_snapshot", "No count-day snapshot for this state");
    const status = readJson<{ sourceAsOf?: string; consecutiveFailures?: number }>(path.join(stateDir(dir(), st), "status.json"));
    const live = liveBlock(f.meta, status, now(), env);
    // splice the unsigned live block after the signed envelope: the envelope bytes are untouched
    send(req, res, f.text.slice(0, -1) + ',"live":' + JSON.stringify(live) + "}", "public, max-age=5, stale-while-revalidate=10");
  });

  r.get("/:state/index", (req, res) => {
    const st = stateOf(req, res); if (!st) return;
    const f = read(path.join(stateDir(dir(), st), "index.json"));
    if (!f) return none(res, "no_snapshot", "No count-day index for this state");
    send(req, res, f.text, "public, max-age=5, stale-while-revalidate=10");
  });

  r.get("/:state/snapshots/:seq", (req, res) => {
    const st = stateOf(req, res); if (!st) return;
    if (!/^[1-9]\d{0,7}$/.test(req.params.seq)) return none(res, "bad_seq", "Bad sequence number", 400);
    const f = read(path.join(stateDir(dir(), st), "snapshots", `${req.params.seq}.json`));
    if (!f || (f.meta?.synthetic && !synthOk())) return none(res, "no_snapshot", "No such snapshot");
    send(req, res, f.text, IMMUTABLE);
  });

  r.get("/:state/ac/:acNo", (req, res) => {
    const st = stateOf(req, res); if (!st) return;
    if (!/^[1-9]\d{0,3}$/.test(req.params.acNo)) return none(res, "bad_ac", "Bad constituency number", 400);
    const f = read(path.join(stateDir(dir(), st), "ac", `${req.params.acNo}.json`));
    if (!f) return none(res, "no_snapshot", "No such constituency");
    let synthetic = false; try { synthetic = (JSON.parse(f.text) as { body: { synthetic: boolean } }).body.synthetic === true; } catch { /* ignore */ }
    if (synthetic && !synthOk()) return none(res, "no_snapshot", "No such constituency");
    send(req, res, f.text, "public, max-age=5, stale-while-revalidate=10");
  });

  /* ---- two-person review gate (admin role + audit) ---- */
  const decisionsFile = (st: string) => path.join(stateDir(dir(), st), "review", "decisions.json");
  r.get("/:state/review", requireRole("admin"), (req, res) => {
    const st = stateOf(req, res); if (!st) return;
    auditPrivilegedRead(req.person!.id, `countday:${st}:review`, "countday review queue");
    const pending = readJson<Record<string, PendingItem>>(path.join(stateDir(dir(), st), "review", "pending.json")) ?? {};
    const decisions = readJson<Decisions>(decisionsFile(st)) ?? {};
    res.set("Cache-Control", "no-store");
    res.json({ approvalsNeeded: APPROVALS_NEEDED, items: Object.values(pending).map((p) => ({ ...p, approvals: (decisions[p.id]?.approvals ?? []).length, rejected: (decisions[p.id]?.rejections ?? []).length > 0 })) });
  });
  const decide = (kind: "approve" | "reject") => (req: Request, res: Response) => {
    const st = stateOf(req, res); if (!st) return;
    const id = String(req.params.id);
    const pending = readJson<Record<string, PendingItem>>(path.join(stateDir(dir(), st), "review", "pending.json")) ?? {};
    const item = pending[id];
    res.set("Cache-Control", "no-store");
    if (!item) return void res.status(404).json({ error: "no such held item", code: "no_item" });
    if (item.kind === "invalid") return void res.status(409).json({ error: "invalid figures cannot be approved; the feed must be corrected", code: "not_approvable" });
    const person = req.person!.id;
    const decisions = readJson<Decisions>(decisionsFile(st)) ?? {};
    const d = decisions[id] ?? { approvals: [], rejections: [] };
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : undefined;
    const rec = { person, at: now().toISOString(), note };
    if (kind === "approve") {
      if (d.approvals.some((a) => a.person === person)) return void res.status(409).json({ error: "you already approved this item", code: "duplicate_approval" });
      d.approvals.push(rec);
    } else if (!d.rejections.some((a) => a.person === person)) d.rejections.push(rec);
    decisions[id] = d;
    writeAtomic(decisionsFile(st), JSON.stringify(decisions, null, 2));
    audit(person, `countday.review.${kind}`, `${st}:${id}`, { acNo: item.acNo, reasons: item.reasons, approvals: d.approvals.length });
    const approved = new Set(d.approvals.map((a) => a.person)).size;
    res.json({ id, approvals: approved, approvalsNeeded: APPROVALS_NEEDED, rejected: d.rejections.length > 0, releasedOnNextSnapshot: approved >= APPROVALS_NEEDED && d.rejections.length === 0 });
  };
  r.post("/:state/review/:id/approve", requireRole("admin"), decide("approve"));
  r.post("/:state/review/:id/reject", requireRole("admin"), decide("reject"));
  return r;
}
export type { KeysFile };
