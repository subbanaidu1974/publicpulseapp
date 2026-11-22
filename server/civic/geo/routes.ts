import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { hasRole, requireAuth } from "../core";
import { ancestors, electionConstituency, ensureGeo, getUnit, listHamlets, reviewHamlet, search, villageConstituencies } from "./service";
import type { HamletStatus } from "./service";

/** /api/v1/civic/geo. Public, read-only. */
export const geoRouter = Router();
const asOfOf = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
};

geoRouter.use((_req, _res, next) => { ensureGeo(); next(); });

geoRouter.get("/search", (req, res) => {
  const q = String(req.query.q ?? "");
  if (q.trim().length < 2) return res.status(400).json({ error: "q must be at least 2 characters" });
  res.json({ results: search(q, asOfOf(req.query.asOf)), label: "DEMO gazetteer unless imported from LGD" });
});

geoRouter.get("/village/:lgd/constituency", (req, res) => {
  const asOf = asOfOf(req.query.asOf);
  const v = getUnit(req.params.lgd, asOf);
  if (!v || v.level !== "village") return res.status(404).json({ error: "village not found for that date" });
  const constituencies = villageConstituencies(v.lgd, asOf);
  // S-102: also resolve each LGD constituency to the ECI election constituency (empty for the DEMO fixture)
  const election = constituencies.map(c => electionConstituency(c.lgd, asOf)).filter(Boolean);
  res.json({ village: v.lgd, asOf: asOf ?? new Date().toISOString().slice(0, 10), constituencies, electionConstituencies: election });
});

geoRouter.get("/units/:lgd", (req, res) => {
  const asOf = asOfOf(req.query.asOf);
  const u = getUnit(req.params.lgd, asOf);
  if (!u) return res.status(404).json({ error: "unit not found for that date" });
  res.json({ unit: u, ancestors: ancestors(u.lgd, asOf) });
});

/** S-101: hamlet review. Moderators and admins only (the existing roles; no new role is needed for the pilot). */
const requireReviewer = (req: Request, res: Response, next: NextFunction): void => {
  requireAuth(req, res, () => {
    const id = req.person?.id;
    if (!id || !(hasRole(id, "moderator") || hasRole(id, "admin"))) { res.status(403).json({ error: "forbidden: moderator role required" }); return; }
    next();
  });
};

geoRouter.get("/hamlets/review", requireReviewer, (req, res) => {
  const status = String(req.query.status ?? "unreviewed") as HamletStatus;
  if (!["unreviewed", "approved", "rejected"].includes(status)) return void res.status(400).json({ error: "status must be unreviewed, approved or rejected" });
  res.set("Cache-Control", "no-store");
  res.json(listHamlets(status, Number(req.query.limit) || 50, Number(req.query.offset) || 0));
});

for (const decision of ["approve", "reject"] as const) {
  geoRouter.post(`/hamlets/:id/${decision}`, express.json({ limit: "4kb" }), requireReviewer, (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const out = reviewHamlet(req.params.id, req.person!.id, decision, note);
    if (!out) return void res.status(404).json({ error: "hamlet not found" });
    res.set("Cache-Control", "no-store");
    res.json({ hamlet: out });
  });
}
