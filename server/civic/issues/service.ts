import { randomUUID } from "node:crypto";
import { audit, getDb, getKeys, getStore, hasRole, listRolesDetailed, registerErasureHook, registerErasureSubjects, registerMigration, registerStoreErasureHook } from "../core";
import { actorPseudonym, linkPerson, pseudonymsOf, randomVillageReporters, reporterPseudonym } from "../core/pseudonyms";
import { rateAllow } from "../identity/service";
import { ancestors, ensureGeo, getUnit, villageConstituencies, type Unit } from "../geo/service";
import { assessText, needsReview } from "./moderation";
import { MediaError, attachMedia, claimMedia, purgeExpiredMedia, retentionPolicy, roundCoord } from "./media";
import { CATEGORY_MAP } from "./categories";
import { pruneIvrCalls } from "../channels/callstore";

export { assessText, needsReview };

/** The issues store (S-74): no persons.id; people appear as keyed pseudonyms (server/civic/core/pseudonyms.ts). */
const idb = () => getStore("issues");

registerMigration("issues_001", `
CREATE TABLE IF NOT EXISTS issue (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, desc_en TEXT, desc_te TEXT, photo_ref TEXT,
  lat REAL, lon REAL, village_lgd TEXT NOT NULL, department TEXT NOT NULL,
  status TEXT NOT NULL, moderation TEXT NOT NULL DEFAULT 'ok',
  reporter_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  sla_due TEXT, esc_level INTEGER NOT NULL DEFAULT 0, jurisdiction_lgd TEXT,
  assigned_officer TEXT, resolved_at TEXT, confirm_deadline TEXT, confirm_basis TEXT
);
CREATE INDEX IF NOT EXISTS issue_village ON issue(village_lgd, category);
CREATE TABLE IF NOT EXISTS issue_me_too (
  issue_id TEXT NOT NULL, person_id TEXT NOT NULL, at TEXT NOT NULL, self INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, person_id)
);
CREATE TABLE IF NOT EXISTS issue_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT,
  village_lgd TEXT, category TEXT, department TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_sample (issue_id TEXT NOT NULL, person_id TEXT NOT NULL, vote TEXT, PRIMARY KEY (issue_id, person_id));
CREATE TABLE IF NOT EXISTS officer_rebuttal (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, officer_tag TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issue_appeal (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, person_id TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, at TEXT NOT NULL, decided_at TEXT);
`, "issues");

registerMigration("issues_002", `
ALTER TABLE issue ADD COLUMN moderation_reason TEXT;
ALTER TABLE issue ADD COLUMN voice_ref TEXT;
`, "issues");

registerMigration("issues_003", `
ALTER TABLE issue ADD COLUMN gps_enc TEXT;
ALTER TABLE issue ADD COLUMN gps_exact_until TEXT;
ALTER TABLE issue ADD COLUMN mod_escalated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE officer_rebuttal ADD COLUMN author_id TEXT;
CREATE TABLE IF NOT EXISTS moderation_action (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, actor_id TEXT NOT NULL, decision TEXT NOT NULL, note TEXT, reasons TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_action_issue ON moderation_action(issue_id);
CREATE TABLE IF NOT EXISTS lexicon_change (
  id TEXT PRIMARY KEY, op TEXT NOT NULL, list TEXT NOT NULL, term TEXT NOT NULL, status TEXT NOT NULL, proposer_id TEXT NOT NULL,
  approvals TEXT NOT NULL DEFAULT '[]', rejected_by TEXT, note TEXT, created_at TEXT NOT NULL, decided_at TEXT, applied_version INTEGER
);
`, "issues");

// officer_role is a role table keyed to persons, so it lives in the identity store (the issues store only ever sees pseudonyms).
registerMigration("issues_identity_001_officer_role", `
CREATE TABLE IF NOT EXISTS officer_role (
  person_id TEXT NOT NULL, role TEXT NOT NULL, department TEXT, jurisdiction_lgd TEXT, label TEXT,
  PRIMARY KEY (person_id, role)
);
`, "identity");

/** The nine canonical categories (see ./categories.ts, also served at GET /issues/categories). */
export const CATEGORIES: Record<string, { department: string; slaHours: number }> = CATEGORY_MAP;

export const MIN_CELL = 30;
export const ME_TOO_PER_DAY = Number(process.env.CIVIC_ME_TOO_PER_DAY ?? 5);
export const CONFIRM_WINDOW_HOURS = 72;
export const SAMPLE_SIZE = 5;
export const DEDUPE_METERS = 300;
export const gpsExactDays = () => Number(process.env.CIVIC_GPS_EXACT_DAYS || retentionPolicy().gps_exact_days);

/** Injectable clock (tests move time forward). */
export const clock = { now: (): Date => new Date() };
const iso = (d: Date) => d.toISOString();
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

