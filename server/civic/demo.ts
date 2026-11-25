/**
 * Demo personas (S-166): sign in as a ready-made admin, officer, moderator, volunteer, resident... WITHOUT registering. For local development,
 * demos and user-acceptance testing only. Mounted by server/civic/index.ts when NODE_ENV !== "production" AND CIVIC_ENV !== "production"
 * AND CIVIC_DEMO_PERSONAS=1; production start-up also refuses CIVIC_DEMO_PERSONAS=1 (guards.ts), so it can never be on there.
 *
 *   GET  /api/v1/civic/demo/personas          -> 200 { personas: [{ key, label, description, roles }] }   (404 when the feature is off)
 *   POST /api/v1/civic/demo/login { persona } -> 200 { token, person, roles, persona }
 *
 * A persona is a real account in the real tables with the real core roles, so the consoles under test go through the real authorisation
 * path. It has no phone, no email and no PIN, so it can only be reached through this route. It is created once and reused. Each persona's
 * row carries the flag "demo". Nothing here may be used to produce published results; the flag lets any figure builder exclude them.
 */
import express, { Router } from "express";
import crypto from "node:crypto";
import { ROLE_NAMES, audit, createSession, getDb, getKeys, grantRole, recordConsent, type RoleName } from "./core";
import { AGE_GATE_DAYS, getPerson, publicPerson, touchActive } from "./identity/service";
import { isLocalHost, isProductionEnv } from "./guards";

export const DEMO_FLAG = "demo";
export const demoEnabled = (): boolean => !isProductionEnv() && process.env.CIVIC_DEMO_PERSONAS === "1";

export interface DemoPersona {
  key: string; label: string; description: string;
  roles: { role: RoleName; jurisdiction?: string; department?: string }[];
  residence?: boolean; matureDays?: number; emailOnly?: boolean;
}

const DEMO_VILLAGE = "demo-village";
export const DEMO_PERSONAS: DemoPersona[] = [
  { key: "resident_new", label: "New resident", description: "Just signed up: unverified (T0), inside the 14-day waiting period.", roles: [] },
  { key: "resident_verified", label: "Verified resident", description: "Declared a village (T1) and past the waiting period: can report issues and take surveys.", roles: [], residence: true, matureDays: AGE_GATE_DAYS + 1 },
  { key: "resident_email_only", label: "Email-only resident", description: "Signed up with an email and no phone: can report issues, cannot take surveys.", roles: [], emailOnly: true },
  { key: "volunteer", label: "Volunteer", description: "Enrolled volunteer: can enrol adults and confirm neighbours.", roles: [{ role: "volunteer" }], residence: true, matureDays: AGE_GATE_DAYS + 1 },
  { key: "officer", label: "Government officer", description: "Verified officer of the Demo Department.", roles: [{ role: "officer", department: "Demo Department" }] },
  { key: "politician", label: "Politician", description: "A representative who can reply to issues.", roles: [{ role: "politician", department: "DEMO" }] },
  { key: "moderator", label: "Moderator", description: "Reviews held and reported content.", roles: [{ role: "moderator" }] },
  { key: "journalist", label: "Journalist", description: "Read access for journalists.", roles: [{ role: "journalist" }] },
  { key: "geo_reviewer", label: "Geo reviewer", description: "Reviews location and boundary corrections.", roles: [{ role: "geo_reviewer" }] },
  { key: "eci_liaison", label: "ECI liaison", description: "Election Commission liaison for election notices.", roles: [{ role: "eci_liaison" }] },
  { key: "survey_panel", label: "Survey panel member", description: "A nominated independent panel member for survey wording.", roles: [{ role: "survey_panel", department: "Demo Panel" }] },
  { key: "assist_coordinator", label: "Assisted-participation coordinator", description: "Coordinates assisted participation (still off unless enabled).", roles: [{ role: "assist_coordinator" }] },
  { key: "assist_reviewer", label: "Assisted-participation reviewer", description: "Reviews assisted participation records.", roles: [{ role: "assist_reviewer" }] },
  { key: "admin", label: "Platform admin", description: "Full admin console access.", roles: [{ role: "admin" }] },
];

const ROLE_SET = new Set<string>(ROLE_NAMES);

/** Find or create the single account for a persona, and make sure it still holds its roles. */
export function ensureDemoPerson(persona: DemoPersona): string {
  const d = getDb();
  const label = "demo:" + persona.key;
  let row = d.prepare("SELECT id FROM persons WHERE label = ? AND deleted_at IS NULL").get(label) as { id: string } | undefined;
  if (!row) {
    const id = crypto.randomUUID();
    const now = new Date();
    const mature = persona.matureDays ? new Date(now.getTime() - persona.matureDays * 86_400_000) : now;
    const flags = [DEMO_FLAG, ...(persona.emailOnly ? ["email_only"] : [])];
    d.prepare(
      `INSERT INTO persons (id, tier, phone_hash, phone_enc, pin_salt, pin_hash, label, flags, created_at, eligible_from)
       VALUES (?, 'T0', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`).run(id, label, JSON.stringify(flags), mature.toISOString(), new Date(mature.getTime() + AGE_GATE_DAYS * 86_400_000).toISOString());
    if (persona.residence) {
      d.prepare("UPDATE persons SET residence_enc = ?, residence_unit = ?, residence_declared_at = ?, tier = 'T1' WHERE id = ?")
        .run(getKeys().encrypt("residence", "Demo village"), DEMO_VILLAGE, now.toISOString(), id);
    }
    touchActive(id, now);
    recordConsent(id, "signup", "v1");
    audit("system", "demo.persona_created", "person:" + id, { persona: persona.key });
    row = { id };
  }
  for (const g of persona.roles) grantRole("system", row.id, g.role, g.jurisdiction ?? null, g.department ?? null);
  return row.id;
}

export function createDemoRouter(): Router {
  const r = Router();
  r.use(express.json({ limit: "2kb" }));
  r.use((req, res, next) => {
    // Double guard: the feature flag AND a local address. A reverse proxy on a public host never reaches this route.
    if (!demoEnabled() || !isLocalHost(req)) return void res.status(404).json({ error: "not found" });
    next();
  });
  r.get("/personas", (_req, res) => {
    res.json({ personas: DEMO_PERSONAS.map((p) => ({ key: p.key, label: p.label, description: p.description, roles: p.roles.map((x) => x.role) })) });
  });
  r.post("/login", (req, res) => {
    const key = typeof req.body?.persona === "string" ? req.body.persona : "";
    const persona = DEMO_PERSONAS.find((p) => p.key === key);
    if (!persona || persona.roles.some((x) => !ROLE_SET.has(x.role))) return void res.status(400).json({ error: "unknown persona" });
    const id = ensureDemoPerson(persona);
    audit(id, "demo.login", "person:" + id, { persona: persona.key });
    const me = getPerson(id)!;
    res.json({ token: createSession(id, { label: "demo " + persona.key }), person: publicPerson(me), roles: persona.roles.map((x) => x.role), persona: persona.key });
  });
  return r;
}
