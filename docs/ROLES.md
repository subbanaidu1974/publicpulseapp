# Roles, scope and who sees what (S-40, E2E-49)

Source of the policy: `docs/DESIGN_2028.md` section 5. Code: `server/civic/scope/**` (model, middleware, routes), roles table in `server/civic/core`.
Roles are granted only through the dual-control admin API (`/api/v1/civic/admin/roles/requests`); nobody grants themselves a role.

## Scope model

A role grant has a **jurisdiction** (an LGD unit code in `roles.jurisdiction`; empty means state-level) and an optional **department** (officers).

| Jurisdiction | Reaches |
|---|---|
| empty (state-level) | every unit. Not valid for a politician: a politician grant without a constituency reaches nothing. |
| state code | the state and everything below it |
| district code | the district, its mandals and villages, and any constituency whose villages overlap the district |
| constituency code | the constituency, its linked villages, and the mandals that contain at least one of them |
| mandal code | the mandal and its villages |
| village code | that village |

`scopeCovers(grant, unit, asOf)` evaluates this against the boundary version valid on `asOf` (default today). A village that moved to another
constituency stops being covered by the old one from the change date. Unknown units are never covered. At grant time the admin API checks
the format: a politician needs a constituency, a journalist or ECI liaison may only be state-level (`400 invalid jurisdiction for this role`).

Middleware: `requireScope(role(s), unitFromReq, {department})`. No grant: `403 forbidden` (code `role_required`). Grant that does not reach the
unit: `403 outside_scope`. Officer with another department: `403 department_mismatch`. Every refusal writes a `scope.denied` audit entry
(actor, unit code, reason; never request content). Every dashboard read of aggregates writes a `read.sensitive` entry.

## Who sees what

Cells: `yes` allowed, `scoped` allowed for units inside the caller's grant only (other units answer 403 `outside_scope`), `no` refused with 403.
A test (`tests/civic/scope/roles-matrix.test.ts`) parses this table and checks every cell against the running routes.

<!-- matrix:start -->
| Role | me | issues_summary | surveys_summary | audit_summary | export |
|---|---|---|---|---|---|
| citizen | yes | no | no | no | no |
| politician | yes | scoped | yes | no | no |
| officer | yes | scoped | yes | no | no |
| journalist | yes | yes | yes | no | yes |
| eci_liaison | yes | no | yes | yes | no |
| admin | yes | yes | yes | yes | no |
<!-- matrix:end -->

Columns are the routes under `/api/v1/civic/scope`: `me` = `GET /me`, `issues_summary` = `GET /issues/summary?unit=`, `surveys_summary` = `GET /surveys/summary`,
`audit_summary` = `GET /audit/summary`, `export` = `GET /export`.

## Unit tree for the picker (S-156)

`GET /scope/units?parent=<unit code>&level=<state|district|constituency|mandal|village>` (politician, officer, journalist, admin) returns one level of the tree for the dashboard's unit picker, only units inside the caller's grants: `{parent, level, units:[{lgd, level, name_en, name_te, parent, has_children}], total, truncated}`. Without `parent` it lists the top: the states for a state-level grant, otherwise the unit each scoped grant names (a constituency politician sees just their constituency). A constituency's children are the mandals (or stray villages) that hold its villages; a district's children are its mandals; constituencies are not listed under a district unless `level=constituency` is asked. `level=` alone lists a whole level (district, constituency, mandal; villages must be reached through a `parent`). The `lgd` codes are exactly what `/scope/issues/summary?unit=` accepts. A `parent` outside the caller's scope answers 403 `outside_scope` (audited), an unknown one 400 `unknown_unit`, a role without a dashboard 403 `role_required`; the route is GET-only like the rest of the router.

## Rules that hold for every role

- **No early access.** `/scope/surveys/summary` lists only figures already published (same gate as the public `/surveys/:id/results`); the journalist export is byte-identical to the public `/issues/export`.
- **No individual data.** No route returns a person, a response, a draft or a reporter. Issue figures are counts per department; a cell under 30 reports is withheld and only named, and the total sums shown cells only so a small cell cannot be recovered by subtraction.
- **Read-only.** The scope router answers `405` to anything but GET and HEAD. The ECI liaison holds no admin role, so every mutating admin route answers 403.
- **Audit.** Denials and aggregate reads are in the hash-chained audit log; the audit summary returns the head, anchors, job health and block-log counts with no actor ids.

## Per role

| Role | Scope | Notes |
|---|---|---|
| politician | own constituency only | own geography; cannot read another constituency (403). No notifications, no individuals. |
| officer | own jurisdiction and department | other department or outside jurisdiction is 403. |
| journalist | state-level, read-only | the same open data as everyone; bulk feed through `/scope/export` or the public export. |
| eci_liaison | state-level, read-only | integrity and audit dashboards only; no platform controls. |
| admin | state-level | operates the platform; reads no individual answers. |
