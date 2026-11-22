# Gate row 13: DPDP notices and consent artefacts approved by counsel; DPO and grievance contact appointed

Row 13 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. Counsel's written sign-off on each notice and consent artefact (sign-up, household invite, minor dependent), in Telugu and English.
2. The Data Fiduciary assessment.
3. The appointment of a DPO and grievance officer with a real contact, replacing the placeholder in server/civic/households/notices/grievance_officer.json.

## Acceptance criteria

- No notice still reads DRAFT.
- The grievance contact is a monitored address and a named role, not grievance@example.invalid.
- Counsel's sign-off names the notice versions approved.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/households.test.ts#@E2E-54` - notices are served, versioned and marked DRAFT

## Template

Copy this into `docs/gate/13/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Counsel: ____ ; date: ____ ; versions approved: ____
DPO: ____ ; grievance officer: ____ ; contact: ____
```

## Attach

Put the artefacts in `docs/gate/13/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
