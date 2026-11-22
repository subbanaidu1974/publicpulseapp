import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireAuth } from "../core";
import * as svc from "./service";

/** Build the router; `auth` is injectable so tests can run without the identity service. */
export function createIssuesRouter(auth: RequestHandler = requireAuth): Router {
  const r = Router();
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); }
    catch (e) {
      if (e instanceof svc.HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
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
