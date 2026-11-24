import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { getStore, requireAuth } from "../core";
import * as svc from "./service";
import { MediaError, getMedia, maxUploadBody, ownsMedia, parseMultipart, readMediaFile, storeMedia } from "./media";
import * as pub from "./public";
import * as cur from "./curation";

/** Build the router; `auth` is injectable so tests can run without the identity service. */
export function createIssuesRouter(auth: RequestHandler = requireAuth): Router {
  const r = Router();
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    const fail = (e: unknown) => {
      if (e instanceof svc.HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
      if (e instanceof MediaError) return res.status(e.status).json({ error: e.message, ...e.extra });
      next(e);
    };
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.then(v => { if (v !== undefined) res.json(v); }, fail);
      else if (out !== undefined) res.json(out);
    } catch (e) { fail(e); }
  };
  const pid = (req: Request) => req.person!.id;

  // Public: identical for every caller, no reporter identity, no auth dependence.
  // Filters: village, mandal, district, constituency (LGD codes), category, status. Cursor: `cursor` (or legacy `since`) = last seq seen;
  // response carries next_cursor (null at the end) and has_more.
  r.get("/feed", wrap((req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    return pub.feedPage(req.query);
  }));

  // Canonical categories (id, EN/TE labels, icon, IVR digit) and trust-tier badge labels: one source for web and IVR.
  r.get("/categories", wrap((_req, res) => { res.set("Cache-Control", "public, max-age=3600"); return pub.categoriesPayload(); }));

  // Bulk export: identical for every caller, no personal fields, rate limited per address. ?format=ndjson (default) | csv, same filters
  // as the list, ?cursor= continues; the next cursor is in the X-Next-Cursor header.
  r.get("/export", (req, res, next) => {
    const gate = pub.exportRateAllow(req.ip ?? "-");
    if (!gate.ok) { res.set("Retry-After", String(gate.retryAfterSec)); return void res.status(429).json({ error: "export rate limit reached", retry_after_seconds: gate.retryAfterSec }); }
    wrap((_rq, rs) => {
      const csv = String(req.query.format ?? "ndjson") === "csv";
      const { rows, next_cursor } = pub.exportRows(req.query);
      rs.set({ "Content-Type": csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="issues.${csv ? "csv" : "ndjson"}"` });
      if (next_cursor) rs.set("X-Next-Cursor", next_cursor);
      rs.send(csv ? pub.toCsv(rows) : pub.toNdjson(rows));
    })(req, res, next);
  });

  // Public list of visible issues, newest first. Same filters as the feed (+ created_since), cursor pagination.
  r.get("/", wrap((req, res) => { res.set("Cache-Control", "public, max-age=60"); return pub.listIssues(req.query); }));

  // Moderator tools (role moderator or admin): held queue with rule-id reasons, metrics, lexicon versioning and reviewed changes.
  r.get("/moderation/queue", auth, wrap(req => cur.heldQueue(pid(req), { status: String(req.query.status ?? ""), limit: Number(req.query.limit), cursor: req.query.cursor as string | undefined })));
  r.get("/moderation/metrics", auth, wrap(req => cur.moderationMetrics(pid(req), { since: req.query.since as string | undefined })));
  r.get("/moderation/lexicon", auth, wrap(req => cur.lexiconInfo(pid(req))));
  // UI-friendly aliases: {term, action: add|remove, list?} proposes a change; /moderation/lexicon/:id/review {decision: approve|reject}.
  r.post("/moderation/lexicon", auth, wrap((req, res) => { res.status(201); return cur.proposeChange(pid(req), { op: req.body?.action === "remove" ? "retire" : "add", list: req.body?.list ?? "abuse.en", term: req.body?.term, note: req.body?.note }); }));
  r.post("/moderation/lexicon/:id/review", auth, wrap(req => cur.reviewChange(pid(req), req.params.id, String(req.body?.decision))));
  r.get("/officer/queue", auth, wrap(req => svc.officerQueue(pid(req), Number(req.query.limit) || 100)));
  r.post("/:id/escalate", auth, wrap(req => svc.moderate(req.params.id, pid(req), "escalate", svc.clock.now(), typeof req.body?.note === "string" ? req.body.note : undefined)));
  r.get("/moderation/lexicon/changes", auth, wrap(req => cur.listChanges(pid(req), req.query.status as string | undefined)));
  r.post("/moderation/lexicon/changes", auth, wrap((req, res) => { res.status(201); return cur.proposeChange(pid(req), req.body ?? {}); }));
  r.post("/moderation/lexicon/changes/:id/review", auth, wrap(req => cur.reviewChange(pid(req), req.params.id, String(req.body?.decision))));

  r.get("/metrics", (req, res, next) => {
    if (String(req.query.level ?? "department") === "department") return wrap(() => svc.departmentMetrics())(req, res, next);
    if (req.query.level !== "officer") return res.status(400).json({ error: "level must be department or officer" });
    return auth(req, res, () => wrap(() => svc.officerMetrics(pid(req), String(req.query.jurisdiction ?? "")))(req, res, next));
  });

  // Photo / voice-note upload. Accepts a raw body (Content-Type image/* or audio/*), multipart/form-data (first file part), or
  // JSON {data_base64, mime}. Returns {ref: "media:<id>"} to pass as photo_ref / voice_ref when reporting.
  // NOTE: a global express.json() with a small limit mounted before this router rejects large JSON bodies first; raw and multipart are unaffected.
  const bodyLimit = () => maxUploadBody();
  r.post("/media", auth,
    (req, res, next) => express.json({ limit: bodyLimit() })(req, res, next),
    (req, res, next) => express.raw({ type: () => true, limit: bodyLimit() })(req, res, next),
    wrap((req, res) => {
      const ct = String(req.headers["content-type"] ?? "");
      let data: Buffer | null = null, mime: string | undefined;
      if (Buffer.isBuffer(req.body) && req.body.length) {
        if (/^multipart\/form-data/i.test(ct)) { const part = parseMultipart(req.body, ct); if (part) { data = part.data; mime = part.mime; } }
        else { data = req.body; mime = ct; }
      } else if (req.body && typeof req.body === "object" && typeof req.body.data_base64 === "string") {
        const b64 = String(req.body.data_base64).replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
        if (b64.length > bodyLimit() || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new MediaError(400, "invalid base64");
        data = Buffer.from(b64, "base64");
        mime = typeof req.body.mime === "string" ? req.body.mime : undefined;
      }
      if (!data || !data.length) throw new MediaError(400, "no file in request");
      res.status(201);
      return storeMedia(pid(req), data, mime, svc.clock.now());
    }),
    (err: any, _req: Request, res: Response, next: NextFunction) => {
      if (err?.type === "entity.too.large") return void res.status(413).json({ error: "upload too large" });
      next(err);
    });

  // Owner always; others only when the file is attached to a publicly visible issue.
  r.get("/media/:id", auth, (req, res) => {
    const m = getMedia(req.params.id);
    const issue = m?.issue_id ? (getStore("issues").prepare("SELECT moderation FROM issue WHERE id=?").get(m.issue_id) as { moderation: string } | undefined) : undefined;
    const allowed = !!m && (ownsMedia(m, req.person!.id) || issue?.moderation === "ok");
    const buf = allowed ? readMediaFile(m!) : null;
    if (!m || !buf) return void res.status(404).json({ error: "not found" });
    res.set({ "Content-Type": m.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'" });
    res.send(buf);
  });

  r.post("/", auth, wrap((req, res) => { const out = svc.reportIssue(pid(req), req.body ?? {}); res.status(out.merged ? 200 : 201); return out; }));
  r.post("/:id/me-too", auth, wrap(req => svc.meToo(req.params.id, pid(req))));
  r.post("/:id/transition", auth, wrap(req => svc.transition(req.params.id, pid(req), req.body ?? {})));
  r.post("/:id/confirm", auth, wrap(req => svc.confirm(req.params.id, pid(req), String(req.body?.vote))));
  r.post("/:id/appeal", auth, wrap((req, res) => { res.status(201); return svc.appeal(req.params.id, pid(req), req.body?.reason); }));
  r.post("/:id/moderate", auth, wrap(req => svc.moderate(req.params.id, pid(req), String(req.body?.decision), svc.clock.now(), typeof req.body?.note === "string" ? req.body.note : undefined)));
  r.post("/:id/rebuttal", auth, wrap((req, res) => { res.status(201); return svc.rebuttal(req.params.id, pid(req), req.body?.text); }));
  // Owner view (S-157): the caller's own reports including held / taken-down ones, with the moderation class and whether an appeal can be filed.
  r.get("/mine", auth, wrap(req => pub.myReports(pid(req))));
  r.get("/mine/:id", auth, wrap(req => pub.myReport(pid(req), req.params.id)));
  // Public detail (no reporter identity). Registered last so it never shadows the fixed paths above.
  r.get("/:id", wrap((req, res) => { res.set("Cache-Control", "public, max-age=30"); return pub.publicIssue(req.params.id); }));
  return r;
}

export const issuesRouter = createIssuesRouter();
