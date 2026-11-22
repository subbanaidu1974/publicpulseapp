# Gate row 18: Cost model for SMS/IVR/data published; who pays decided

Row 18 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. A published cost model covering SMS (OTP, invites, lockout notices), IVR minutes, data and hosting for the pilot, with the SMS hourly budget justified against it.
2. A decision record on who pays.

## Acceptance criteria

- The model uses quotes or contracts, not guesses, and states its assumptions.
- The payer is named.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- (none: this row is entirely human evidence)

## Template

Copy this into `docs/gate/18/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Model URL: ____ ; date: ____ ; SMS budget per hour: ____
Payer: ____ ; decided by: ____ date ____
```

## Attach

Put the artefacts in `docs/gate/18/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
