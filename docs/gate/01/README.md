# Gate row 1: Threat model reviewed against the current build

Row 1 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. A copy of docs/THREAT_MODEL.md as reviewed, with the reviewer's name, role and date, and the git commit hash it was checked against.
2. The reviewer's list of rows in section 4A they re-verified in the code, and any row they changed or disputed.

## Acceptance criteria

- Reviewer is not the author of the controls under review (name the author for comparison).
- Every row of section 4A was read against the cited code, not only the table.
- Disagreements are recorded as changes to the table or as new rows in the residual risk register (section 6).

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/gate/traceability.test.ts#@E2E-80` - cited files, lines and test tags exist
- `docs/THREAT_MODEL.md` - traceability table and residual risk register

## Template

Copy this into `docs/gate/01/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Reviewer: ____ (role ____, independent of the build: yes/no)
Date: ____  Commit: ____
Rows re-verified: T-__ to T-__ ; changed: ____ ; disputed: ____
Result: accepted / accepted with changes / rejected
```

## Attach

Put the artefacts in `docs/gate/01/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
