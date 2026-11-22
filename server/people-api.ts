/**
 * People API (S-106..S-114), mounted under /api/v1 by server/api.ts.
 *   GET  /parties, /parties/:code                 party list / profile
 *   GET  /office-holders[?state=]                 office holders (hidden in blackout)
 *   GET  /members/:state?type=assembly|ls         current roster; /members/:state/:type/:acNo one seat
 *   GET  /contestants?q=&state=&type=&year=       name search (alphabetical, never ranked); /contestants/:id profile
 *   GET  /people/status                           blackout + takedown policy flags for the UI
 *   POST /people/requests                         public correction / takedown request (no login, rate limited, honeypot)
 *   GET  /people/admin/requests                   admin
 *   POST /people/admin/requests/:id/resolve       admin: {status, hide?:boolean, resolution?}
 *   POST /people/admin/takedowns                  admin: {kind, key, active}
 * Takedowns live in sqlite (people_takedowns) and are consulted on EVERY read, so a flag hides a photo/field immediately.
 * MCC neutrality: blackout (windowState or PEOPLE_BLACKOUT=1) hides photos and leader pages and adds a neutral notice.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import type { CandidateResult } from "../src/lib/elections";
import { isElectionType, isStateCode } from "../src/lib/states";
import type { ElectionType, StateCode } from "../src/lib/states";
import { audit, getDb, getKeys, migrate, registerMigration, requireRole } from "./civic/core";
import { rateLimiter } from "./security";
import { windowState } from "./window";
import type { Hidden, PeopleStore } from "./people-data";
import { buildContestant, buildMembers, buildPartyProfile, listParties, loadPeopleStore, searchContestants } from "./people-data";

registerMigration("people_001_requests", `
CREATE TABLE people_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('correction','takedown','other')),
  page TEXT NOT NULL,
  target_kind TEXT,
  target_key TEXT,
  reason TEXT NOT NULL,
  contact_enc TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  sla_days INTEGER NOT NULL DEFAULT 7,
  sla_due TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX people_requests_status ON people_requests(status, created_at);
CREATE TABLE people_takedowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('photo','field','office-holder')),
  target_key TEXT NOT NULL,
  request_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending-review' CHECK (state IN ('pending-review','confirmed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_kind, target_key)
);
`);

let migrated = false;
function db() {
  if (!migrated) { migrate(); migrated = true; }
  return getDb();
}
/** Test hook: the in-memory DB is recreated between tests. */
export function resetPeopleDbFlag(): void { migrated = false; }

const SLA_DAYS = Number(process.env.PEOPLE_SLA_DAYS) > 0 ? Number(process.env.PEOPLE_SLA_DAYS) : 7;
const TARGET_KINDS = ["photo", "field", "office-holder"] as const;
type TargetKind = (typeof TARGET_KINDS)[number];

/** Reads the takedown table on each call (no cache) so a flag is effective immediately. Fails open to "nothing hidden" only if the DB is unavailable. */
function hiddenPredicate(): Hidden {
  let rows: { target_kind: string; target_key: string }[] = [];
  try { rows = db().prepare("SELECT target_kind, target_key FROM people_takedowns WHERE active = 1").all() as typeof rows; } catch { rows = []; }
  const set = new Set(rows.map(r => `${r.target_kind}|${r.target_key}`));
  return (kind, key) => set.has(`${kind}|${key}`);
}

export function peopleBlackout(state: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PEOPLE_BLACKOUT === "1") return true;
  if (env.PEOPLE_BLACKOUT === "0") return false;
  if (state) return windowState(state) === "blackout";
  return windowState("AP") === "blackout" || windowState("TG") === "blackout";
}
const BLACKOUT_NOTICE = {
  en: "Photos and leader pages are paused during the model code of conduct period so that this site stays neutral. Results history and registry facts remain available.",
  te: "ఆదర్శ ప్రవర్తనా నియమావళి కాలంలో తటస్థత కోసం ఫోటోలు, నాయకుల పేజీలు నిలిపివేయబడ్డాయి. ఫలితాల చరిత్ర, నమోదు వివరాలు అందుబాటులో ఉంటాయి.",
};

