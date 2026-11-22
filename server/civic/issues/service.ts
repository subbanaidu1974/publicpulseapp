import { randomUUID } from "node:crypto";
import { audit, getDb, registerMigration } from "../core";
import { ancestors, ensureGeo, getUnit } from "../geo/service";

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
CREATE TABLE IF NOT EXISTS officer_role (
  person_id TEXT NOT NULL, role TEXT NOT NULL, department TEXT, jurisdiction_lgd TEXT, label TEXT,
  PRIMARY KEY (person_id, role)
);
CREATE TABLE IF NOT EXISTS officer_rebuttal (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, officer_tag TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issue_appeal (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, person_id TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, at TEXT NOT NULL, decided_at TEXT);
`);

export const CATEGORIES: Record<string, { department: string; slaHours: number }> = {
  water: { department: "Rural Water Supply", slaHours: 72 },
  roads: { department: "Roads and Buildings", slaHours: 168 },
  electricity: { department: "Energy", slaHours: 48 },
  health: { department: "Health", slaHours: 48 },
  education: { department: "School Education", slaHours: 168 },
  agriculture: { department: "Agriculture and Irrigation", slaHours: 120 },
  welfare: { department: "Social Welfare", slaHours: 168 },
  law_order: { department: "Police", slaHours: 24 },
  other: { department: "General Administration", slaHours: 168 },
};

export const MIN_CELL = 30;
export const ME_TOO_PER_DAY = Number(process.env.CIVIC_ME_TOO_PER_DAY ?? 5);
export const CONFIRM_WINDOW_HOURS = 72;
export const SAMPLE_SIZE = 5;
export const DEDUPE_METERS = 300;

/** Injectable clock (tests move time forward). */
export const clock = { now: (): Date => new Date() };
const iso = (d: Date) => d.toISOString();
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

// ---------- roles (Phase 1 stub: simple claim table, to be replaced by verified government onboarding) ----------
export function grantRole(personId: string, role: "officer" | "moderator", department: string | null, jurisdictionLgd: string | null, label?: string): void {
  getDb().prepare("INSERT OR REPLACE INTO officer_role VALUES (?,?,?,?,?)").run(personId, role, department, jurisdictionLgd, label ?? `${department ?? "any"}@${jurisdictionLgd ?? "any"}`);
}
interface Role { role: string; department: string | null; jurisdiction_lgd: string | null; label: string }
function roleOf(personId: string, role: string): Role | null {
  return (getDb().prepare("SELECT * FROM officer_role WHERE person_id=? AND role=?").get(personId, role) as unknown as Role | undefined) ?? null;
}
/** Does this role's jurisdiction cover the village (unit is the village itself or an ancestor)? */
function covers(r: Role, village: string): boolean {
  if (!r.jurisdiction_lgd) return true;
  return ancestors(village).some(u => u.lgd === r.jurisdiction_lgd);
}

// ---------- moderation heuristics ----------
const NAME_PATTERNS = [
  /\b(mr|mrs|ms|sri|shri|smt|dr|ci|si|mro|mdo)\.?\s+[A-Za-z]{2,}/i,
  /(శ్రీమతి|శ్రీ|డాక్టర్)\s*\S+/,
  /\b(named|called|by the name)\b/i,
  /\b(caste|religion)\b/i,
];
export function needsReview(text: string): boolean { return NAME_PATTERNS.some(p => p.test(text)); }

// ---------- reporting ----------
export interface ReportInput { category?: string; description_en?: string; description_te?: string; photo_ref?: string; lat?: number; lon?: number; village_lgd?: string }
const tokens = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter(t => t.length > 1));
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i); };
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function event(issueId: string, type: string, i: { status?: string; village_lgd?: string; category?: string; department?: string } | null, now: Date) {
  getDb().prepare("INSERT INTO issue_event (issue_id,type,status,village_lgd,category,department,at) VALUES (?,?,?,?,?,?,?)")
    .run(issueId, type, i?.status ?? null, i?.village_lgd ?? null, i?.category ?? null, i?.department ?? null, iso(now));
}
const OPEN = ["Reported", "Verified", "Assigned", "InProgress", "Reopened"];

export function reportIssue(personId: string, b: ReportInput, now = clock.now()) {
  ensureGeo();
  const db = getDb();
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
  if (b.photo_ref !== undefined && !(typeof b.photo_ref === "string" && /^[\w\-./]{1,200}$/.test(b.photo_ref))) throw new HttpError(400, "invalid photo_ref");

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

  const held = needsReview(`${en} ${te}`);
  const id = randomUUID();
  const t = iso(now);
  db.prepare(`INSERT INTO issue (id,category,desc_en,desc_te,photo_ref,lat,lon,village_lgd,department,status,moderation,reporter_id,created_at,updated_at,sla_due,jurisdiction_lgd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.category!, en || null, te || null, b.photo_ref ?? null, lat, lon, v.lgd, cat.department, "Reported", held ? "held" : "ok", personId, t, t, iso(addHours(now, cat.slaHours)), v.lgd);
  db.prepare("INSERT INTO issue_me_too VALUES (?,?,?,1)").run(id, personId, t);
  audit(personId, held ? "issue.report_held" : "issue.report", `issue:${id}`, { category: b.category, village: v.lgd, held });
  if (!held) event(id, "reported", { status: "Reported", village_lgd: v.lgd, category: b.category, department: cat.department }, now);
  return { id, merged: false, held, status: "Reported" };
}

