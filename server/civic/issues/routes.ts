import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { getDb, requireAuth } from "../core";
import * as svc from "./service";
import { MediaError, getMedia, maxUploadBody, parseMultipart, readMediaFile, storeMedia } from "./media";

/** Build the router; `auth` is injectable so tests can run without the identity service. */
export function createIssuesRouter(auth: RequestHandler = requireAuth): Router {
  const r = Router();
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); }
    catch (e) {
      if (e instanceof svc.HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
      if (e instanceof MediaError) return res.status(e.status).json({ error: e.message, ...e.extra });
      next(e);
    }
  };
  const pid = (req: Request) => req.person!.id;

  // Public: identical for every caller, no reporter identity, no auth dependence.
  r.get("/feed", wrap((req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    return svc.feed(Number(req.query.since) || 0, Number(req.query.limit) || 200);
  }));

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
    const issue = m?.issue_id ? (getDb().prepare("SELECT moderation FROM issue WHERE id=?").get(m.issue_id) as { moderation: string } | undefined) : undefined;
    const allowed = !!m && (m.owner_id === req.person!.id || issue?.moderation === "ok");
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
  r.post("/:id/moderate", auth, wrap(req => svc.moderate(req.params.id, pid(req), String(req.body?.decision))));
  r.post("/:id/rebuttal", auth, wrap((req, res) => { res.status(201); return svc.rebuttal(req.params.id, pid(req), req.body?.text); }));
  return r;
}

export const issuesRouter = createIssuesRouter();
