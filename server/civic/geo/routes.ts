import { Router } from "express";
import { ancestors, ensureGeo, getUnit, search, villageConstituencies } from "./service";

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
  res.json({ village: v.lgd, asOf: asOf ?? new Date().toISOString().slice(0, 10), constituencies: villageConstituencies(v.lgd, asOf) });
});

geoRouter.get("/units/:lgd", (req, res) => {
  const asOf = asOfOf(req.query.asOf);
  const u = getUnit(req.params.lgd, asOf);
  if (!u) return res.status(404).json({ error: "unit not found for that date" });
  res.json({ unit: u, ancestors: ancestors(u.lgd, asOf) });
});
