# Commissioning pack for the release gate (S-48, S-153)

Status: DRAFT, ready for you to fill in and send. It names no vendor, price or person. Nothing here has been sent to anyone.

Four things move the gate: (1) name the owners and the two approvers, (2) commission the independent red-team, (3) commission the independent crypto review, (4) run the pilot and publish the skew report. This file gives you the fill-in sheet and ready-to-send briefs for each.

## 1. Fill-in sheet: people (do this first, takes one sitting)

**Temporary placeholders, entered 2026-11-24 at the owner's request so planning can continue.** Every name below beginning PLACEHOLDER- stands for a real person not yet chosen. They are deliberately NOT copied into the table or sign-off lines of `docs/RELEASE_GATE.md`, so `npm run gate:status` still reports owners and approvers as missing. Replace each placeholder with a real name, then copy owners into that table.

| Role | Name | Contact | Independent of the build team? |
|---|---|---|---|
| Project owner (accountable for the whole gate) | PLACEHOLDER-OWNER | ____ | no |
| Approver 1 (signs the release) | PLACEHOLDER-APPROVER-1 | ____ | may be the owner |
| Approver 2 (signs the release) | PLACEHOLDER-APPROVER-2-INDEPENDENT | ____ | **must be yes**: someone who did not build or fund-direct the build |
| Security contact for testers, reachable 24 hours in the test window | PLACEHOLDER-SECURITY-CONTACT | ____ | no |
| Engagement lead who accepts or rejects findings | PLACEHOLDER-ENGAGEMENT-LEAD | ____ | no |
| Pilot lead | PLACEHOLDER-PILOT-LEAD | ____ | no |
| Statistician to review the pilot method | PLACEHOLDER-STATISTICIAN | ____ | preferably yes |
| Counsel (rows 13 to 16) | PLACEHOLDER-COUNSEL | ____ | yes |

Then for each of the 18 rows write an owner and a date in the table in `docs/RELEASE_GATE.md`. `docs/gate/OWNERS_AND_SCHEDULE.md` says which kind of person suits each row.

## 2. Independence rules (use these to choose, and keep the evidence)

* The red-team and the crypto reviewer must not have written or been paid to write any code in this repository, and must not report to the build team. Ask each to sign a one-line independence statement with name and date; attach it to the report.
* Approver 2 must not be on the build team.
* Give testers the commit hash (tag), a staging deployment that uses simulators, and the scope. Never give them production secrets.
* Findings: every critical and high finding is fixed or formally accepted in writing by the engagement lead, with a reason.

## 3. Brief to send: independent red-team (row 2)

Subject: Request for proposal, security test of a civic participation platform (Andhra Pradesh and Telangana)

> We run a public platform where residents report local issues and answer surveys with a one-time anonymous credential. We want an independent security test before launch. Scope, assets, rules of engagement and deliverables are in the attached `docs/RED_TEAM_SCOPE.md` (controls T-01 to T-52 in `docs/THREAT_MODEL.md`; a self-assessment exists and is labelled not independent). Please quote for: a test window of about ____ weeks against a staging deployment at tag ____; one retest after fixes; a written report with severity, evidence and reproduction steps for each finding, plus your independence statement. Tell us your team's relevant experience (identity, OTP and IVR channels, audit logs), your availability from ____, your price and contract form, and any access you need. Findings are confidential until we have fixed them; we will agree a disclosure date with you.

Attach: `docs/RED_TEAM_SCOPE.md`, `docs/THREAT_MODEL.md`, `docs/STORES.md`. Fill the "Engagement facts" table in the scope first.

## 4. Brief to send: independent cryptographic review (row 4 of S-48, the survey credential)

Subject: Review request, RSA blind-signature survey credential (RFC 9474)

> We use RSABSSA-SHA384-PSS-Randomized (RFC 9474) so a verified resident can answer a survey once without the answer being linkable to their account. Our build team has run the RFC's Appendix A.1 vector against both the server code and the browser client and they match. We now want an independent review. The review pack is `docs/gate/evidence/crypto-review-pack.md`; it lists what is in scope, what is out of scope (key custody, which is a separate row), and eight questions. Please return written findings with severity, which RFC 9474 vectors you ran, and your independence statement. Please quote a fixed fee and a time estimate; the source is small (`server/civic/surveys/blind.ts`, `src/lib/blind.ts`, `credential.ts`, `responses.ts`) and the tests run with `npx vitest run tests/civic/surveys`.

Attach: the pack, `docs/SURVEYS.md`, `docs/THREAT_MODEL.md` section 5.

## 5. Plan: pilot and skew report (row 3)

1. Pick 2 to 3 pilot mandals and get permission to run there (owner and counsel).
2. Decide the reference data honestly: Census 2011 gives sex only at mandal level; the electoral roll is not available (see `docs/PILOT_SKEW_PLAN.md`). The report must say so.
3. Run the pilot with only aggregate counts recorded per stratum: invited, responded, by gender, age band, phone ownership, shared SIM.
4. Run `npm run pilot:skew` on the counts, have the statistician check the method, and publish the report **before any pilot result is shown**.
5. Every figure from the pilot carries: "a signal, not a representative sample".

## 6. Order and timing (suggested; yours to set)

Week 0: fill section 1; name owners in `docs/RELEASE_GATE.md`. Week 1: send sections 3 and 4; book counsel. Weeks 2 to 6: staging deployment, red-team and crypto review, fixes, retest. In parallel: pilot preparation. Last: pilot, skew report, sign-off. Run `npm run gate:status` after each step; it shows what is still missing and never ticks a box for you.

## 7. What this pack does not do

It does not hire anyone, pick a vendor, set a price, or confirm that any person is independent. Those stay with you.
