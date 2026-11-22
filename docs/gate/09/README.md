# Gate row 9: WCAG 2.2 AA audit including Telugu screen-reader testing

Row 9 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. An audit report from an accessibility auditor, including manual testing with at least one screen reader in Telugu and testing with people with disabilities.
2. A list of failures with severity and fix status.

## Acceptance criteria

- No open AA failures on the pilot flows (sign-up, login, report an issue, household invite, lite page) or each formally accepted.
- Testing covered Telugu and English and at least one mobile screen reader.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `e2e/civic-a11y.spec.ts#@E2E-57` - automated checks (necessary, not sufficient)

## Template

Copy this into `docs/gate/09/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Auditor: ____ ; date: ____ ; screen readers: ____ ; participants with disabilities: ____
Flows covered: ____ ; open AA failures: ____ ; accepted by: ____
```

## Attach

Put the artefacts in `docs/gate/09/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
