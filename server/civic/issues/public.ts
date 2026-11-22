/**
 * Public, unauthenticated issue outputs (S-139, S-148): categories, public detail, filtered feed and list with cursor pagination,
 * and the bulk export. Everything here is identical for every caller, never carries the reporter id or any personal field, and only
 * covers issues whose moderation state is "ok". Free text is sanitised again on the way out (defence in depth behind moderation).
 */
import { getStore } from "../core";

const getDb = () => getStore("issues");
import { ancestors, electionConstituency, getUnit, villageConstituencies, type Unit } from "../geo/service";
import { CATEGORY_LIST, TRUST_TIERS } from "./categories";
import { HttpError, clock } from "./service";

// ---------- categories ----------
export function categoriesPayload() {
  return {
    categories: CATEGORY_LIST.map(c => ({ id: c.id, label_en: c.label_en, label_te: c.label_te, icon: c.icon, ivr_digit: c.ivrDigit, department: c.department, sla_hours: c.slaHours })),
    trust_tiers: TRUST_TIERS.map(t => ({ ...t })),
  };
}

// ---------- sanitising ----------
/** Mask phone numbers, Aadhaar-like numbers and e-mail addresses; drop control characters; cap length. */
export function sanitizeDescription(text: string | null | undefined, max = 2000): string | null {
  if (!text) return null;
  let s = String(text).normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠﻿]/g, "");
  s = s.replace(/[\w.+-]+\s*@\s*[\w-]+(?:\.[\w-]+)+/g, "[hidden]");
  s = s.replace(/(?<!\d)(?:\+?\d[\s-]?){10,13}(?!\d)/g, "[hidden]");
  s = s.replace(/(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g, "[hidden]");
  return s.slice(0, max).trim() || null;
}

// ---------- place helpers ----------
interface UnitRef { lgd: string; name_en: string; name_te: string | null }
const ref = (u: Unit | undefined | null): UnitRef | null => (u ? { lgd: u.lgd, name_en: u.name_en, name_te: u.name_te } : null);
interface Place { village: UnitRef | null; mandal: UnitRef | null; district: UnitRef | null; constituency: (UnitRef & { ac_no?: number }) | null; ids: Set<string> }
export function createPlaceResolver(now = clock.now()) {
  const cache = new Map<string, Place>();
  return (village: string): Place => {
    let p = cache.get(village);
    if (p) return p;
    const chain = ancestors(village, now);
    const cons = villageConstituencies(village, now).sort((a, b) => a.lgd.localeCompare(b.lgd))[0];
    let consRef: Place["constituency"] = null;
    if (cons) {
      consRef = ref(cons);
      try { const ac = electionConstituency(cons.lgd, now); if (ac && consRef) consRef = { ...consRef, ac_no: ac.acNo }; } catch { /* AC link data not available */ }
    }
    p = {
      village: ref(chain.find(u => u.level === "village")), mandal: ref(chain.find(u => u.level === "mandal")), district: ref(chain.find(u => u.level === "district")),
      constituency: consRef,
      ids: new Set([...chain.map(u => u.lgd), ...villageConstituencies(village, now).map(u => u.lgd)]),
    };
    cache.set(village, p);
    return p;
  };
}

export interface Filters { q?: string; village?: string; mandal?: string; district?: string; constituency?: string; category?: string; status?: string }
const UNIT_KEYS = ["village", "mandal", "district", "constituency"] as const;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : undefined);
export function parseFilters(q: Record<string, unknown>): Filters {
  const f: Filters = {};
  for (const k of [...UNIT_KEYS, "category", "status", "q"] as const) { const v = str(q[k]); if (v) f[k] = v; }
  return f;
}
/** Returns a predicate over village lgd codes, validating each unit filter against its level. */
function villagePredicate(f: Filters, now: Date) {
  const place = createPlaceResolver(now);
  const wanted: string[] = [];
  for (const k of UNIT_KEYS) {
    const v = f[k];
    if (!v) continue;
    const u = getUnit(v, now);
    if (!u || u.level !== k) throw new HttpError(400, `${k} must be a valid ${k} LGD code`, { field: k });
    wanted.push(v);
  }
  if (f.category && !CATEGORY_LIST.some(c => c.id === f.category)) throw new HttpError(400, "unknown category", { categories: CATEGORY_LIST.map(c => c.id) });
  return { place, match: (village: string) => wanted.every(w => place(village).ids.has(w)) };
}
const clampLimit = (n: unknown, def: number, max: number) => Math.min(Math.max(Math.floor(Number(n)) || def, 1), max);