function meTooCore(issueId: string, personId: string, now: Date, viaDedupe = false) {
  const db = getDb();
  const support = () => (db.prepare("SELECT COUNT(*) c FROM issue_me_too WHERE issue_id=?").get(issueId) as { c: number }).c;
  if (db.prepare("SELECT 1 FROM issue_me_too WHERE issue_id=? AND person_id=?").get(issueId, personId)) return { counted: false, support: support() };
  const dayStart = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const used = (db.prepare("SELECT COUNT(*) c FROM issue_me_too WHERE person_id=? AND self=0 AND at>=?").get(personId, dayStart) as { c: number }).c;
  if (used >= ME_TOO_PER_DAY) {
    if (viaDedupe) return { counted: false, support: support() };
    throw new HttpError(429, "daily me-too limit reached", { limit: ME_TOO_PER_DAY });
  }
  db.prepare("INSERT INTO issue_me_too VALUES (?,?,?,0)").run(issueId, personId, iso(now));
  audit(personId, "issue.me_too", `issue:${issueId}`);
  return { counted: true, support: support() };
}

export function meToo(issueId: string, personId: string, now = clock.now()) {
  const i = getDb().prepare("SELECT status, moderation FROM issue WHERE id=?").get(issueId) as any;
  if (!i || i.moderation !== "ok") throw new HttpError(404, "issue not found");
  return meTooCore(issueId, personId, now);
}

// ---------- workflow ----------
const NEXT: Record<string, string[]> = {
  Reported: ["Verified"], Verified: ["Assigned"], Assigned: ["InProgress", "Resolved"], InProgress: ["Resolved"], Reopened: ["Assigned"],
};
export interface TransitionInput { to?: string; action?: string; department?: string; note?: string }

function sampleNeighbours(issueId: string, village: string, reporter: string) {
  const db = getDb();
  const pick = (sql: string, ...p: any[]) => (db.prepare(sql).all(...p) as { person_id: string }[]).map(r => r.person_id);
  const ids = new Set<string>(pick("SELECT person_id FROM issue_me_too WHERE issue_id=? AND person_id<>? ORDER BY RANDOM() LIMIT ?", issueId, reporter, SAMPLE_SIZE));
  if (ids.size < SAMPLE_SIZE)
    for (const p of pick("SELECT DISTINCT reporter_id person_id FROM issue WHERE village_lgd=? AND id<>? AND reporter_id<>? ORDER BY RANDOM() LIMIT ?", village, issueId, reporter, SAMPLE_SIZE)) if (ids.size < SAMPLE_SIZE) ids.add(p);
  const ins = db.prepare("INSERT OR IGNORE INTO issue_sample VALUES (?,?,NULL)");
  for (const p of ids) ins.run(issueId, p);
}

