import fs from "node:fs";
import path from "node:path";
import { getDb, registerMigration } from "../core";

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

export function importGeo(d: GeoDataset): { units: number; hamlets: number; links: number } {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const u = db.prepare("INSERT OR REPLACE INTO admin_unit VALUES (?,?,?,?,?,?,?)");
    for (const x of d.units) u.run(x.lgd, x.level, x.en, x.te ?? null, x.parent, x.from, x.to);
    const h = db.prepare("INSERT OR REPLACE INTO hamlet (id,name_en,name_te,village_lgd,reviewed) VALUES (?,?,?,?,0)");
    for (const x of d.hamlets) h.run(x.id, x.en, x.te ?? null, x.village);
    const l = db.prepare("INSERT OR REPLACE INTO village_constituency VALUES (?,?,?,?)");
    for (const x of d.villageConstituency) l.run(x.village, x.constituency, x.from, x.to);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { units: d.units.length, hamlets: d.hamlets.length, links: d.villageConstituency.length };
}

export function loadDemoGeo(): void {
  const p = path.resolve(process.cwd(), "data/civic/demo-geo.json");
  importGeo(JSON.parse(fs.readFileSync(p, "utf8")));
}

/** Seeds the DEMO fixture only when no units exist (dev/test convenience; never overwrites real imports). */
export function ensureGeo(): void {
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
  for (const h of db.prepare("SELECT * FROM hamlet WHERE lower(name_en) LIKE ? OR name_te LIKE ? LIMIT ?").all(like, `%${term}%`, limit) as any[])
    add(getUnit(h.village_lgd, a), { id: h.id, name_en: h.name_en, name_te: h.name_te });
  for (const r of db.prepare(`SELECT * FROM admin_unit WHERE level='village' AND ${VALID} AND (lower(name_en) LIKE ? OR name_te LIKE ?) LIMIT ?`).all(a, a, like, `%${term}%`, limit) as any[])
    add(toUnit(r), null);
  return hits.slice(0, limit);
}
