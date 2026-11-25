# Release gate: owner roles, order of work and what each row waits for (S-153)

Status: DRAFT for the owner. It names the kind of person each row needs, not a person, and gives no dates, because owners and dates are decisions for the owner (`npm run gate:status` reads them from the table in `docs/RELEASE_GATE.md` and never fills them in). When you name an owner and a date for a row, write them in that table and keep this file as the plan.

How to use it: pick the owner for each row, put name and date in `docs/RELEASE_GATE.md`, attach the artefact under `docs/gate/NN/evidence/`, then tick the box. `npm run gate:status` shows what is still missing.

## Rows grouped by what they wait for

### A. Outside specialists (cannot be done by the build team)

| Row | Gate | Role needed | Depends on | Notes |
|---|---|---|---|---|
| 2 | Independent red-team and penetration test | Security firm or an independent tester, not on the build team | Scope in `docs/RED_TEAM_SCOPE.md`; a staging deployment with simulators (the production guards refuse dev stand-ins) | Internal self-assessment exists and is labelled not independent |
| 4 | Keys in HSM/KMS, rotation, dual-control break-glass | Infrastructure lead plus a KMS vendor account | Vendor choice (S-64); real run of the KMS adapter | Adapter exists, verified only against a simulator |
| 9 | WCAG 2.2 AA audit with Telugu screen-reader users | Accessibility auditor and disabled testers who read Telugu | A stable build | Automated sweep passes (112 of 112) and is not sufficient |
| 10 | Recorded Telugu audio for every IVR prompt, three dialects | Linguist and voice artists | S-151 | Manifest still says placeholder |
| 11 | Telecom or aggregator agreement, TRAI and DLT registrations | Operator's business or legal lead | Operator decision (S-152); SMS vendor (S-63) | Webhook verified only against a simulator |
| 13 | DPDP notices and consents, Data Fiduciary assessment, DPO and grievance contact | Counsel, then a named grievance officer replacing the placeholder | Operator decision (S-152) | S-150 |
| 14 | Retention schedule, CERT-In procedure, disclosure policy, bug bounty | Counsel and the security lead | Row 13 | Erasure itself is built and tested |
| 15 | IT Act section 79 duties, takedown and appeals, defamation handling | Counsel | Operator structure | Flows are built; the process documents are not |
| 16 | Model code of conduct and survey-publication rules for the election calendar | Counsel memo | Which election dates apply | No automated evidence possible |

### B. Needs a pilot or a measurement outside this repository

| Row | Gate | Role needed | Depends on |
|---|---|---|---|
| 3 | Pilot skew report, 2 to 3 mandals | Pilot lead with a field team; a statistician to review the method | Pilot permission; roll marginals if counsel allows them; tooling (`npm run pilot:skew`) is ready |
| 6 | Audit log head anchored with independent witnesses | Operator plus two independent witnesses who agree in writing | Operator decision (S-152) |
| 7 | OTP-send budget and caps load-tested at real scale | Infrastructure lead with a staging environment and SMS vendor sandbox | Vendor choice (S-63); smoke-scale results exist |
| 12 | PWA-lite measured on real 2G and a low-end phone | QA lead with a real device | A hosted staging build; simulated measurement exists |

### C. Can be closed by the build team and a reviewer from outside it

| Row | Gate | Role needed | What to do |
|---|---|---|---|
| 1 | Threat model reviewed against the current build | A reviewer who did not write it | Review `docs/THREAT_MODEL.md` at a named commit; the traceability table is already reconciled by a test |
| 5 | Separate stores, no cross-store joins | Architect | Attach the diagram and the schema check output (`docs/STORES.md`) |
| 17 | IVR personal PIN | Build lead | Attach the test record; this row is built |
| 18 | Cost model published, who pays decided | Operator | Needs the S-152 decision; model in `docs/decisions/cost-model.md` |
| 8 | Sender security | Owner | Mark "not in scope" with a named approver if notifications are excluded from the first release, otherwise it is not built |

## Suggested order

1. Decide the operator and funding (S-152). Rows 6, 11, 13, 15 and 18 cannot move without it.
2. Name the two approvers, one outside the build team. Without them nothing can be signed.
3. Counsel engagement (rows 13, 14, 15, 16 together; one brief, one memo set).
4. Pick the SMS, number-intelligence and KMS vendors (S-62, S-63, S-64), then run the adapters and rows 4 and 7.
5. Row 1 review and row 5 and 17 attachments, which are quick.
6. Staging deployment, then rows 2, 9, 12 (these need a running build outside a developer machine).
7. Pilot and skew report (row 3) last: no result may be shown before it.

## What the build team can still add

Only evidence packs and templates; nothing here can replace an independent party. The conditional row A-1 (assisted participation) stays outside this table, see `docs/gate/assisted/README.md`.

## What this file does not claim

No row is done. Nothing here was reviewed by counsel or any outside party, and the role names are suggestions.