// ---------- detail ----------
export function publicIssue(id: string, now = clock.now()) {
  const db = getDb();
  const i = db.prepare("SELECT * FROM issue WHERE id=? AND moderation='ok'").get(id) as any;
  if (!i) throw new HttpError(404, "issue not found");
  const place = createPlaceResolver(now)(i.village_lgd);
  const timeline = (db.prepare("SELECT type, status, at FROM issue_event WHERE issue_id=? ORDER BY seq").all(id) as { type: string; status: string | null; at: string }[])
    .map(e => ({ type: e.type, status: e.status, at: e.at }));
  const support = (db.prepare("SELECT COUNT(*) c FROM issue_me_too WHERE issue_id=?").get(id) as { c: number }).c;
  const responses = db.prepare("SELECT officer_tag, text, at FROM officer_rebuttal WHERE issue_id=? ORDER BY at").all(id) as { officer_tag: string; text: string; at: string }[];
  const mediaId = (ref: string | null) => (ref?.startsWith("media:") ? ref.slice(6) : null);
  return {
    id: i.id, category: i.category, department: i.department, status: i.status,
    village: place.village, mandal: place.mandal, district: place.district, constituency: place.constituency,
    description_en: sanitizeDescription(i.desc_en), description_te: sanitizeDescription(i.desc_te),
    lat: i.lat ?? null, lon: i.lon ?? null, // already rounded to ~100 m at write time
    has_photo: !!i.photo_ref, has_voice: !!i.voice_ref, photo_media_id: mediaId(i.photo_ref), voice_media_id: mediaId(i.voice_ref),
    created_at: i.created_at, updated_at: i.updated_at, sla_due: i.sla_due, resolved_at: i.resolved_at, esc_level: i.esc_level,
    can_appeal: false, // public view; the reporter's own held issue is not public (see GET /issues/mine/:id)
    timeline,
    counts: { support, officer_responses: responses.length },
    officer_responses: responses.map(r => ({ officer_tag: r.officer_tag, text: sanitizeDescription(r.text), at: r.at })),
  };
}

// ---------- feed with filters ----------
export function feedPage(q: Record<string, unknown>, now = clock.now()) {
  const f = parseFilters(q);
  const { place, match } = villagePredicate(f, now);
  const since = Number(q.cursor ?? q.since) || 0;
  const limit = clampLimit(q.limit, 200, 500);
  const db = getDb();
  const sql = db.prepare(`SELECT e.seq, e.issue_id, e.type, e.status, e.village_lgd, e.category, e.department, e.at
    FROM issue_event e JOIN issue i ON i.id=e.issue_id WHERE e.seq>? AND (i.moderation='ok' OR e.type='taken_down') ORDER BY e.seq LIMIT 500`);
  const events: any[] = [];
  let cursor = since, exhausted = false;
  scan: for (;;) {
    const rows = sql.all(cursor) as any[];
    if (!rows.length) { exhausted = true; break; }
    for (const r of rows) {
      if (events.length >= limit) break scan;
      cursor = r.seq;
      if (f.category && r.category !== f.category) continue;
      if (f.status && r.status !== f.status) continue;
      if (r.village_lgd && (UNIT_KEYS.some(k => f[k])) && !match(r.village_lgd)) continue;
      if (!r.village_lgd && UNIT_KEYS.some(k => f[k])) continue;
      events.push(r.village_lgd ? { ...r, mandal_lgd: place(r.village_lgd).mandal?.lgd ?? null, district_lgd: place(r.village_lgd).district?.lgd ?? null } : r);
    }
    if (rows.length < 500) { exhausted = true; break; }
  }
  const has_more = !exhausted || !!db.prepare("SELECT 1 x FROM issue_event WHERE seq>? LIMIT 1").get(cursor);
  return { events, next: cursor, next_cursor: has_more ? cursor : null, has_more };
}

