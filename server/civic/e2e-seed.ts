/**
 * Test-only seeding for Playwright (never mounted in production). Mounted by server/civic/index.ts only when
 * NODE_ENV !== "production" AND CIVIC_E2E_SEED=1 (playwright.config.ts sets it for its own web server).
 *
 *   POST /api/v1/civic/e2e/person  { roles?: [{ role, jurisdiction?, department? }], label? }
 *     -> 201 { person_id, token }   a fresh person with a session and the requested core roles (granted by "system").
 *   Optional extras for the Pulse Survey specs: roles[].department (party code for politician, nominating organisation for survey_panel,
 *   department for officer); residence_unit (an LGD village code: makes an eligible T1 respondent); backdate_days (account age, so the
 *   waiting period has passed).
 *
 * Roles are real core roles (same table the admin console and the issues service read), so the consoles under test
 * go through the real authorisation path. There is deliberately no way to read anything back.
 */
import express, { Router } from "express";
import crypto from "node:crypto";
import { ROLE_NAMES, createSession, getDb, getKeys, grantRole, type RoleName } from "./core";
import { createPerson } from "./identity/service";

export const e2eSeedEnabled = (): boolean => process.env.NODE_ENV !== "production" && process.env.CIVIC_ENV !== "production" && process.env.CIVIC_E2E_SEED === "1";

export function createE2eSeedRouter(): Router {
  const r = Router();
  r.use(express.json({ limit: "4kb" }));
  r.post("/person", (req, res) => {
    if (!e2eSeedEnabled()) return void res.status(404).json({ error: "not found" });
    const roles = Array.isArray(req.body?.roles) ? (req.body.roles as { role?: string; jurisdiction?: string; department?: string }[]) : [];
    for (const x of roles) if (!x || !ROLE_NAMES.includes(x.role as RoleName)) return void res.status(400).json({ error: "unknown role" });
    const phone = "+9199" + String(crypto.randomInt(0, 100_000_000)).padStart(8, "0");
    const p = createPerson({ phone, pin: "4821", label: typeof req.body?.label === "string" ? req.body.label.slice(0, 40) : "e2e", consentVersion: "v1" });
    for (const x of roles) grantRole("system", p.id, x.role as RoleName, x.jurisdiction ?? null, x.department ?? null);
    const unit = typeof req.body?.residence_unit === "string" ? req.body.residence_unit.slice(0, 64) : "";
    const back = Math.min(3650, Math.max(0, Math.floor(Number(req.body?.backdate_days)) || 0));
    const d = getDb();
    if (unit) d.prepare("UPDATE persons SET residence_enc = ?, residence_unit = ?, residence_declared_at = ?, tier = 'T1' WHERE id = ?").run(getKeys().encrypt("residence", "e2e village"), unit, new Date().toISOString(), p.id);
    if (back) { const at = new Date(Date.now() - back * 86_400_000).toISOString(); d.prepare("UPDATE persons SET created_at = ?, eligible_from = ? WHERE id = ?").run(at, at, p.id); }
    res.status(201).json({ person_id: p.id, token: createSession(p.id, { label: "e2e" }) });
  });
  return r;
}
