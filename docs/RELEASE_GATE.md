# Release gate checklist (E2E-58, manual evidence)

**E2E-58 is a manual-evidence checklist. It is tracked here and in `docs/stories/tracker.json` but is deliberately NOT automated.** No election-adjacent survey may go live until every item below has an owner, a date and an attached artefact. A box is checked by a person who has attached real evidence; automated test results are listed per row as supporting evidence only. Owners and dates are human decisions and are left blank.

Scope: DESIGN_2028 section 3.8 item 8, section 3.9 (pilot first), section 3.10 (compliance, all **[VERIFY]** with counsel).

Tooling (S-153, E2E-168): each row has a folder `docs/gate/NN/` with a `README.md` (exact evidence required, acceptance criteria, a template, and the automated evidence that exists) and an `evidence/` folder where the attached artefacts go. `npm run gate:status` (add `-- --json` for JSON) reads this table and those folders and prints, per row, the automated evidence found, the human evidence missing, whether owner and date are present, and the blocked rows. It never checks a box and never invents an owner or date.

The "Evidence to attach" column says what a human must attach. Text after "Automated so far:" says what the repository already provides; it is necessary background, never sufficient.

| # | Gate | Evidence to attach | Owner | Date | Done |
|---|---|---|---|---|---|
| 1 | Threat model reviewed against the current build (`docs/THREAT_MODEL.md`) | Reviewed copy with reviewer name and commit hash. Automated so far: the traceability table (section 4A) is reconciled with the code and `tests/gate/traceability.test.ts` fails if a cited file or test tag is missing; that proves the references exist, not that the controls are adequate | | | [ ] |
| 2 | Independent red-team and penetration test report | Report from a party independent of the builders; all critical and high findings fixed or formally accepted. Automated so far: scope document `docs/RED_TEAM_SCOPE.md` (a draft for the human commissioning the test) | | | [ ] |
| 3 | Pilot skew report (2-3 mandals): response by gender, age, phone ownership | Published report with method. Automated so far: `npm run pilot:skew` computes response-rate skew and a representativeness index from aggregate counts (plan in `docs/PILOT_SKEW_PLAN.md`); no pilot has run, so there is no data. Electoral-roll marginals are not available; Census 2011 gives sex only | | | [ ] |
| 4 | Keys in HSM/KMS with per-purpose keys, rotation and dual-control break-glass | Configuration evidence and drill record. Automated so far: the `KeyProvider` interface with purpose binding exists and production startup refuses the dev provider; the only implementation is the dev provider (keys derived from one env string). Rotation and break-glass are not built | | | [ ] |
| 5 | Identity, issue and survey data in separate stores with no cross-store joins | Architecture diagram and schema check. Built (S-74, E2E-89): four separate SQLite files (identity, issues, survey placeholder, audit), layout and diagram in `docs/STORES.md`; the schema check is automated in `tests/civic/stores.test.ts` (no ATTACH, no SQL statement naming tables of two stores, every store holds only its own tables, the issues store holds no `persons.id`). Still needed here: reviewer sign-off on the diagram, and the production deployment evidence (separate volumes or hosts per store, per-store access control: the pilot puts all four on one host) | | | [ ] |
| 6 | Audit log head anchored externally with independent witnesses | Witness agreements and anchor samples. Automated so far: anchor sinks (file, HTTP witness with signed body and retry), hourly anchor job and verify job with alarm, public verify endpoint. The default sink is a no-op unless `CIVIC_ANCHOR_URL` or `CIVIC_AUDIT_ANCHOR_FILE` is set, and no independent witness exists | | | [ ] |
| 7 | OTP-send budget, per-ASN/device caps and degraded mode load-tested (E2E-56) | Load test results. Automated so far: load tests exist with measured numbers (`scripts/load/otp-flood.ts`, `npm run load:otp`; results in `docs/PERFORMANCE.md` section 2; smoke run in `tests/load/load.smoke.test.ts`): every cap held on localhost, one process, dev stand-ins. Still needed: a run against target hardware with the real SMS provider's behaviour, and a human review of the results. Note the "per-ASN" cap is an address-prefix proxy (/24, /48) unless an attested request or trusted edge supplies the ASN, and the per-device cap needs a verified device id; the load test exercises the prefix proxy | | | [ ] |
| 8 | Sender security (FIDO2, signed payloads, anti-phish word, kill-switch), if notifications are in scope | Test record. Not built; mark "not in scope" with a named approver if notifications are excluded from the release | | | [ ] |
| 9 | WCAG 2.2 AA audit including Telugu screen-reader testing with people with disabilities (E2E-57 automated checks are necessary, not sufficient) | Audit report. Automated so far: Playwright accessibility checks (`e2e/civic-a11y.spec.ts`) | | | [ ] |
| 10 | Human-recorded Telugu audio for every IVR prompt (coastal, Rayalaseema, Telangana variants); placeholders replaced | Signed-off `data/civic/audio-manifest.json` with `status` changed from `placeholder` | | | [ ] |
| 11 | Telecom or aggregator agreement for missed-call and IVR in the pilot state | Executed agreement; TRAI/DLT registrations. Automated so far: the webhook is built and tested against a simulated aggregator only | | | [ ] |
| 12 | PWA-lite measured on 2G-class connection and low-end device | Measurement log. Automated so far: the size budget (`tests/load/lite.size.test.ts`, `tests/civic/channels.size.test.ts`) and a simulated-2G measurement (`e2e/lite.spec.ts`, `npm run measure:lite`; first usable form median 3.0 s on a 50 kbit/s, 300 ms RTT profile; `docs/PERFORMANCE.md` section 1). Still required: a run on a physical low-end Android phone on a real throttled network, which a simulator on a development laptop does not replace | | | [ ] |
| 13 | DPDP notices and consent artefacts approved by counsel; Data Fiduciary assessment; DPO and grievance contact appointed | Counsel sign-off; real grievance officer replacing the placeholder (`grievance@example.invalid`) | | | [ ] |
| 14 | Retention schedule, erasure (including audit-log redaction), CERT-In incident reporting procedure, disclosure policy and bug bounty | Policies and a tested erasure run. Automated so far: erasure including audit-log redaction and a retried cross-store outbox, and the retention job, are built and tested (`tests/civic/identity.test.ts`, `tests/civic/issues.erasure.test.ts`); `docs/RETENTION.md` and `docs/BREACH_RUNBOOK.md` are drafts. Still needed: counsel-approved policies, CERT-In procedure with real contacts, disclosure policy, bounty, and an erasure run on production-like data | | | [ ] |
| 15 | IT Act s.79 intermediary duties, takedown and appeals; defamation handling for reports naming individuals | Process documents. Automated so far: hold-for-review, appeal and takedown flows (`tests/civic/issues.test.ts`, `tests/civic/issues.moderation.test.ts`) | | | [ ] |
| 16 | MCC and survey-publication rules checked for the election calendar | Counsel memo | | | [ ] |
| 17 | IVR personal-PIN step built (shared SIMs currently refused) | Test record. Built: the IVR asks which adult on a shared SIM, then that adult's personal PIN, with the identity lockout; single-adult SIMs also give the PIN by default; the PIN is never stored or echoed (`tests/civic/channels.pin.test.ts`, `server/civic/channels/routes.ts`). The standalone `/voice-note` webhook still refuses a shared SIM by design. A human attaches the CI run of that test file and confirms against the live telephony adapter when one exists | | | [ ] |
| 18 | Cost model for SMS/IVR/data published; who pays decided | Published model | | | [ ] |

