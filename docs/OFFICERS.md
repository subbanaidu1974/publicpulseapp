# Verified government officer onboarding (S-141)

Code: `server/civic/officers/**` (router mounted at `/api/v1/civic/officers`), screens `src/components/civic/OfficerApply.tsx` (applicant) and `src/components/civic/consoles/OfficerApplications.tsx` (admin queue), both in English and Telugu. Tests: `tests/civic/officers.test.ts` (API only, no browser).

**Status: engineering done, real-world verification is a human step.** The software enforces the process below. It cannot tell a real posting order from a forged one, and it cannot prove that the applicant owns the e-mail address. People do that. See "Human steps" at the end.

## The flow

1. **Apply.** Any signed-in person sends: full name, department (one of the departments the issue workflow already uses), designation (optional), official e-mail, an optional area code (an LGD unit; the officer's reach), and the **letter**. The letter is uploaded first through the ordinary `POST /issues/media` route (a JPEG or PNG photo or scan, so the same size cap, safety scan, metadata stripping and encryption at rest apply, `docs/STORES.md`), and its `media:<id>` is passed as `letter_ref`. Only the uploader can attach it.
2. **Automated domain check, at submission.** The e-mail domain must equal an entry of the allow-list `data/civic/officer-domains.json` or be a subdomain of one on a label boundary (`dept.nic.in` passes, `evilgov.in` and `gov.in.example.com` fail). ASCII only (no look-alike letters), exactly one `@`. An address that fails is refused with `422 domain_not_allowed` and **nothing is stored**; the refusal is audited (reason only, not the address). The check is repeated when an admin verifies, in case the list changed.
3. **Human letter check, first admin.** `GET /officers/admin/queue` lists applications (name, e-mail and letter are visible to admins only; the read is audited as a privileged read). The admin opens the letter (`GET .../letter`, audited, never cached), ticks that it matches the name, post and department, and sends `POST .../verify` with their TOTP code. That does **not** grant anything: it files an ordinary dual-control role request (`grant officer`, with the department and area) through the same code path as `POST /admin/roles/requests`.
4. **Second admin approves.** A **different** admin approves that request at `/admin/roles/requests/:id/approve` with their own TOTP code. Only then does `grantRole` create the scoped `officer` role (department and area attached). The application status follows the request: `approved`, `rejected` (the second admin refused) or `expired` (72 hours, the person may apply again).
5. **Refusal.** One admin may reject an application with a reason (`POST .../reject`); refusing is the safe direction and needs no second person.

An admin can neither review nor approve a role for themselves (`403 self_grant`, also enforced on approval in the admin API now).

## What the officer role then means

The granted role carries the department and area. `roleOf` in `server/civic/issues/service.ts` now reads the department from the core role (before, a core officer acted for any department); `requireScope` on the dashboards already checked it. An officer with no department on the grant (older grants) still acts for any department inside the area.

## Limits and abuse controls

| Control | Value |
|---|---|
| Attempts per person | 30 per hour, valid or not |
| Complete applications per person | 3 per 30 days (`CIVIC_OFFICER_APPLY_PER_30D`); a typo does not use one up |
| Attempts per network address | 20 per hour (`CIVIC_OFFICER_APPLY_PER_IP_HOUR`) |
| Open applications | one at a time per person |
| MFA | every admin action (`x-totp-code`), 10 attempts per 15 minutes |
| Request lifetime | 72 hours, then the application is `expired` |

## Data and retention

* Name and e-mail are stored **encrypted** (`details_enc`, key purpose `people_contact`); the table also holds the e-mail **domain** in clear for the queue and for counting. Account erasure deletes the application row.
* The letter lives in the media store, retention-tagged (`CIVIC_MEDIA_RETENTION_DAYS`, default 180 days from `data/civic/retention-policy.json`) and is purged with it or on account erasure. It is never public; the admin route is the only reader besides the owner.
* Audit actions: `officer.application.submit | domain_refused | verify | reject | withdraw | approved | rejected | expired`, plus the existing `admin.role_request.*` and `role.grant` entries. No audit entry carries the name, e-mail or letter.
* Tables: `officer_application` (identity store, `docs/STORES.md`).

## API

| Route | Who | Notes |
|---|---|---|
| `GET /officers/domains` | public | allow-list (domain, body in EN and TE) and the departments |
| `POST /officers/applications` | signed in | `{full_name, department, designation?, official_email, jurisdiction?, letter_ref}` -> 201 `{id, status}`; errors carry `code` (`domain_not_allowed`, `bad_email`, `letter_required`, `unknown_department`, `jurisdiction_format`, `application_open`, `already_officer`, `rate_limited`) |
| `GET /officers/applications/mine` | signed in | own applications; no name or e-mail returned |
| `POST /officers/applications/:id/withdraw` | applicant | only while `submitted` |
| `GET /officers/admin/queue?status=` | admin | default `submitted`; also `awaiting_second_admin`, `approved`, `rejected`, `expired` |
| `GET /officers/admin/applications/:id/letter` | admin | the image, `Cache-Control: no-store` |
| `POST /officers/admin/applications/:id/verify` | admin + TOTP | `{letter_checked: true, note?}`; files the role request |
| `POST /officers/admin/applications/:id/reject` | admin + TOTP | `{note}` (5 or more characters) |

## Human steps before launch (not done by software)

1. The programme owner reviews and signs off `data/civic/officer-domains.json` (which domains count as official, per state and body). It ships with `gov.in`, `nic.in`, `ap.gov.in`, `telangana.gov.in` as a starting list only.
2. Admins agree a **written checklist** for the letter check (what a genuine posting order looks like for each department, who to call to confirm it). The software only records that the box was ticked.
3. **E-mail ownership is not proven.** The domain check shows the address is on an official domain, not that the applicant controls it. A follow-up is a one-time link sent to the address (needs a mail provider, not built here) or a callback to the department's published number by the verifying admin.
4. Decide whether PDF letters must be accepted. The media store takes JPEG and PNG only; a PDF needs a scanner and a metadata-stripping step first.
5. Legal review of what is stored about officials (name, work e-mail, letter) and the retention period; `docs/RETENTION.md`.
6. E2E-156 (the browser journey) is not written here; this story's tests are API tests.