// ---------- roles ----------
// Officers carry a department, which core roles do not, so the local claim table (Phase 1 stub, to be replaced by verified
// government onboarding) stays for officers and moderators. Roles granted through core (grantRole/hasRole/listRoles, admin-audited)
// are honoured too: a core "moderator" may moderate; a core "officer" acts for any department within its jurisdiction scope
// (unscoped = everywhere; a scope is an LGD code that covers its descendants and, for constituencies, its villages).
export function grantRole(personId: string, role: "officer" | "moderator", department: string | null, jurisdictionLgd: string | null, label?: string): void {
  getDb().prepare("INSERT OR REPLACE INTO officer_role VALUES (?,?,?,?,?)").run(personId, role, department, jurisdictionLgd, label ?? `${department ?? "any"}@${jurisdictionLgd ?? "any"}`);
}
export interface Role { role: string; department: string | null; jurisdiction_lgd: string | null; label: string }
export function roleOf(personId: string, role: string, scopeUnit?: string): Role | null {
  const local = (getDb().prepare("SELECT * FROM officer_role WHERE person_id=? AND role=?").get(personId, role) as unknown as Role | undefined) ?? null;
  if (local) return local;
  if (role !== "officer" && role !== "moderator") return null;
  try {
    if (!hasRole(personId, role)) return null;
    // a core grant carries its department (S-141: verified officers are granted one); an unscoped grant (no department) acts for any
    const grants = listRolesDetailed(personId).filter(r => r.role === role);
    const pick = scopeUnit ? grants.find(g => !g.jurisdiction || inUnit(scopeUnit, g.jurisdiction)) ?? grants[0] : grants[0];
    return { role, department: pick?.department ?? null, jurisdiction_lgd: pick?.jurisdiction ?? null, label: `${role}@${pick?.jurisdiction ?? "any"}` };
  } catch { return null; } // core roles table not migrated
}
/** Does this role's jurisdiction cover the village (unit is the village itself or an ancestor)? */
function covers(r: Role, village: string): boolean {
  if (!r.jurisdiction_lgd) return true;
  return inUnit(village, r.jurisdiction_lgd);
}
/** Is the village inside the unit: the unit is the village itself, an administrative ancestor, or a constituency it belongs to? */
export function inUnit(village: string, unit: string, now?: Date): boolean {
  return ancestors(village, now).some(u => u.lgd === unit) || villageConstituencies(village, now).some(u => u.lgd === unit);
}

/**
 * Escalation chain, lowest first: village -> mandal -> district -> constituency liaison -> state.
 * The constituency is the village's current constituency (if a village is split across two, the lowest LGD code is used);
 * villages with no constituency link skip that step.
 */
export function escalationChain(village: string, now?: Date): Unit[] {
  const admin = ancestors(village, now);
  const cons = villageConstituencies(village, now).sort((a, b) => a.lgd.localeCompare(b.lgd))[0];
  if (!cons) return admin;
  const d = admin.findIndex(u => u.level === "district");
  const at = d === -1 ? admin.length : d + 1;
  return [...admin.slice(0, at), cons, ...admin.slice(at)];
}

// ---------- moderation: see ./moderation.ts (layered rules, hold-for-review default) ----------
function placeNames(village: Unit, now: Date): string[] {
  const names = ancestors(village.lgd, now).flatMap(u => [u.name_en, u.name_te ?? ""]);
  const hamlets = idb().prepare("SELECT name_en, name_te FROM hamlet WHERE village_lgd=?").all(village.lgd) as { name_en: string; name_te: string | null }[];
  for (const h of hamlets) names.push(h.name_en, h.name_te ?? "");
  return names.filter(Boolean);
}

// ---------- reporting ----------
export interface ReportInput { category?: string; description_en?: string; description_te?: string; photo_ref?: string; voice_ref?: string; lat?: number; lon?: number; village_lgd?: string }
const tokens = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? ([] as string[])).filter(t => t.length > 1));
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i); };
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function event(issueId: string, type: string, i: { status?: string; village_lgd?: string; category?: string; department?: string } | null, now: Date) {
  idb().prepare("INSERT INTO issue_event (issue_id,type,status,village_lgd,category,department,at) VALUES (?,?,?,?,?,?,?)")
    .run(issueId, type, i?.status ?? null, i?.village_lgd ?? null, i?.category ?? null, i?.department ?? null, iso(now));
}
const OPEN = ["Reported", "Verified", "Assigned", "InProgress", "Reopened"];