// ---------- list with cursor ----------
const encodeCursor = (created: string, id: string) => Buffer.from(`${created}|${id}`).toString("base64url");
function decodeCursor(c: unknown): { created: string; id: string } | null {
  if (typeof c !== "string" || !c) return null;
  const [created, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
  if (!created || !id) throw new HttpError(400, "invalid cursor");
  return { created, id };
}
const ISSUE_COLS = "i.id, i.category, i.department, i.status, i.village_lgd, i.created_at, i.updated_at, i.resolved_at, i.esc_level, i.lat, i.lon, i.desc_en, i.desc_te, i.photo_ref, i.voice_ref, (SELECT COUNT(*) FROM issue_me_too m WHERE m.issue_id=i.id) AS support";

function pageIssues(q: Record<string, unknown>, now: Date, defLimit: number, maxLimit: number) {
  const f = parseFilters(q);
  const { place, match } = villagePredicate(f, now);
  const limit = clampLimit(q.limit, defLimit, maxLimit);
  const cur = decodeCursor(q.cursor);
  const where = ["i.moderation='ok'"], params: (string | number)[] = [];
  if (f.category) { where.push("i.category=?"); params.push(f.category); }
  if (f.status) { where.push("i.status=?"); params.push(f.status); }
  if (f.village) { where.push("i.village_lgd=?"); params.push(f.village); }
  if (f.q) { where.push("(lower(i.desc_en) LIKE ? OR i.desc_te LIKE ?)"); params.push(`%${f.q.toLowerCase().replace(/[%_]/g, "")}%`, `%${f.q.replace(/[%_]/g, "")}%`); }
  const sinceCreated = str(q.created_since);
  if (sinceCreated) { where.push("i.created_at>=?"); params.push(sinceCreated); }
  const stmt = getDb().prepare(`SELECT ${ISSUE_COLS} FROM issue i WHERE ${where.join(" AND ")} AND (? IS NULL OR i.created_at < ? OR (i.created_at = ? AND i.id < ?)) ORDER BY i.created_at DESC, i.id DESC LIMIT 500`);
  const out: any[] = [];
  let pos = cur, more = false;
  const needFilter = UNIT_KEYS.some(k => f[k] && k !== "village");
  scan: for (;;) {
    const rows = stmt.all(...params, pos?.created ?? null, pos?.created ?? "", pos?.created ?? "", pos?.id ?? "") as any[];
    for (const r of rows) {
      pos = { created: r.created_at, id: r.id };
      if (needFilter && !match(r.village_lgd)) continue;
      out.push(r);
      if (out.length > limit) { more = true; break scan; } // one extra row proves there is a next page
    }
    if (rows.length < 500) break;
  }
  if (more) out.pop();
  const lastRow = out[out.length - 1];
  const last = lastRow ? { created: lastRow.created_at as string, id: lastRow.id as string } : cur;
  return { out, last, more, place, limit };
}

export function listIssues(q: Record<string, unknown>, now = clock.now()) {
  const { out, last, more, place } = pageIssues(q, now, 50, 100);
  const items = out.map(r => {
    const p = place(r.village_lgd);
    return {
      id: r.id, category: r.category, department: r.department, status: r.status,
      village: p.village, mandal: p.mandal, district: p.district, constituency: p.constituency,
      snippet: (sanitizeDescription(r.desc_en ?? r.desc_te, 160)) ?? null, snippet_te: sanitizeDescription(r.desc_te, 160),
      lat: r.lat, lon: r.lon, has_photo: !!r.photo_ref, support: r.support,
      created_at: r.created_at, updated_at: r.updated_at, resolved_at: r.resolved_at,
    };
  });
  const next_cursor = more && last ? encodeCursor(last.created, last.id) : null;
  return { items, next_cursor, has_more: more };
}

// ---------- bulk export ----------
export const EXPORT_COLUMNS = ["id", "category", "department", "status", "village_lgd", "mandal_lgd", "district_lgd", "constituency_lgd", "created_at", "updated_at", "resolved_at", "support", "esc_level"] as const;
export const exportMaxRows = () => Number(process.env.CIVIC_EXPORT_MAX_ROWS || 10000);
export const exportPerHour = () => Number(process.env.CIVIC_EXPORT_PER_HOUR || 20);

/** Fixed-window limiter for the export (per client address; the response itself never depends on who asks). */
const exportHits = new Map<string, { start: number; n: number }>();
export function exportRateAllow(key: string, nowMs = Date.now()): { ok: boolean; retryAfterSec: number } {
  const w = 3_600_000, h = exportHits.get(key);
  if (!h || nowMs - h.start >= w) { exportHits.set(key, { start: nowMs, n: 1 }); if (exportHits.size > 5000) for (const [k, v] of exportHits) if (nowMs - v.start >= w) exportHits.delete(k); return { ok: true, retryAfterSec: 0 }; }
  if (h.n >= exportPerHour()) return { ok: false, retryAfterSec: Math.ceil((w - (nowMs - h.start)) / 1000) };
  h.n++;
  return { ok: true, retryAfterSec: 0 };
}
export function resetExportRate(): void { exportHits.clear(); }

export function exportRows(q: Record<string, unknown>, now = clock.now()) {
  const { out, last, more, place } = pageIssues(q, now, exportMaxRows(), exportMaxRows());
  const rows = out.map(r => {
    const p = place(r.village_lgd);
    return {
      id: r.id, category: r.category, department: r.department, status: r.status,
      village_lgd: r.village_lgd, mandal_lgd: p.mandal?.lgd ?? null, district_lgd: p.district?.lgd ?? null, constituency_lgd: p.constituency?.lgd ?? null,
      created_at: r.created_at, updated_at: r.updated_at, resolved_at: r.resolved_at ?? null, support: r.support, esc_level: r.esc_level,
    };
  });
  return { rows, next_cursor: more && last ? encodeCursor(last.created, last.id) : null };
}
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Record<string, unknown>[]) => [EXPORT_COLUMNS.join(","), ...rows.map(r => EXPORT_COLUMNS.map(c => csvCell(r[c])).join(","))].join("\n") + "\n";
export const toNdjson = (rows: Record<string, unknown>[]) => rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
