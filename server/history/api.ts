/**
 * Read-only history API over the local history store (server/history/store.ts), mounted under /api/v1 by server/api.ts.
 *   GET /history/datasets                                   latest revision per dataset
 *   GET /history/revisions?dataset=&limit=                  append-only revision log (checksum, rows, source, licence, asOf, diff)
 *   GET /history/elections?state=&type=                     elections held, with the boundary version in force
 *   GET /history/constituency/:state/:acNo?type=            results across elections for one seat, with boundary version
 *   GET /history/office-holders?asOf=YYYY-MM-DD&state=&role=  who held which office on a date
 *   GET /history/party/:id/seats-over-time?state=&type=     seats won per election for a party code (chronological, unranked)
 * Neutral by design: chronological or numeric order only, no rankings, scores or labels. The database is optional: when it has not
 * been built (npm run history:build) every route answers 503 history_unavailable. The connection is opened read-only per request.
 */
import fs from "node:fs";
import { Router } from "express";
import type { Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { isElectionType, isStateCode } from "../../src/lib/states";
import { defaultHistoryDb, openHistoryDb } from "./store";

const bad = (res: Response, status: number, error: string, code: string) => res.status(status).json({ error, code });
const qs = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const parseJson = (s: unknown): unknown => { try { return JSON.parse(String(s)); } catch { return []; } };
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const CACHE = "public, max-age=300";

type Rec = Record<string, unknown>;

export function createHistoryRouter(opts: { dbPath?: string } = {}): Router {
  const router = Router();
  const file = () => opts.dbPath ?? defaultHistoryDb();

  // Gate only this router's own paths: /history/:state (analytics) must keep working without the database.
  router.use(["/history/datasets", "/history/revisions", "/history/elections", "/history/constituency", "/history/office-holders", "/history/party"], (_req, res, next) => {
    if (!fs.existsSync(file())) return bad(res, 503, "History store not built (run npm run history:build)", "history_unavailable");
    next();
  });

  /** Opens read-only, runs fn, closes; storage errors become a JSON 500 via the shared error handler. */
  function withDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = openHistoryDb(file(), { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  }
  const meta = (db: DatabaseSync) => ({ projectedAt: (db.prepare("SELECT value FROM history_meta WHERE key = 'projected_at'").get() as { value: string } | undefined)?.value ?? null });
  const revOut = (r: Rec) => ({
    id: r.id, dataset: r.dataset, path: r.path, sha256: r.sha256, bytes: r.bytes, rows: r.row_count, source: r.source, licence: r.licence,
    provenance: r.provenance, asOf: r.as_of, trigger: r.trigger, createdAt: r.created_at, previousRevisionId: r.previous_revision_id, diff: parseJson(r.diff_summary),
  });

  router.get("/history/datasets", (_req, res) => {
    const out = withDb((db) => (db.prepare(`SELECT r.* FROM dataset_revisions r JOIN (SELECT dataset, MAX(id) AS id FROM dataset_revisions GROUP BY dataset) m ON m.id = r.id ORDER BY r.dataset`).all() as Rec[]).map(revOut));
    res.set("Cache-Control", CACHE).json({ datasets: out });
  });

  router.get("/history/revisions", (req, res) => {
    const dataset = qs(req.query.dataset);
    if (dataset !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(dataset)) return bad(res, 400, "Invalid dataset key", "bad_dataset");
    const lim = qs(req.query.limit);
    if (lim !== undefined && !/^\d{1,3}$/.test(lim)) return bad(res, 400, "limit must be 1-200", "bad_limit");
    const limit = Math.min(200, Math.max(1, lim ? Number(lim) : 50));
    const rows = withDb((db) => (dataset
      ? db.prepare("SELECT * FROM dataset_revisions WHERE dataset = ? ORDER BY id DESC LIMIT ?").all(dataset, limit)
      : db.prepare("SELECT * FROM dataset_revisions ORDER BY id DESC LIMIT ?").all(limit)) as Rec[]);
    res.set("Cache-Control", CACHE).json({ dataset: dataset ?? null, revisions: rows.map(revOut) });
  });

  router.get("/history/elections", (req, res) => {
    const state = qs(req.query.state), type = qs(req.query.type);
    if (state !== undefined && !isStateCode(state)) return bad(res, 400, "Unknown state", "bad_state");
    if (type !== undefined && !isElectionType(type)) return bad(res, 400, "Unknown election type", "bad_type");
    const out = withDb((db) => db.prepare(`SELECT id, state, year, type, boundary_version AS boundaryVersion, comparability, seats FROM elections
      WHERE (? IS NULL OR state = ?) AND (? IS NULL OR type = ?) ORDER BY year, state, type`).all(state ?? null, state ?? null, type ?? null, type ?? null));
    res.set("Cache-Control", CACHE).json({ elections: out });
  });

  router.get("/history/constituency/:state/:acNo", (req, res) => {
    const state = req.params.state.toUpperCase();
    if (!isStateCode(state)) return bad(res, 400, "Unknown state", "bad_state");
    if (!/^\d{1,3}$/.test(req.params.acNo) || Number(req.params.acNo) < 1) return bad(res, 400, "acNo must be a positive integer", "bad_ac_no");
    const acNo = Number(req.params.acNo);
    const type = qs(req.query.type) ?? "assembly";
    if (!isElectionType(type)) return bad(res, 400, "Unknown election type", "bad_type");
    const body = withDb((db) => {
      const cons = db.prepare("SELECT boundary_version AS boundaryVersion, name FROM constituencies WHERE state = ? AND type = ? AND ac_no = ? ORDER BY boundary_version").all(state, type, acNo) as Rec[];
      if (!cons.length) return null;
      const els = db.prepare("SELECT id, year, boundary_version AS boundaryVersion, comparability FROM elections WHERE state = ? AND type = ? ORDER BY year").all(state, type) as { id: string; year: number; boundaryVersion: string | null; comparability: string | null }[];
      const q = db.prepare(`SELECT candidate, party, party_code AS partyCode, votes, position, share_pct AS sharePct, is_nota AS isNota, margin, valid_votes AS validVotes, electors, ac_name AS acName
        FROM results WHERE election_id = ? AND ac_no = ? ORDER BY position, votes DESC`);
      const elections = els.map((e) => ({ ...e, results: (q.all(e.id, acNo) as Rec[]).map((r) => ({ ...r, isNota: !!r.isNota })) })).filter((e) => e.results.length);
      return { state, type, acNo, boundaryVersions: cons, elections, ...meta(db) };
    });
    if (!body) return bad(res, 404, "No history for that constituency", "not_found");
    res.set("Cache-Control", CACHE).json(body);
  });

  router.get("/history/office-holders", (req, res) => {
    const asOf = qs(req.query.asOf) ?? new Date().toISOString().slice(0, 10);
    if (!isDate(asOf)) return bad(res, 400, "asOf must be a valid YYYY-MM-DD date", "bad_date");
    const state = qs(req.query.state), role = qs(req.query.role);
    if (state !== undefined && !isStateCode(state)) return bad(res, 400, "Unknown state", "bad_state");
    if (role !== undefined && role.length > 80) return bad(res, 400, "role too long", "bad_role");
    const rows = withDb((db) => db.prepare(`SELECT slot_id, state, role, person, party, constituency, start_date, end_date, current, confidence, sources FROM office_holders
      WHERE start_date <= ? AND ((end_date IS NULL AND current = 1) OR end_date > ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR role = ?)
      ORDER BY state, role, person`).all(asOf, asOf, state ?? null, state ?? null, role ?? null, role ?? null) as Rec[]);
    res.set("Cache-Control", CACHE).json({
      asOf, holders: rows.map((r) => ({ slot: r.slot_id, state: r.state, role: r.role, person: r.person, party: r.party, constituency: r.constituency, start: r.start_date, end: r.end_date, confidence: r.confidence, sources: parseJson(r.sources) })),
      note: "Intervals come from cited records; an open end means the holder was current when last read, not that the term is known to continue.",
    });
  });

  router.get("/history/party/:id/seats-over-time", (req, res) => {
    const id = req.params.id.toUpperCase();
    if (!/^[A-Z0-9_.&() -]{1,40}$/.test(id)) return bad(res, 400, "Invalid party id", "bad_party");
    const state = qs(req.query.state), type = qs(req.query.type);
    if (state !== undefined && !isStateCode(state)) return bad(res, 400, "Unknown state", "bad_state");
    if (type !== undefined && !isElectionType(type)) return bad(res, 400, "Unknown election type", "bad_type");
    const body = withDb((db) => {
      const party = db.prepare("SELECT code, name_en AS nameEn, name_te AS nameTe FROM parties WHERE code = ?").get(id) as Rec | undefined;
      const points = db.prepare(`SELECT e.id AS electionId, e.state, e.year, e.type, e.boundary_version AS boundaryVersion, e.seats AS totalSeats,
          SUM(CASE WHEN r.position = 1 THEN 1 ELSE 0 END) AS seatsWon, COUNT(*) AS seatsContested, SUM(r.votes) AS votes,
          (SELECT GROUP_CONCAT(DISTINCT a.alliance) FROM party_alliances a WHERE a.election_id = e.id AND a.party_code = r.party_code) AS alliance
        FROM results r JOIN elections e ON e.id = r.election_id
        WHERE r.party_code = ? AND (? IS NULL OR e.state = ?) AND (? IS NULL OR e.type = ?)
        GROUP BY e.id ORDER BY e.year, e.state, e.type`).all(id, state ?? null, state ?? null, type ?? null, type ?? null);
      return { party: party ?? { code: id }, points, ...meta(db) };
    });
    if (!body.points.length) return bad(res, 404, "No results recorded for that party code", "not_found");
    res.set("Cache-Control", CACHE).json(body);
  });

  return router;
}
