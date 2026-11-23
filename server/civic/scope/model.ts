/**
 * Scope model (S-40, E2E-49): a role grant carries a geographic jurisdiction, stored in core `roles.jurisdiction` (an LGD unit code:
 * state | district | mandal | village | constituency; empty = state-level / everywhere) plus an optional department (officers).
 *
 * `scopeCovers(grant, unit, asOf)` answers "does this grant reach this unit?":
 *   - an empty jurisdiction (state-level) covers every unit that exists at asOf;
 *   - a unit code covers itself and everything below it in the LGD tree (state > district > mandal > village);
 *   - a constituency covers its linked villages and the mandals that contain at least one of them;
 *   - a district covers a constituency whose villages overlap the district (an AC straddling districts is reachable from both).
 * Everything is evaluated against the boundary version valid at `asOf` (default now), so a village that moved constituency stops being
 * covered by the old one from the change date. A unit that does not exist at asOf is covered by nobody except through a state-level
 * grant that is asked to resolve it first (callers answer 400 unknown_unit). Fail closed: scoped roles without the needed jurisdiction
 * (a politician with no constituency) cover nothing.
 */
import { getDb, getStore, listRolesDetailed } from "../core";
import type { RoleName } from "../core";
import { ancestors, getUnit, villageConstituencies } from "../geo/service";
import type { Unit } from "../geo/service";

export interface Grant { role: RoleName; jurisdiction: string | null; department: string | null }

/** Roles whose jurisdiction is validated on grant (admin dual-control API). */
export const SCOPED_ROLES = ["politician", "journalist", "eci_liaison"] as const;
const JURISDICTION_FORMAT = /^[A-Za-z0-9][A-Za-z0-9-]{1,39}$/;
const day = (d?: string | Date): string => (d instanceof Date ? d : d ? new Date(d) : new Date()).toISOString().slice(0, 10);

/**
 * Format check used when a role is granted (no geography lookup, so it is cheap and test-independent). Returns an error code or null.
 *   politician: jurisdiction REQUIRED (a constituency code)    journalist, eci_liaison: state-level only, so empty or a state code.
 */
export function validateGrantJurisdiction(role: string, jurisdiction: string): string | null {
  if (!(SCOPED_ROLES as readonly string[]).includes(role)) return null;
  const j = jurisdiction.trim();
  if (role === "politician") {
    if (!j) return "politician_needs_constituency";
    if (!JURISDICTION_FORMAT.test(j)) return "jurisdiction_format";
    return null;
  }
  if (!j) return null;
  if (!JURISDICTION_FORMAT.test(j)) return "jurisdiction_format";
  return null;
}

/** Level-aware check once geography is loaded: a politician's unit must be a constituency, the others' a state. Null = fine (or geography empty). */
export function validateGrantUnit(role: string, jurisdiction: string, asOf?: string | Date): string | null {
  const bad = validateGrantJurisdiction(role, jurisdiction);
  if (bad || !jurisdiction.trim() || !(SCOPED_ROLES as readonly string[]).includes(role)) return bad;
  const n = (getStore("issues").prepare("SELECT COUNT(*) c FROM admin_unit").get() as { c: number } | undefined)?.c ?? 0;
  if (!n) return null;
  const u = getUnit(jurisdiction.trim(), asOf);
  if (!u) return "unknown_jurisdiction";
  if (role === "politician" && u.level !== "constituency") return "politician_needs_constituency";
  if (role !== "politician" && u.level !== "state") return "state_level_only";
  return null;
}

/** Every grant the person holds for the role (core roles table; officers also from the legacy officer_role claim table). */
export function grantsOf(personId: string, role: RoleName): Grant[] {
  const out: Grant[] = listRolesDetailed(personId).filter((r) => r.role === role).map((r) => ({ role, jurisdiction: r.jurisdiction, department: r.department }));
  if (role === "officer" || role === "moderator") {
    try {
      const l = getDb().prepare("SELECT department, jurisdiction_lgd FROM officer_role WHERE person_id = ? AND role = ?").get(personId, role) as { department: string | null; jurisdiction_lgd: string | null } | undefined;
      if (l) out.push({ role, jurisdiction: l.jurisdiction_lgd || null, department: l.department || null });
    } catch { /* legacy table not created */ }
  }
  return out;
}

/** The unit codes whose grant would reach `unit` at `asOf`; null when the unit does not exist then. */
export function unitsReaching(unit: string, asOf?: string | Date): Set<string> | null {
  const u = getUnit(unit, asOf);
  if (!u) return null;
  const a = day(asOf), db = getStore("issues");
  const set = new Set(ancestors(unit, asOf).map((x) => x.lgd));
  if (u.level === "village") for (const c of villageConstituencies(unit, asOf)) set.add(c.lgd);
  else if (u.level === "mandal") {
    const rows = db.prepare(`SELECT DISTINCT vc.constituency_lgd AS c FROM admin_unit v JOIN village_constituency vc ON vc.village_lgd = v.lgd_code
      WHERE v.parent_lgd = ? AND v.valid_from <= ? AND (v.valid_to IS NULL OR v.valid_to > ?) AND vc.valid_from <= ? AND (vc.valid_to IS NULL OR vc.valid_to > ?)`)
      .all(unit, a, a, a, a) as { c: string }[];
    for (const r of rows) set.add(r.c);
  } else if (u.level === "constituency") {
    const rows = db.prepare(`SELECT DISTINCT COALESCE(m.parent_lgd, v.parent_lgd) AS d FROM village_constituency vc JOIN admin_unit v ON v.lgd_code = vc.village_lgd
      LEFT JOIN admin_unit m ON m.lgd_code = v.parent_lgd AND m.level = 'mandal'
      WHERE vc.constituency_lgd = ? AND vc.valid_from <= ? AND (vc.valid_to IS NULL OR vc.valid_to > ?) AND v.valid_from <= ? AND (v.valid_to IS NULL OR v.valid_to > ?) LIMIT 200`)
      .all(unit, a, a, a, a) as { d: string | null }[];
    for (const r of rows) if (r.d) set.add(r.d);
  }
  return set;
}

/** Does the grant reach the unit at asOf? Unscoped (state-level) grants reach every existing unit; unknown units are never reached. */
export function scopeCovers(grant: Pick<Grant, "role" | "jurisdiction">, unit: string, asOf?: string | Date): boolean {
  const reach = unitsReaching(unit, asOf);
  if (!reach) return false;
  const j = (grant.jurisdiction ?? "").trim();
  if (!j) return grant.role !== "politician"; // a politician grant without a constituency is invalid: it reaches nothing
  return reach.has(j);
}

/** Describe a unit for dashboards (names in both languages). */
export const describeUnit = (u: Unit | null) => (u ? { lgd: u.lgd, level: u.level, name_en: u.name_en, name_te: u.name_te } : null);
