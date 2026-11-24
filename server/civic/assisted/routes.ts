/**
 * Assisted participation API (S-49), mounted at /api/v1/civic/assisted. OFF by default: every route answers 404 {code: "assisted_disabled"} unless
 * ASSISTED_ENABLED=1, ASSISTED_SUNSET_DATE is set and not yet passed, and the dual-control kill switch is not engaged (./config.ts).
 *
 *  GET  /my-pair                          signed-in volunteer: am I in an active pair, and for which village
 *  POST /records                          the pair: both assistants signed in (Authorization + X-Assist-Partner-Authorization), consent ticks by both
 *  GET  /segment?village=&category=       public: the separate "Reported with assistance" list (every item carries channel: assisted)
 *  POST /receipts/status|delete|report    public, by paper receipt code: what happened / delete my record / this was wrong or pushed on me
 *  POST /pairs, GET /pairs, POST /pairs/:id/suspend      coordinator (create), coordinator|reviewer|admin (list, suspend)
 *  GET  /rechecks, POST /rechecks/:record_id             reviewer: the re-check queue and the outcome (confirmed | not_confirmed | unreachable)
 *  GET  /switch, POST /switch/requests, POST /switch/requests/:id/approve|reject    admin + TOTP, dual control (the kill switch)
 */
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { hasRole, requireAuth } from "../core";
import { requireMfa } from "../admin/routes";
import { HttpError } from "../issues/service";
import { assistedState } from "./config";
import * as svc from "./service";
import * as sw from "./switch";
import * as ctl from "./controls";

export function createAssistedRouter(auth: RequestHandler = requireAuth): Router {
  const r = Router();
  const disabled = (res: Response) => void res.status(404).json({ error: "assisted participation is not available", code: "assisted_disabled" });
  r.use((req, res, next) => {
    const s = assistedState();
    if (!s.env || s.reason === "no_sunset" || s.reason === "sunset_passed") return disabled(res);
    if (req.path.startsWith("/switch")) return next(); // the kill switch can be lifted while it is engaged
    if (!s.on) return disabled(res);
    next();
  });
  r.use(express.json({ limit: "16kb" }));
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    const fail = (e: unknown) => { if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message, ...e.extra }); next(e); };
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.then((v) => { if (v !== undefined) res.json(v); }, fail);
      else if (out !== undefined) res.json(out);
    } catch (e) { fail(e); }
  };
  const pid = (req: Request) => req.person!.id;
  const ip = (req: Request) => req.ip ?? "-";

  r.get("/my-pair", auth, wrap((req) => { if (!hasRole(pid(req), "volunteer")) throw new HttpError(403, "volunteer role required", { code: "role_required" }); return svc.myPair(pid(req)); }));

  r.post("/records", auth, wrap((req, res) => {
    const h = String(req.headers["x-assist-partner-authorization"] ?? "");
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    const partner = m ? svc.personFromToken(m[1]) : null;
    if (!partner) throw new HttpError(401, "the second assistant must be signed in on this request", { code: "partner_auth_required" });
    for (const p of [pid(req), partner]) if (!hasRole(p, "volunteer")) throw new HttpError(403, "both assistants must be enrolled volunteers", { code: "not_a_volunteer" });
    res.status(201);
    return svc.recordIssue(pid(req), partner, req.body ?? {});
  }));

  r.get("/segment", wrap((req, res) => { res.set("Cache-Control", "no-store"); return svc.publicSegment(req.query); }));

  r.post("/receipts/status", wrap((req, res) => { res.set("Cache-Control", "no-store"); return svc.receiptStatus(req.body?.code, ip(req)); }));
  r.post("/receipts/delete", wrap((req) => svc.deleteByReceipt(req.body?.code, ip(req))));
  r.post("/receipts/report", wrap((req) => svc.reportMisuse(req.body?.code, ip(req))));

  r.post("/pairs", auth, wrap((req, res) => { res.status(201); return svc.createPair(pid(req), req.body ?? {}); }));
  r.get("/pairs", auth, wrap((req) => svc.listPairs(pid(req))));
  r.post("/pairs/:id/suspend", auth, wrap((req) => svc.suspendPair(pid(req), req.params.id, req.body?.reason)));

  r.get("/rechecks", auth, wrap((req) => svc.recheckQueue(pid(req), Number(req.query.limit) || 50)));
  r.post("/rechecks/:id", auth, wrap((req) => svc.submitRecheck(pid(req), req.params.id, req.body?.outcome, req.body?.note)));

  // lifting suspensions, area holds, lost-receipt deletion (two people), warnings
  r.post("/pairs/:id/reinstate", auth, wrap((req) => ctl.reinstatePair(pid(req), req.params.id, req.body?.reason)));
  r.get("/pairs/:id/records", auth, wrap((req) => ctl.pairRecords(pid(req), req.params.id)));
  r.post("/areas/:lgd/suspend", auth, wrap((req) => ctl.setAreaHold(pid(req), req.params.lgd, true, req.body?.reason)));
  r.post("/areas/:lgd/resume", auth, wrap((req) => ctl.setAreaHold(pid(req), req.params.lgd, false, req.body?.reason)));
  r.get("/areas/holds", auth, wrap((req) => ctl.listAreaHolds(pid(req))));
  r.get("/alerts", auth, wrap((req) => ctl.alerts(pid(req))));
  r.post("/delete-requests", auth, wrap((req, res) => { res.status(201); return ctl.requestDeletion(pid(req), req.body?.record_id, req.body?.reason); }));
  r.get("/delete-requests", auth, wrap((req) => ctl.listDeletionRequests(pid(req))));
  r.post("/delete-requests/:id/approve", auth, wrap((req) => ctl.decideDeletion(pid(req), req.params.id, true)));
  r.post("/delete-requests/:id/reject", auth, wrap((req) => ctl.decideDeletion(pid(req), req.params.id, false)));

  const adminOnly: RequestHandler = (req, res, next) => auth(req, res, () => {
    if (!hasRole(pid(req), "admin")) return void res.status(403).json({ error: "forbidden: admin role required" });
    next();
  });
  r.get("/switch", adminOnly, wrap((req) => sw.switchView(sw.switchStatus(new Date(), pid(req)), pid(req))));
  r.post("/switch/requests", adminOnly, requireMfa, wrap((req, res) => { res.status(201); return sw.requestSwitch(pid(req), req.body?.action, req.body?.reason); }));
  r.post("/pairs/:id/reinstate-request", adminOnly, requireMfa, wrap((req, res) => { res.status(201); return ctl.requestPairReinstate(pid(req), req.params.id, req.body?.reason); }));
  r.post("/switch/requests/:id/approve", adminOnly, requireMfa, wrap((req) => sw.decideSwitch(pid(req), req.params.id, true)));
  r.post("/switch/requests/:id/reject", adminOnly, requireMfa, wrap((req) => sw.decideSwitch(pid(req), req.params.id, false)));

  return r;
}

export const assistedRouter = createAssistedRouter();