function setStatus(i: any, to: string, now: Date, extra: Record<string, unknown> = {}) {
  const sets = ["status=?", "updated_at=?"], vals: any[] = [to, iso(now)];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); vals.push(v as any); }
  getDb().prepare(`UPDATE issue SET ${sets.join(",")} WHERE id=?`).run(...vals, i.id);
  event(i.id, "status", { status: to, village_lgd: i.village_lgd, category: i.category, department: i.department }, now);
}
const load = (id: string) => {
  const i = getDb().prepare("SELECT * FROM issue WHERE id=?").get(id) as any;
  if (!i) throw new HttpError(404, "issue not found");
  return i;
};

export function transition(issueId: string, actor: string, b: TransitionInput, now = clock.now()) {
  const i = load(issueId);
  if (i.moderation !== "ok") throw new HttpError(409, "issue is under moderation");
  const r = roleOf(actor, "officer");
  if (!r) throw new HttpError(403, "officer role required");
  if (!covers(r, i.village_lgd)) throw new HttpError(403, "outside your jurisdiction", { hint: "out_of_jurisdiction" });

  if (b.action === "out_of_jurisdiction") {
    const dep = Object.values(CATEGORIES).find(c => c.department === b.department)?.department;
    if (!dep) throw new HttpError(400, "department required (known department name)", { departments: [...new Set(Object.values(CATEGORIES).map(c => c.department))] });
    if (!OPEN.includes(i.status)) throw new HttpError(409, "issue not open");
    getDb().prepare("UPDATE issue SET department=?, status='Verified', assigned_officer=NULL, updated_at=?, jurisdiction_lgd=?, esc_level=0, sla_due=? WHERE id=?")
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
  if (personId === i.reporter_id) {
    if (vote === "confirm") setStatus(i, "Confirmed", now, { confirm_basis: "reporter" });
    else setStatus(i, "Reopened", now, { sla_due: iso(addHours(now, CATEGORIES[i.category].slaHours)), confirm_basis: null });
    audit(personId, "issue.confirmation", `issue:${i.id}`, { vote, basis: "reporter" });
    return { status: vote === "confirm" ? "Confirmed" : "Reopened", basis: "reporter" };
  }
  const row = getDb().prepare("UPDATE issue_sample SET vote=? WHERE issue_id=? AND person_id=?").run(vote, i.id, personId);
  if (!row.changes) throw new HttpError(403, "not sampled for this confirmation");
  audit(personId, "issue.confirmation", `issue:${i.id}`, { vote, basis: "neighbour" });
  return { status: "Resolved", recorded: true };
}

/** Periodic job: close confirmation windows and escalate overdue issues. Returns what changed. */
export function sweep(now = clock.now()) {
  const db = getDb();
  const out = { confirmed: [] as string[], reopened: [] as string[], escalated: [] as string[] };
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
    const chain = ancestors(i.village_lgd, now);
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
  return out;
}

// ---------- moderation ----------
export function appeal(issueId: string, personId: string, reason: string | undefined, now = clock.now()) {
  const i = load(issueId);
  if (i.reporter_id !== personId || i.moderation === "ok") throw new HttpError(404, "no moderated issue of yours with that id");
  const open = getDb().prepare("SELECT id FROM issue_appeal WHERE issue_id=? AND status='pending'").get(issueId);
  if (open) throw new HttpError(409, "appeal already pending");
  const id = randomUUID();
  getDb().prepare("INSERT INTO issue_appeal VALUES (?,?,?,?,?,?,NULL)").run(id, issueId, personId, (reason ?? "").slice(0, 1000), "pending", iso(now));
  audit(personId, "issue.appeal", `issue:${issueId}`, { appeal: id });
  return { appeal_id: id, status: "pending" };
}

export function moderate(issueId: string, actor: string, decision: string, now = clock.now()) {
  if (!roleOf(actor, "moderator")) throw new HttpError(403, "moderator role required");
  const i = load(issueId);
  const db = getDb();
  if (decision === "release") {
    if (i.moderation === "ok") throw new HttpError(409, "already visible");
    db.prepare("UPDATE issue SET moderation='ok', updated_at=? WHERE id=?").run(iso(now), i.id);
    event(i.id, "reported", { status: i.status, village_lgd: i.village_lgd, category: i.category, department: i.department }, now);
    audit(actor, "issue.release", `issue:${i.id}`);
  } else if (decision === "takedown") {
    db.prepare("UPDATE issue SET moderation='taken_down', updated_at=? WHERE id=?").run(iso(now), i.id);
    event(i.id, "taken_down", null, now);
    audit(actor, "issue.takedown", `issue:${i.id}`, { previous: i.moderation });
  } else if (decision !== "uphold") throw new HttpError(400, "decision must be release, takedown or uphold");
  else audit(actor, "issue.uphold", `issue:${i.id}`);
  db.prepare("UPDATE issue_appeal SET status=?, decided_at=? WHERE issue_id=? AND status='pending'").run(decision, iso(now), i.id);
  return { id: i.id, decision };
}

// ---------- officer rebuttal ----------
export function rebuttal(issueId: string, actor: string, text: string, now = clock.now()) {
  const i = load(issueId);
  const r = roleOf(actor, "officer");
  if (!r || !covers(r, i.village_lgd)) throw new HttpError(403, "officer role covering this village required");
  if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new HttpError(400, "text required (max 2000 chars)");
  const id = randomUUID();
  getDb().prepare("INSERT INTO officer_rebuttal VALUES (?,?,?,?,?)").run(id, i.id, i.assigned_officer ?? r.label, text.trim(), iso(now));
  audit(actor, "issue.rebuttal", `issue:${i.id}`, { id });
  return { id };
}

// ---------- public outputs ----------
export function feed(since = 0, limit = 200) {
  const rows = getDb().prepare(`SELECT e.seq, e.issue_id, e.type, e.status, e.village_lgd, e.category, e.department, e.at
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
const visible = () => getDb().prepare("SELECT * FROM issue WHERE moderation='ok'").all() as any[];

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
  const r = roleOf(actor, "officer");
  if (!r) throw new HttpError(403, "officer role required");
  if (!jurisdiction) throw new HttpError(400, "jurisdiction (LGD code) required for officer-level metrics");
  const unit = getUnit(jurisdiction, now);
  if (!unit) throw new HttpError(404, "unknown jurisdiction");
  if (r.jurisdiction_lgd && !ancestors(jurisdiction, now).some(u => u.lgd === r.jurisdiction_lgd)) throw new HttpError(403, "jurisdiction not within your role");
  const inJur = visible().filter(i => i.assigned_officer && ancestors(i.village_lgd, now).some(u => u.lgd === jurisdiction));
  const tags = [...new Set(inJur.map(i => i.assigned_officer as string))];
  const officers = tags.map(tag => {
    const items = inJur.filter(i => i.assigned_officer === tag);
    const reb = getDb().prepare("SELECT text, at FROM officer_rebuttal WHERE officer_tag=? ORDER BY at DESC LIMIT 5").all(tag) as any[];
    const base = { officer_tag: tag, jurisdiction: { lgd: unit.lgd, level: unit.level, name: unit.name_en }, rebuttals: reb, rebuttal_field: "open" };
    return items.length >= MIN_CELL ? { ...base, masked: false, ...summarise(items) } : { ...base, masked: true, note: `fewer than ${MIN_CELL} reports` };
  });
  return { level: "officer", jurisdiction: unit.lgd, officers };
}