const err = (res: Response, status: number, error: string, code: string) => res.status(status).json({ error, code });
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined);

export function createPeopleRouter(data: { elections: CandidateResult[] }, opts: { baseDir?: string } = {}): Router {
  const router = express.Router();
  router.use("/people", express.json({ limit: "16kb" }));
  const store: PeopleStore = loadPeopleStore(opts.baseDir);
  const rows = data.elections;

  router.get("/people/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ blackout: peopleBlackout(undefined), notice: BLACKOUT_NOTICE, slaDays: SLA_DAYS, asOf: store.asOf });
  });

  router.get("/parties", (_req, res) => { res.json({ parties: listParties() }); });

  router.get("/parties/:code", (req, res) => {
    const blackout = peopleBlackout(undefined);
    const p = buildPartyProfile(rows, store, String(req.params.code), hiddenPredicate());
    if (!p) return err(res, 404, "Unknown party", "unknown_party");
    res.set("Cache-Control", "no-store");
    // blackout hides leader pages (and the leader list on the party page); symbols stay (they identify the party)
    res.json({ ...p, leaders: blackout ? [] : p.leaders, blackout, notice: blackout ? BLACKOUT_NOTICE : null });
  });

  router.get("/office-holders", (req, res) => {
    const st = str(req.query.state, 4)?.toUpperCase();
    if (st && !isStateCode(st)) return err(res, 404, "Unknown state", "unknown_state");
    const blackout = peopleBlackout(st);
    const hidden = hiddenPredicate();
    res.set("Cache-Control", "no-store");
    const list = blackout ? [] : store.officeHolders.filter(o => (!st || o.state === st) && !hidden("office-holder", o.id));
    res.json({ officeHolders: list, blackout, notice: blackout ? BLACKOUT_NOTICE : null, asOf: store.asOf.officeHolders });
  });

  const membersFor = (state: StateCode, type: ElectionType) => {
    const blackout = peopleBlackout(state);
    const built = buildMembers(rows, store, state, type, hiddenPredicate());
    if (!built) return null;
    const members = blackout ? built.members.map(m => ({ ...m, photo: null })) : built.members;
    return { state, type, electionYear: built.year, members, blackout, notice: blackout ? BLACKOUT_NOTICE : null, asOf: { overlay: store.asOf.overlay, photos: store.asOf.photos } };
  };

  router.get("/members/:state", (req, res) => {
    const state = String(req.params.state).toUpperCase();
    if (!isStateCode(state)) return err(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    const type = str(req.query.type, 10)?.toLowerCase() ?? "assembly";
    if (!isElectionType(type)) return err(res, 400, "Invalid type. Valid: assembly, ls", "invalid_type");
    const out = membersFor(state, type);
    if (!out) return err(res, 404, "No election data", "no_data");
    res.set("Cache-Control", "no-store");
    res.json(out);
  });

  router.get("/members/:state/:type/:acNo", (req, res) => {
    const state = String(req.params.state).toUpperCase();
    const type = String(req.params.type).toLowerCase();
    if (!isStateCode(state)) return err(res, 404, "Unknown state. Valid: AP, TG", "unknown_state");
    if (!isElectionType(type)) return err(res, 400, "Invalid type. Valid: assembly, ls", "invalid_type");
    const acNo = Number(req.params.acNo);
    if (!Number.isInteger(acNo) || acNo < 1) return err(res, 400, "Invalid constituency number", "invalid_ac");
    const out = membersFor(state, type);
    const m = out?.members.find(x => x.acNo === acNo);
    if (!out || !m) return err(res, 404, "No such constituency", "not_found");
    res.set("Cache-Control", "no-store");
    res.json({ ...m, electionYear: out.electionYear, blackout: out.blackout, notice: out.notice, asOf: out.asOf });
  });

  router.get("/contestants", (req, res) => {
    const q = str(req.query.q, 60) ?? "";
    const state = str(req.query.state, 4)?.toUpperCase();
    const type = str(req.query.type, 10)?.toLowerCase();
    const year = str(req.query.year, 4);
    if (state && !isStateCode(state)) return err(res, 404, "Unknown state", "unknown_state");
    if (type && !isElectionType(type)) return err(res, 400, "Invalid type", "invalid_type");
    if (year && !/^\d{4}$/.test(year)) return err(res, 400, "Invalid year", "invalid_year");
    if (q.replace(/[^A-Za-z]/g, "").length < 2) return err(res, 400, "Query must have at least 2 letters", "query_too_short");
    const hits = searchContestants(rows, q, { state: state as StateCode | undefined, type: type as ElectionType | undefined, year: year ? Number(year) : undefined });
    res.json({ query: q, results: hits, note: "Alphabetical by name. Not ranked." });
  });

  router.get("/contestants/:id", (req, res) => {
    const p = buildContestant(rows, String(req.params.id), hiddenPredicate());
    if (!p) return err(res, 404, "No such contestant record", "not_found");
    res.json(p);
  });

  /* ---------------- S-113: correction / takedown channel ---------------- */

  // 3 requests per 10 minutes per address in production; looser in dev/e2e.
  const submitLimiter = rateLimiter({ burst: Number(process.env.PEOPLE_REQUEST_BURST) || (process.env.NODE_ENV === "production" ? 3 : 30), perSecond: 1 / 600 });
  router.post("/people/requests", submitLimiter, (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // honeypot: a hidden field real users never fill. Pretend success so bots learn nothing.
    if (str(b.website, 100) || str(b.url2, 100)) return void res.status(202).json({ ok: true });
    const kind = str(b.kind, 12) ?? "correction";
    if (kind !== "correction" && kind !== "takedown" && kind !== "other") return err(res, 400, "Invalid kind", "invalid_kind");
    const reason = str(b.reason, 2000);
    const page = str(b.page, 300);
    if (!reason || reason.length < 10) return err(res, 400, "Please describe the problem (at least 10 characters)", "reason_required");
    if (!page) return err(res, 400, "Missing page", "page_required");
    const targetKind = str(b.targetKind, 20) as TargetKind | undefined;
    const targetKey = str(b.targetKey, 120);
    if (targetKind && !(TARGET_KINDS as readonly string[]).includes(targetKind)) return err(res, 400, "Invalid target kind", "invalid_target");
    if (targetKind && !targetKey) return err(res, 400, "Missing target key", "invalid_target");
    const contact = str(b.contact, 200);
    const id = "req_" + crypto.randomBytes(8).toString("hex");
    const now = new Date();
    const due = new Date(now.getTime() + SLA_DAYS * 86_400_000);
    const d = db();
    d.prepare(`INSERT INTO people_requests (id, created_at, kind, page, target_kind, target_key, reason, contact_enc, sla_days, sla_due) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, now.toISOString(), kind, page, targetKind ?? null, targetKey ?? null, reason, contact ? getKeys().encrypt("people_contact", contact) : null, SLA_DAYS, due.toISOString());
    // A photo takedown request hides that photo immediately pending review (low harm: the initials avatar shows instead).
    // Field and office-holder removals need an admin because they would otherwise be an abuse vector.
    let hiddenNow = false;
    if (kind === "takedown" && targetKind === "photo" && targetKey) {
      d.prepare(`INSERT INTO people_takedowns (target_kind, target_key, request_id, active, state, created_at, updated_at) VALUES ('photo', ?, ?, 1, 'pending-review', ?, ?)
        ON CONFLICT(target_kind, target_key) DO UPDATE SET active = 1, request_id = excluded.request_id, updated_at = excluded.updated_at`)
        .run(targetKey, id, now.toISOString(), now.toISOString());
      hiddenNow = true;
    }
    audit("anon", "people.request.create", `people_request:${id}`, { kind, targetKind: targetKind ?? null, hiddenNow });
    res.status(201).json({ ok: true, id, slaDays: SLA_DAYS, dueBy: due.toISOString(), hiddenPendingReview: hiddenNow });
  });

  router.get("/people/admin/requests", requireRole("admin"), (req, res) => {
    const status = str(req.query.status, 10);
    const list = db().prepare(`SELECT * FROM people_requests ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`).all(...(status ? [status] : [])) as Record<string, unknown>[];
    const now = Date.now();
    const out = list.map(r => {
      let contact: string | null = null;
      try { contact = r.contact_enc ? getKeys().decrypt("people_contact", String(r.contact_enc)) : null; } catch { contact = null; }
      const { contact_enc: _c, ...rest } = r;
      return { ...rest, contact, overdue: r.status === "open" && Date.parse(String(r.sla_due)) < now };
    });
    res.set("Cache-Control", "no-store");
    res.json({ requests: out, takedowns: db().prepare("SELECT * FROM people_takedowns ORDER BY updated_at DESC LIMIT 200").all() });
  });

  router.post("/people/admin/requests/:id/resolve", requireRole("admin"), (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const status = str(b.status, 10);
    if (status !== "resolved" && status !== "rejected") return err(res, 400, "status must be resolved or rejected", "invalid_status");
    const d = db();
    const row = d.prepare("SELECT * FROM people_requests WHERE id = ?").get(String(req.params.id)) as { id: string; target_kind: string | null; target_key: string | null } | undefined;
    if (!row) return err(res, 404, "No such request", "not_found");
    const now = new Date().toISOString();
    d.prepare("UPDATE people_requests SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?").run(status, now, str(b.resolution, 1000) ?? null, row.id);
    // hide=true confirms (or creates) the takedown; hide=false lifts a pending one
    if (row.target_kind && row.target_key && typeof b.hide === "boolean") {
      if (b.hide) {
        d.prepare(`INSERT INTO people_takedowns (target_kind, target_key, request_id, active, state, created_at, updated_at) VALUES (?,?,?,1,'confirmed',?,?)
          ON CONFLICT(target_kind, target_key) DO UPDATE SET active = 1, state = 'confirmed', request_id = excluded.request_id, updated_at = excluded.updated_at`).run(row.target_kind, row.target_key, row.id, now, now);
      } else {
        d.prepare("UPDATE people_takedowns SET active = 0, updated_at = ? WHERE target_kind = ? AND target_key = ?").run(now, row.target_kind, row.target_key);
      }
    }
    audit(req.person?.id ?? "unknown", "people.request.resolve", `people_request:${row.id}`, { status, hide: typeof b.hide === "boolean" ? b.hide : null });
    res.json({ ok: true });
  });

  router.post("/people/admin/takedowns", requireRole("admin"), (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = str(b.kind, 20);
    const key = str(b.key, 120);
    if (!kind || !(TARGET_KINDS as readonly string[]).includes(kind) || !key) return err(res, 400, "kind and key required", "invalid_target");
    const active = b.active !== false;
    const now = new Date().toISOString();
    db().prepare(`INSERT INTO people_takedowns (target_kind, target_key, active, state, created_at, updated_at) VALUES (?,?,?,'confirmed',?,?)
      ON CONFLICT(target_kind, target_key) DO UPDATE SET active = excluded.active, state = 'confirmed', updated_at = excluded.updated_at`).run(kind, key, active ? 1 : 0, now, now);
    audit(req.person?.id ?? "unknown", "people.takedown.set", `people_takedown:${kind}:${key}`, { active });
    res.json({ ok: true });
  });

  return router;
}
