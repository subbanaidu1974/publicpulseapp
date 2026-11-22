import fs from "node:fs";
import path from "node:path";
import { audit, getDb, registerMigration } from "../core";
import { isProductionEnv } from "../guards";
import { AcLink } from "../../../pipeline/geo/link";
import type { StateCode } from "../../../src/lib/states";

registerMigration("geo_001", `
CREATE TABLE IF NOT EXISTS admin_unit (
  lgd_code TEXT NOT NULL, level TEXT NOT NULL, name_en TEXT NOT NULL, name_te TEXT,
  parent_lgd TEXT, valid_from TEXT NOT NULL, valid_to TEXT,
  PRIMARY KEY (lgd_code, valid_from)
);
CREATE TABLE IF NOT EXISTS hamlet (
  id TEXT PRIMARY KEY, name_en TEXT NOT NULL, name_te TEXT, village_lgd TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS village_constituency (
  village_lgd TEXT NOT NULL, constituency_lgd TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT,
  PRIMARY KEY (village_lgd, constituency_lgd, valid_from)
);
`);

export const LEVELS = ["state", "district", "constituency", "mandal", "village"] as const;
export interface GeoDataset {
  units: { lgd: string; level: string; en: string; te?: string; parent: string | null; from: string; to: string | null }[];
  hamlets: { id: string; en: string; te?: string; village: string }[];
  villageConstituency: { village: string; constituency: string; from: string; to: string | null }[];
}

const day = (d?: string | Date) => (d instanceof Date ? d : d ? new Date(d) : new Date()).toISOString().slice(0, 10);
/** valid_from <= asOf < valid_to (to exclusive, null = open). */
const VALID = "valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";

/** S-101: any DEMO fixture row (ids start with "DEMO-") is refused in production unless CIVIC_ALLOW_DEMO=1. */
export function assertNoDemoInProduction(d: GeoDataset): void {
  if (!isProductionEnv() || process.env.CIVIC_ALLOW_DEMO === "1") return;
  const demo = (s: string | null | undefined) => typeof s === "string" && s.startsWith("DEMO-");
  if (d.units.some(u => demo(u.lgd) || demo(u.parent)) || d.hamlets.some(h => demo(h.id) || demo(h.village)) || d.villageConstituency.some(l => demo(l.village) || demo(l.constituency))) {
    throw new Error("refusing to import DEMO geography in production (set CIVIC_ALLOW_DEMO=1 only for a non-public demo)");
  }
}

