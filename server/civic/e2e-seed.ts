/**
 * Test-only seeding for Playwright (never mounted in production). Mounted by server/civic/index.ts only when
 * NODE_ENV !== "production" AND CIVIC_E2E_SEED=1 (playwright.config.ts sets it for its own web server).
 *
 *   POST /api/v1/civic/e2e/person  { roles?: [{ role, jurisdiction?, department? }], label? }
 *     -> 201 { person_id, token }   a fresh person with a session and the requested core roles (granted by "system").
 *
 * Roles are real core roles (same table the admin console and the issues service read), so the consoles under test
 * go through the real authorisation path. There is deliberately no way to read anything back.
 */
import express, { Router } from "express";
import crypto from "node:crypto";
import { ROLE_NAMES, createSession, grantRole, type RoleName } from "./core";
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
    res.status(201).json({ person_id: p.id, token: createSession(p.id, { label: "e2e" }) });
  });
  return r;
}