export function reportIssue(personId: string, b: ReportInput, now = clock.now()) {
  ensureGeo();
  const db = idb();
  const cat = CATEGORIES[String(b.category)];
  if (!cat) throw new HttpError(400, "unknown category", { categories: Object.keys(CATEGORIES) });
  const en = typeof b.description_en === "string" ? b.description_en.trim() : "";
  const te = typeof b.description_te === "string" ? b.description_te.trim() : "";
  if (!en && !te) throw new HttpError(400, "description_en or description_te required");
  if (en.length > 2000 || te.length > 2000) throw new HttpError(400, "description too long");
  const v = typeof b.village_lgd === "string" ? getUnit(b.village_lgd, now) : null;
  if (!v || v.level !== "village") throw new HttpError(400, "village_lgd must be a valid village (use /geo/search)");
  let lat: number | null = null, lon: number | null = null;
  if (b.lat !== undefined || b.lon !== undefined) {
    if (typeof b.lat !== "number" || typeof b.lon !== "number" || Math.abs(b.lat) > 90 || Math.abs(b.lon) > 180) throw new HttpError(400, "invalid GPS");
    lat = b.lat; lon = b.lon;
  }
  // photo_ref / voice_ref: "media:<id>" from POST /issues/media (owned by the reporter), or a legacy opaque key (e.g. IVR audio key)
  const refOf = (v: unknown, kind: "photo" | "voice") => {
    if (v === undefined) return { media: null as string | null, key: null as string | null };
    if (typeof v !== "string") throw new HttpError(400, `invalid ${kind}_ref`);
    if (v.startsWith("media:")) {
      try { return { media: claimMedia(v, personId, kind) as string | null, key: v as string | null }; }
      catch (e) { if (e instanceof MediaError) throw new HttpError(e.status, e.message); throw e; }
    }
    if (!/^[\w\-./]{1,200}$/.test(v)) throw new HttpError(400, `invalid ${kind}_ref`);
    return { media: null as string | null, key: v as string | null };
  };
  const ph = refOf(b.photo_ref, "photo"), vo = refOf(b.voice_ref, "voice");

  // dedupe against open, visible issues in the same village and category
  const text = tokens(`${en} ${te}`);
  const cands = db.prepare("SELECT * FROM issue WHERE village_lgd=? AND category=? AND moderation='ok' AND status IN ('Reported','Verified','Assigned','InProgress','Reopened')").all(v.lgd, b.category) as any[];
  for (const c of cands) {
    const near = lat !== null && c.lat !== null && meters({ lat, lon: lon! }, { lat: c.lat, lon: c.lon }) <= DEDUPE_METERS;
    const similar = jaccard(text, tokens(`${c.desc_en ?? ""} ${c.desc_te ?? ""}`)) >= 0.5;
    if (near || similar) {
      const m = meTooCore(c.id, personId, now, true);
      return { id: c.id as string, merged: true, me_too_counted: m.counted, support: m.support };
    }
  }

  const verdict = assessText(`${en}\n${te}`, { knownNames: placeNames(v, now) });
  const held = verdict.verdict === "hold";
  const id = randomUUID();
  const t = iso(now);
  const me = reporterPseudonym(id, personId); // the issues store never sees the person id
  db.prepare(`INSERT INTO issue (id,category,desc_en,desc_te,photo_ref,voice_ref,lat,lon,village_lgd,department,status,moderation,moderation_reason,reporter_id,created_at,updated_at,sla_due,jurisdiction_lgd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.category!, en || null, te || null, ph.key, vo.key, lat, lon, v.lgd, cat.department, "Reported", held ? "held" : "ok", held ? verdict.reasons.join(",") : null, me, t, t, iso(addHours(now, cat.slaHours)), v.lgd);
  if (ph.media) attachMedia(ph.media, id);
  if (vo.media) attachMedia(vo.media, id);
  if (lat !== null && lon !== null) { // S-147: public coordinates are rounded (~111 m); the exact point is kept encrypted, internal, and expires
    db.prepare("UPDATE issue SET lat=?, lon=?, gps_enc=?, gps_exact_until=? WHERE id=?")
      .run(roundCoord(lat), roundCoord(lon), getKeys().encrypt("issue-gps", JSON.stringify({ lat, lon })), iso(addHours(now, gpsExactDays() * 24)), id);
  }
  db.prepare("INSERT INTO issue_me_too VALUES (?,?,?,1)").run(id, me, t);
  linkPerson(personId, "issue", id, v.lgd, now); // identity store: encrypted way back (my issues, erasure, neighbour sampling)
  audit(personId, held ? "issue.report_held" : "issue.report", `issue:${id}`, { category: b.category, village: v.lgd, held, reasons: held ? verdict.reasons : undefined });
  if (!held) event(id, "reported", { status: "Reported", village_lgd: v.lgd, category: b.category, department: cat.department }, now);
  return { id, merged: false, held, status: "Reported" };
}

function meTooCore(issueId: string, personId: string, now: Date, viaDedupe = false) {
  const db = idb();
  const me = reporterPseudonym(issueId, personId);
  const support = () => (db.prepare("SELECT COUNT(*) c FROM issue_me_too WHERE issue_id=?").get(issueId) as { c: number }).c;
  if (db.prepare("SELECT 1 FROM issue_me_too WHERE issue_id=? AND person_id=?").get(issueId, me)) return { counted: false, support: support() };
  // The per-person daily cap is counted in the identity store (the issues store cannot tell two issues' supporters are one person).
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!rateAllow("metoo:" + personId, ME_TOO_PER_DAY, Math.max(1, now.getTime() - dayStartMs), now.getTime())) {
    if (viaDedupe) return { counted: false, support: support() };
    throw new HttpError(429, "daily me-too limit reached", { limit: ME_TOO_PER_DAY });
  }
  db.prepare("INSERT INTO issue_me_too VALUES (?,?,?,0)").run(issueId, me, iso(now));
  linkPerson(personId, "issue", issueId, null, now);
  audit(personId, "issue.me_too", `issue:${issueId}`);
  return { counted: true, support: support() };
}

export function meToo(issueId: string, personId: string, now = clock.now()) {
  const i = idb().prepare("SELECT status, moderation FROM issue WHERE id=?").get(issueId) as any;
  if (!i || i.moderation !== "ok") throw new HttpError(404, "issue not found");
  return meTooCore(issueId, personId, now);
}

// ---------- workflow ----------
const NEXT: Record<string, string[]> = {
  Reported: ["Verified"], Verified: ["Assigned"], Assigned: ["InProgress", "Resolved"], InProgress: ["Resolved"], Reopened: ["Assigned"],
};
export interface TransitionInput { to?: string; action?: string; department?: string; note?: string }

/** `reporter` is the reporter's pseudonym for this issue. Supporters are drawn from the issue's own pseudonyms; the village fallback asks the identity store's link ledger. */
function sampleNeighbours(issueId: string, village: string, reporter: string) {
  const db = idb();
  const ids = new Set<string>((db.prepare("SELECT person_id FROM issue_me_too WHERE issue_id=? AND person_id<>? ORDER BY RANDOM() LIMIT ?").all(issueId, reporter, SAMPLE_SIZE) as { person_id: string }[]).map(r => r.person_id));
  if (ids.size < SAMPLE_SIZE) {
    for (const person of randomVillageReporters(village, SAMPLE_SIZE * 4)) {
      if (ids.size >= SAMPLE_SIZE) break;
      const ps = reporterPseudonym(issueId, person);
      if (ps === reporter || ids.has(ps)) continue;
      linkPerson(person, "issue", issueId); // so account erasure also reaches this sample row
      ids.add(ps);
    }
  }
  const ins = db.prepare("INSERT OR IGNORE INTO issue_sample VALUES (?,?,NULL)");
  for (const p of ids) ins.run(issueId, p);
}

function setStatus(i: any, to: string, now: Date, extra: Record<string, unknown> = {}) {
  const sets = ["status=?", "updated_at=?"], vals: any[] = [to, iso(now)];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); vals.push(v as any); }
  idb().prepare(`UPDATE issue SET ${sets.join(",")} WHERE id=?`).run(...vals, i.id);
  event(i.id, "status", { status: to, village_lgd: i.village_lgd, category: i.category, department: i.department }, now);
}
const load = (id: string) => {
  const i = idb().prepare("SELECT * FROM issue WHERE id=?").get(id) as any;
  if (!i) throw new HttpError(404, "issue not found");
  return i;
};

export function transition(issueId: string, actor: string, b: TransitionInput, now = clock.now()) {
  const i = load(issueId);
  if (i.moderation !== "ok") throw new HttpError(409, "issue is under moderation");
  const r = roleOf(actor, "officer", i.village_lgd);
  if (!r) throw new HttpError(403, "officer role required");
  if (!covers(r, i.village_lgd)) throw new HttpError(403, "outside your jurisdiction", { hint: "out_of_jurisdiction" });

  if (b.action === "out_of_jurisdiction") {
    const dep = Object.values(CATEGORIES).find(c => c.department === b.department)?.department;
    if (!dep) throw new HttpError(400, "department required (known department name)", { departments: [...new Set(Object.values(CATEGORIES).map(c => c.department))] });
    if (!OPEN.includes(i.status)) throw new HttpError(409, "issue not open");
    idb().prepare("UPDATE issue SET department=?, status='Verified', assigned_officer=NULL, updated_at=?, jurisdiction_lgd=?, esc_level=0, sla_due=? WHERE id=?")
      .run(dep, iso(now), i.village_lgd, iso(addHours(now, CATEGORIES[i.category].slaHours)), i.id);
    event(i.id, "rerouted", { status: "Verified", village_lgd: i.village_lgd, category: i.category, department: dep }, now);
    audit(actor, "issue.reroute", `issue:${i.id}`, { from: i.department, to: dep });
    return { id: i.id, status: "Verified", department: dep };
  }

  const to = String(b.to);
  if (!NEXT[i.status]?.includes(to)) throw new HttpError(409, `cannot move ${i.status} to ${to}`, { allowed: NEXT[i.status] ?? [] });
  if (r.department && r.department !== i.department) throw new HttpError(403, "outside your department", { hint: "out_of_jurisdiction" });
  const extra: Record<string, unknown> = {};
  if (to === "Assigned" || (to === "InProgress" && !i.assigned_officer)) extra.assigned_officer = r.label;
  if (to === "Resolved") {
    extra.resolved_at = iso(now);
    extra.confirm_deadline = iso(addHours(now, CONFIRM_WINDOW_HOURS));
    sampleNeighbours(i.id, i.village_lgd, i.reporter_id);
  }
  if (to === "Assigned" && i.status === "Reopened") extra.sla_due = iso(addHours(now, CATEGORIES[i.category].slaHours));
  setStatus(i, to, now, extra);
  audit(actor, "issue.transition", `issue:${i.id}`, { from: i.status, to });
  return { id: i.id, status: to, confirm_deadline: extra.confirm_deadline ?? null };
}

/** Reporter (decisive) or a sampled neighbour (counted at the deadline) votes on a Resolved issue. */
export function confirm(issueId: string, personId: string, vote: string, now = clock.now()) {
  if (vote !== "confirm" && vote !== "reopen") throw new HttpError(400, "vote must be confirm or reopen");
  const i = load(issueId);
  if (i.status !== "Resolved") throw new HttpError(409, "issue is not awaiting confirmation");
  if (now.toISOString() > i.confirm_deadline) throw new HttpError(409, "confirmation window closed");
  const me = reporterPseudonym(i.id, personId);
  if (me === i.reporter_id) {
    if (vote === "confirm") setStatus(i, "Confirmed", now, { confirm_basis: "reporter" });
    else setStatus(i, "Reopened", now, { sla_due: iso(addHours(now, CATEGORIES[i.category].slaHours)), confirm_basis: null });
    audit(personId, "issue.confirmation", `issue:${i.id}`, { vote, basis: "reporter" });
    return { status: vote === "confirm" ? "Confirmed" : "Reopened", basis: "reporter" };
  }
  const row = idb().prepare("UPDATE issue_sample SET vote=? WHERE issue_id=? AND person_id=?").run(vote, i.id, me);
  if (!row.changes) throw new HttpError(403, "not sampled for this confirmation");
  audit(personId, "issue.confirmation", `issue:${i.id}`, { vote, basis: "neighbour" });
  return { status: "Resolved", recorded: true };
}

/** Periodic job: close confirmation windows and escalate overdue issues. Returns what changed. */
export function sweep(now = clock.now()) {
  const db = idb();
  const out = { confirmed: [] as string[], reopened: [] as string[], escalated: [] as string[], mediaPurged: 0 };
  const t = iso(now);
  for (const i of db.prepare("SELECT * FROM issue WHERE status='Resolved' AND confirm_deadline<=?").all(t) as any[]) {
    const votes = db.prepare("SELECT vote, COUNT(*) c FROM issue_sample WHERE issue_id=? AND vote IS NOT NULL GROUP BY vote").all(i.id) as { vote: string; c: number }[];
    const c = votes.find(v => v.vote === "confirm")?.c ?? 0, ro = votes.find(v => v.vote === "reopen")?.c ?? 0;
    if (ro > c) {
      setStatus(i, "Reopened", now, { sla_due: iso(addHours(now, CATEGORIES[i.category].slaHours)) });
      audit("system", "issue.confirmation_closed", `issue:${i.id}`, { result: "Reopened", basis: "neighbours" });
      out.reopened.push(i.id);
    } else {
      const basis = c > 0 ? "neighbours" : "lapsed_unverified";
      setStatus(i, "Confirmed", now, { confirm_basis: basis });
      audit("system", "issue.confirmation_closed", `issue:${i.id}`, { result: "Confirmed", basis });
      out.confirmed.push(i.id);
    }
  }
  for (const i of db.prepare("SELECT * FROM issue WHERE moderation='ok' AND status IN ('Reported','Verified','Assigned','InProgress','Reopened') AND sla_due<=?").all(t) as any[]) {
    const chain = escalationChain(i.village_lgd, now);
    const level = Math.min(i.esc_level + 1, chain.length - 1);
    if (level === i.esc_level) { // already at the top: just re-arm the timer
      db.prepare("UPDATE issue SET sla_due=? WHERE id=?").run(iso(addHours(now, CATEGORIES[i.category].slaHours)), i.id);
      continue;
    }
    db.prepare("UPDATE issue SET esc_level=?, jurisdiction_lgd=?, sla_due=?, updated_at=? WHERE id=?")
      .run(level, chain[level].lgd, iso(addHours(now, CATEGORIES[i.category].slaHours)), t, i.id);
    event(i.id, "escalated", { status: i.status, village_lgd: i.village_lgd, category: i.category, department: i.department }, now);
    audit("system", "issue.escalate", `issue:${i.id}`, { to_level: chain[level].level, unit: chain[level].lgd });
    out.escalated.push(i.id);
  }
  out.mediaPurged = purgeExpiredMedia(now);
  try { pruneIvrCalls(Date.now()); } catch { /* call-state table not available */ }
  db.prepare("UPDATE issue SET gps_enc=NULL, gps_exact_until=NULL WHERE gps_enc IS NOT NULL AND gps_exact_until<=?").run(t);
  return out;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** Start the periodic sweep (SLA escalation and confirmation windows). Idempotent; a no-op when NODE_ENV=test or CIVIC_SWEEP=0. Returns true if a timer is running. */
export function startIssueSweeper(intervalMs = Number(process.env.CIVIC_SWEEP_INTERVAL_MS) || 10 * 60_000): boolean {
  if (process.env.NODE_ENV === "test" || process.env.CIVIC_SWEEP === "0") return false;
  if (sweepTimer) return true;
  sweepTimer = setInterval(() => {
    try { sweep(); } catch (e) { console.error("[civic] issue sweep failed:", (e as Error).message); }
  }, Math.max(1000, intervalMs));
  sweepTimer.unref();
  return true;
}
export function stopIssueSweeper(): void { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }
export const isIssueSweeperRunning = () => sweepTimer !== null;

// ---------- moderation ----------
export function appeal(issueId: string, personId: string, reason: string | undefined, now = clock.now()) {
  const i = load(issueId);
  const me = reporterPseudonym(issueId, personId);
  if (i.reporter_id !== me || i.moderation === "ok") throw new HttpError(404, "no moderated issue of yours with that id");
  const open = idb().prepare("SELECT id FROM issue_appeal WHERE issue_id=? AND status='pending'").get(issueId);
  if (open) throw new HttpError(409, "appeal already pending");
  const id = randomUUID();
  idb().prepare("INSERT INTO issue_appeal VALUES (?,?,?,?,?,?,NULL)").run(id, issueId, me, (reason ?? "").slice(0, 1000), "pending", iso(now));
  audit(personId, "issue.appeal", `issue:${issueId}`, { appeal: id });
  return { appeal_id: id, status: "pending" };
}

const DECISION_ALIAS: Record<string, string> = { approve: "release", reject: "takedown" };
export const isModerator = (actor: string) => !!roleOf(actor, "moderator") || safeHasRole(actor, "admin");
function safeHasRole(actor: string, role: "admin"): boolean { try { return hasRole(actor, role); } catch { return false; } }

/** Moderator decision on a held or taken-down issue. approve=release, reject=takedown, escalate hands it to an admin. Every call is audited and recorded for the curation metrics. */
export function moderate(issueId: string, actor: string, rawDecision: string, now = clock.now(), note?: string) {
  if (!isModerator(actor)) throw new HttpError(403, "moderator role required");
  const decision = DECISION_ALIAS[rawDecision] ?? rawDecision;
  const i = load(issueId);
  const db = idb();
  if (i.mod_escalated && !safeHasRole(actor, "admin") && decision !== "escalate") throw new HttpError(403, "escalated to an admin", { hint: "admin_required" });
  const record = () => db.prepare("INSERT INTO moderation_action (id,issue_id,actor_id,decision,note,reasons,at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(), i.id, actorPseudonym(actor), rawDecision === "approve" || decision === "release" ? "approve" : rawDecision === "reject" || decision === "takedown" ? "reject" : decision, (note ?? "").slice(0, 500) || null, i.moderation_reason ?? null, iso(now));
  if (decision === "escalate") {
    if (i.moderation === "ok") throw new HttpError(409, "already visible");
    db.prepare("UPDATE issue SET mod_escalated=1, updated_at=? WHERE id=?").run(iso(now), i.id);
    audit(actor, "issue.moderation_escalate", `issue:${i.id}`);
    record();
    return { id: i.id, decision: "escalate" };
  }
  if (decision === "release") {
    if (i.moderation === "ok") throw new HttpError(409, "already visible");
    db.prepare("UPDATE issue SET moderation='ok', updated_at=? WHERE id=?").run(iso(now), i.id);
    event(i.id, "reported", { status: i.status, village_lgd: i.village_lgd, category: i.category, department: i.department }, now);
    audit(actor, "issue.release", `issue:${i.id}`);
    record();
  } else if (decision === "takedown") {
    db.prepare("UPDATE issue SET moderation='taken_down', updated_at=? WHERE id=?").run(iso(now), i.id);
    event(i.id, "taken_down", null, now);
    audit(actor, "issue.takedown", `issue:${i.id}`, { previous: i.moderation });
    record();
  } else if (decision !== "uphold") throw new HttpError(400, "decision must be approve, reject, escalate, release, takedown or uphold");
  else { audit(actor, "issue.uphold", `issue:${i.id}`); record(); }
  db.prepare("UPDATE issue_appeal SET status=?, decided_at=? WHERE issue_id=? AND status='pending'").run(decision, iso(now), i.id);
  return { id: i.id, decision };
}

// ---------- officer rebuttal ----------
export function rebuttal(issueId: string, actor: string, text: string, now = clock.now()) {
  const i = load(issueId);
  const r = roleOf(actor, "officer", i.village_lgd);
  if (!r || !covers(r, i.village_lgd)) throw new HttpError(403, "officer role covering this village required");
  if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new HttpError(400, "text required (max 2000 chars)");
  const id = randomUUID();
  idb().prepare("INSERT INTO officer_rebuttal (id,issue_id,officer_tag,text,at,author_id) VALUES (?,?,?,?,?,?)").run(id, i.id, i.assigned_officer ?? r.label, text.trim(), iso(now), actorPseudonym(actor));
  audit(actor, "issue.rebuttal", `issue:${i.id}`, { id });
  return { id };
}

// ---------- public outputs ----------
export function feed(since = 0, limit = 200) {
  const rows = idb().prepare(`SELECT e.seq, e.issue_id, e.type, e.status, e.village_lgd, e.category, e.department, e.at
    FROM issue_event e JOIN issue i ON i.id=e.issue_id WHERE e.seq>? AND (i.moderation='ok' OR e.type='taken_down') ORDER BY e.seq LIMIT ?`)
    .all(since, Math.min(Math.max(limit, 1), 500)) as any[];
  return { events: rows, next: rows.length ? rows[rows.length - 1].seq : since };
}

interface Cell { unit_lgd: string; unit_level: string; unit_name: string; department: string; total: number; resolved: number; open: number; resolution_rate: number; median_response_hours: number | null; includes_rolled_up: boolean }
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };
function summarise(items: any[]) {
  const resolved = items.filter(i => i.status === "Confirmed" && i.confirm_basis !== "lapsed_unverified");
  const hrs = items.filter(i => i.resolved_at).map(i => (Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 3600_000);
  return {
    total: items.length, resolved: resolved.length, open: items.filter(i => OPEN.includes(i.status)).length,
    resolution_rate: Math.round((resolved.length / items.length) * 100) / 100, median_response_hours: median(hrs),
  };
}
const visible = () => idb().prepare("SELECT * FROM issue WHERE moderation='ok'").all() as any[];

/** Department-level metrics. Cells under MIN_CELL are never shown: they roll up to the parent unit; if the state is still too small the cell is masked. */
export function departmentMetrics(now = clock.now()) {
  const byDept = new Map<string, any[]>();
  for (const i of visible()) (byDept.get(i.department) ?? byDept.set(i.department, []).get(i.department)!).push(i);
  const cells: Cell[] = [];
  const masked: { department: string; reason: string }[] = [];
  const levels = ["village", "mandal", "district", "state"];
  for (const [department, items] of byDept) {
    let carry: any[] = [];
    const chains = new Map<string, Awaited<ReturnType<typeof ancestors>>>();
    const chainOf = (v: string) => chains.get(v) ?? (chains.set(v, ancestors(v, now)), chains.get(v)!);
    for (const lvl of levels) {
      const groups = new Map<string, { name: string; items: any[]; rolled: boolean }>();
      const place = (i: any, rolled: boolean) => {
        const u = chainOf(i.village_lgd).find(x => x.level === lvl);
        if (!u) return;
        const g = groups.get(u.lgd) ?? { name: u.name_en, items: [], rolled: false };
        g.items.push(i); g.rolled ||= rolled; groups.set(u.lgd, g);
      };
      const base = lvl === "village" ? items : [];
      base.forEach(i => place(i, false));
      carry.forEach(i => place(i, true));
      carry = [];
      for (const [lgd, g] of groups) {
        if (g.items.length >= MIN_CELL) cells.push({ unit_lgd: lgd, unit_level: lvl, unit_name: g.name, department, ...summarise(g.items), includes_rolled_up: g.rolled });
        else if (lvl === "state") masked.push({ department, reason: `fewer than ${MIN_CELL} reports` });
        else carry.push(...g.items);
      }
    }
  }
  return { level: "department", min_cell: MIN_CELL, cells, masked };
}

export function officerMetrics(actor: string, jurisdiction: string, now = clock.now()) {
  const r = roleOf(actor, "officer", jurisdiction);
  if (!r) throw new HttpError(403, "officer role required");
  if (!jurisdiction) throw new HttpError(400, "jurisdiction (LGD code) required for officer-level metrics");
  const unit = getUnit(jurisdiction, now);
  if (!unit) throw new HttpError(404, "unknown jurisdiction");
  if (r.jurisdiction_lgd && !ancestors(jurisdiction, now).some(u => u.lgd === r.jurisdiction_lgd)) throw new HttpError(403, "jurisdiction not within your role");
  const inJur = visible().filter(i => i.assigned_officer && inUnit(i.village_lgd, jurisdiction, now));
  const tags = [...new Set(inJur.map(i => i.assigned_officer as string))];
  const officers = tags.map(tag => {
    const items = inJur.filter(i => i.assigned_officer === tag);
    const reb = idb().prepare("SELECT text, at FROM officer_rebuttal WHERE officer_tag=? ORDER BY at DESC LIMIT 5").all(tag) as any[];
    const base = { officer_tag: tag, jurisdiction: { lgd: unit.lgd, level: unit.level, name: unit.name_en }, rebuttals: reb, rebuttal_field: "open" };
    return items.length >= MIN_CELL ? { ...base, masked: false, ...summarise(items) } : { ...base, masked: true, note: `fewer than ${MIN_CELL} reports` };
  });
  return { level: "officer", jurisdiction: unit.lgd, officers };
}

// ---------- S-143 / S-74: erasure completeness ----------
// Account deletion (identity deleteAccount) must leave no person id, phone hash or personal link in ANY store. The issues store holds only
// keyed pseudonyms, so its hooks receive the person's pseudonyms (collected from the identity link ledger BEFORE it is wiped) and run after
// the identity transaction commits, from the erasure outbox (idempotent; retried by the retryErasureOutbox job). Issues are a public
// record, so the issue row stays but loses its reporter link and the exact GPS point; support counts survive through pseudonymised rows.
// issue_media registers its own hook in ./media. The IVR call-state hook lives in channels. officer_role (identity store) is erased by the
// identity hook below.
const erasedTag = () => "erased:" + randomUUID().replace(/-/g, "").slice(0, 16);
const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");
/** Run `fn` over chunks of at most 500 pseudonyms (SQLite variable limit). */
const chunks = (subjects: string[], fn: (c: string[]) => void) => { for (let i = 0; i < subjects.length; i += 500) fn(subjects.slice(i, i + 500)); };

registerErasureSubjects("issues", (personId) => pseudonymsOf(personId));
registerErasureHook("issues.links", (personId) => { getDb().prepare("DELETE FROM issue_links WHERE person_id=?").run(personId); }); // identity store: the encrypted way back
registerStoreErasureHook("issues", "issues.reporter", (subjects) => chunks(subjects, (c) => {
  idb().prepare(`UPDATE issue SET reporter_id='erased', gps_enc=NULL, gps_exact_until=NULL WHERE reporter_id IN (${inList(c.length)})`).run(...c);
}));
registerStoreErasureHook("issues", "issues.me_too", (subjects) => {
  const d = idb();
  chunks(subjects, (c) => {
    for (const r of d.prepare(`SELECT issue_id, person_id FROM issue_me_too WHERE person_id IN (${inList(c.length)})`).all(...c) as { issue_id: string; person_id: string }[])
      d.prepare("UPDATE issue_me_too SET person_id=?, self=0 WHERE issue_id=? AND person_id=?").run(erasedTag(), r.issue_id, r.person_id);
  });
});
registerStoreErasureHook("issues", "issues.samples", (subjects) => chunks(subjects, (c) => { idb().prepare(`DELETE FROM issue_sample WHERE person_id IN (${inList(c.length)})`).run(...c); }));
registerStoreErasureHook("issues", "issues.appeals", (subjects) => chunks(subjects, (c) => {
  idb().prepare(`UPDATE issue_appeal SET person_id='erased', reason=NULL WHERE person_id IN (${inList(c.length)})`).run(...c);
}));
registerErasureHook("issues.officer", (personId) => { getDb().prepare("DELETE FROM officer_role WHERE person_id=?").run(personId); });
registerStoreErasureHook("issues", "issues.officer_rebuttal", (subjects) => chunks(subjects, (c) => {
  idb().prepare(`UPDATE officer_rebuttal SET author_id=NULL WHERE author_id IN (${inList(c.length)})`).run(...c);
}));
registerStoreErasureHook("issues", "issues.moderation", (subjects) => {
  const d = idb();
  chunks(subjects, (c) => {
    const ph = inList(c.length);
    d.prepare(`UPDATE moderation_action SET actor_id='erased', note=NULL WHERE actor_id IN (${ph})`).run(...c);
    d.prepare(`UPDATE lexicon_change SET proposer_id='erased' WHERE proposer_id IN (${ph})`).run(...c);
    d.prepare(`UPDATE lexicon_change SET rejected_by='erased' WHERE rejected_by IN (${ph})`).run(...c);
  });
  for (const r of d.prepare("SELECT id, approvals FROM lexicon_change WHERE approvals <> '[]'").all() as { id: string; approvals: string }[]) {
    const list = JSON.parse(r.approvals) as string[];
    if (!list.some(x => subjects.includes(x))) continue;
    d.prepare("UPDATE lexicon_change SET approvals=? WHERE id=?").run(JSON.stringify(list.map(x => (subjects.includes(x) ? "erased" : x))), r.id);
  }
});

// ---------- officer queue ----------
/** Open, visible issues an officer may act on: inside their jurisdiction and (when the role has one) their department. */
export function officerQueue(actor: string, limit = 100) {
  const r = roleOf(actor, "officer");
  if (!r) throw new HttpError(403, "officer role required");
  // Scan the open queue in SLA order in chunks until enough rows in THIS role's scope are found. (A fixed LIMIT before the scope filter hid a scoped
  // officer's whole queue as soon as 1000 earlier-due issues existed elsewhere.)
  const want = Math.min(Math.max(limit, 1), 200);
  const scan = idb().prepare("SELECT * FROM issue WHERE moderation='ok' AND status IN ('Reported','Verified','Assigned','InProgress','Reopened') ORDER BY sla_due, id LIMIT 500 OFFSET ?");
  const mine: any[] = [];
  for (let off = 0; mine.length < want; off += 500) {
    const rows = scan.all(off) as any[];
    for (const i of rows) if (covers(r, i.village_lgd) && (!r.department || r.department === i.department)) { mine.push(i); if (mine.length >= want) break; }
    if (rows.length < 500) break;
  }
  const items = mine
    .map(i => ({ id: i.id, category: i.category, department: i.department, status: i.status, village_lgd: i.village_lgd, created_at: i.created_at, sla_due: i.sla_due, esc_level: i.esc_level, overdue: i.sla_due < iso(clock.now()), description_en: i.desc_en, description_te: i.desc_te, support: (idb().prepare("SELECT COUNT(*) c FROM issue_me_too WHERE issue_id=?").get(i.id) as { c: number }).c }));
  return { role: { department: r.department, jurisdiction_lgd: r.jurisdiction_lgd }, items };
}