/** Hamlets are imported unreviewed (reviewed=0) and stay out of public search until a reviewer approves them (1); rejected = -1. */
export function importGeo(d: GeoDataset, opts: { hamletsReviewed?: boolean } = {}): { units: number; hamlets: number; links: number } {
  assertNoDemoInProduction(d);
  const db = getDb();
  db.exec("BEGIN");
  try {
    const u = db.prepare("INSERT OR REPLACE INTO admin_unit VALUES (?,?,?,?,?,?,?)");
    for (const x of d.units) u.run(x.lgd, x.level, x.en, x.te ?? null, x.parent, x.from, x.to);
    const h = db.prepare("INSERT INTO hamlet (id,name_en,name_te,village_lgd,reviewed) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name_en=excluded.name_en, name_te=excluded.name_te, village_lgd=excluded.village_lgd");
    for (const x of d.hamlets) h.run(x.id, x.en, x.te ?? null, x.village, opts.hamletsReviewed ? 1 : 0);
    const l = db.prepare("INSERT OR REPLACE INTO village_constituency VALUES (?,?,?,?)");
    for (const x of d.villageConstituency) l.run(x.village, x.constituency, x.from, x.to);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { units: d.units.length, hamlets: d.hamlets.length, links: d.villageConstituency.length };
}

export function loadDemoGeo(): void {
  const p = path.resolve(process.cwd(), "data/civic/demo-geo.json");
  importGeo(JSON.parse(fs.readFileSync(p, "utf8")), { hamletsReviewed: true }); // the labelled DEMO fixture needs no human review
}

/** Seeds the DEMO fixture only when no units exist (dev/test convenience; never overwrites real imports). */
export function ensureGeo(): void {
  if (isProductionEnv() && process.env.CIVIC_ALLOW_DEMO !== "1") return; // S-55: never seed DEMO geography in production
  const r = getDb().prepare("SELECT COUNT(*) c FROM admin_unit").get() as { c: number };
  if (r.c === 0) loadDemoGeo();
}

export interface Unit { lgd: string; level: string; name_en: string; name_te: string | null; parent: string | null; valid_from: string; valid_to: string | null }
const toUnit = (r: any): Unit => ({ lgd: r.lgd_code, level: r.level, name_en: r.name_en, name_te: r.name_te, parent: r.parent_lgd, valid_from: r.valid_from, valid_to: r.valid_to });

export function getUnit(lgd: string, asOf?: string | Date): Unit | null {
  const a = day(asOf);
  const r = getDb().prepare(`SELECT * FROM admin_unit WHERE lgd_code=? AND ${VALID} ORDER BY valid_from DESC LIMIT 1`).get(lgd, a, a);
  return r ? toUnit(r) : null;
}

/** Chain from the unit up to the state (unit first). */
export function ancestors(lgd: string, asOf?: string | Date): Unit[] {
  const out: Unit[] = [];
  let cur = getUnit(lgd, asOf);
  while (cur && out.length < 8) { out.push(cur); cur = cur.parent ? getUnit(cur.parent, asOf) : null; }
  return out;
}

export function villageConstituencies(village: string, asOf?: string | Date): Unit[] {
  const a = day(asOf);
  const rows = getDb().prepare(`SELECT constituency_lgd FROM village_constituency WHERE village_lgd=? AND ${VALID}`).all(village, a, a) as { constituency_lgd: string }[];
  return rows.map(r => getUnit(r.constituency_lgd, a)).filter((x): x is Unit => !!x);
}

export interface SearchHit { village: Unit; hamlet: { id: string; name_en: string; name_te: string | null } | null; path: string[] }
/** Search hamlet and village names in Telugu or English; results resolve to a village. */
export function search(q: string, asOf?: string | Date, limit = 20): SearchHit[] {
  const term = q.trim();
  if (!term) return [];
  const db = getDb(), a = day(asOf);
  const like = `%${term.toLowerCase().replace(/[%_]/g, "")}%`;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const add = (v: Unit | null, hamlet: SearchHit["hamlet"]) => {
    if (!v) return;
    const k = v.lgd + "|" + (hamlet?.id ?? "");
    if (seen.has(k)) return;
    seen.add(k);
    hits.push({ village: v, hamlet, path: ancestors(v.lgd, a).map(u => u.name_en).reverse() });
  };
  for (const h of db.prepare("SELECT * FROM hamlet WHERE reviewed=1 AND (lower(name_en) LIKE ? OR name_te LIKE ?) LIMIT ?").all(like, `%${term}%`, limit) as any[])
    add(getUnit(h.village_lgd, a), { id: h.id, name_en: h.name_en, name_te: h.name_te });
  for (const r of db.prepare(`SELECT * FROM admin_unit WHERE level='village' AND ${VALID} AND (lower(name_en) LIKE ? OR name_te LIKE ?) LIMIT ?`).all(a, a, like, `%${term}%`, limit) as any[])
    add(toUnit(r), null);
  return hits.slice(0, limit);
}

/** S-102: the election constituency (ECI acNo) behind a civic constituency unit (real LGD import: "AC-<lgd>"), as of a date. */
let acLink: AcLink | null = null;
export function electionConstituency(constituencyLgd: string, asOf?: string | Date): { state: StateCode; acNo: number; name: string; pcNo: number | null; reservation: string | null } | null {
  acLink ??= AcLink.load();
  const r = acLink.byLgd(constituencyLgd.replace(/^AC-/, ""), asOf ? day(asOf) : undefined);
  return r ? { state: r.state, acNo: r.acNo, name: r.name, pcNo: r.pcNo, reservation: r.reservation } : null;
}
/** Test hook: drop the cached link table. */
export function resetAcLinkForTests(link?: AcLink): void { acLink = link ?? null; }

/* ---------- S-101: hamlet gazetteer review ---------- */
export type HamletStatus = "unreviewed" | "approved" | "rejected";
const STATUS_CODE: Record<HamletStatus, number> = { unreviewed: 0, approved: 1, rejected: -1 };
export interface HamletRow { id: string; name_en: string; name_te: string | null; village_lgd: string; status: HamletStatus; path: string[] }
const statusOf = (n: number): HamletStatus => (n === 1 ? "approved" : n === -1 ? "rejected" : "unreviewed");

export function listHamlets(status: HamletStatus = "unreviewed", limit = 50, offset = 0): { total: number; items: HamletRow[] } {
  const db = getDb();
  const code = STATUS_CODE[status];
  const total = (db.prepare("SELECT COUNT(*) c FROM hamlet WHERE reviewed=?").get(code) as { c: number }).c;
  const rows = db.prepare("SELECT * FROM hamlet WHERE reviewed=? ORDER BY id LIMIT ? OFFSET ?").all(code, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)) as any[];
  return {
    total,
    items: rows.map(r => ({ id: r.id, name_en: r.name_en, name_te: r.name_te, village_lgd: r.village_lgd, status: statusOf(r.reviewed), path: ancestors(r.village_lgd).map(u => u.name_en).reverse() })),
  };
}

/** Approve or reject a hamlet; audited. The reviewer id is the audit actor; names are not written to the log. */
export function reviewHamlet(id: string, reviewerId: string, decision: "approve" | "reject", note?: string): HamletRow | null {
  const db = getDb();
  const cur = db.prepare("SELECT * FROM hamlet WHERE id=?").get(id) as any;
  if (!cur) return null;
  const next = decision === "approve" ? 1 : -1;
  db.prepare("UPDATE hamlet SET reviewed=? WHERE id=?").run(next, id);
  audit(reviewerId, decision === "approve" ? "geo.hamlet.approve" : "geo.hamlet.reject", "hamlet:" + id, { village: cur.village_lgd, from: statusOf(cur.reviewed), ...(note ? { note: note.slice(0, 200) } : {}) });
  return { id, name_en: cur.name_en, name_te: cur.name_te, village_lgd: cur.village_lgd, status: statusOf(next), path: ancestors(cur.village_lgd).map(u => u.name_en).reverse() };
}