## Sign-off

Release is blocked until all rows are checked and two named approvers (one of them not on the build team) sign below.

- Approver 1: ____________  Date: ______
- Approver 2 (independent): ____________  Date: ______

## Evidence still required for S-48 (status: in progress, not done)

S-48 stays open until the artefacts below exist and are linked here. As of this commit none exist; the threat model, this checklist and the tooling around them are the only deliverables.

- **Independent red-team / penetration test (row 2).** Needed: scope covering identity (OTP, PIN, device caps), household invites, IVR/SMS channels and the audit log (a draft is in `docs/RED_TEAM_SCOPE.md`); report from a party independent of the builders; every critical/high finding fixed or formally accepted; findings appended to `docs/THREAT_MODEL.md` with status.
- **Pilot skew report (row 3).** Needed: 2-3 pilot mandals, response rates by gender, age band and phone ownership (including shared-SIM households), stated method and caveats, published before any result is shown. Pilot results must carry the non-representative caveat.
- **Threat model review (row 1).** Needed: named reviewer, date and commit hash against which `docs/THREAT_MODEL.md` was checked.
- **Two approvers (above), one independent of the build team.**

Not evidence: passing automated tests (E2E-54, E2E-57, E2E-80, E2E-168), the draft notice text, the placeholder grievance officer, or the existence of a README in `docs/gate/`.
