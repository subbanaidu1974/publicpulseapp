# Gate row 16: MCC and survey-publication rules checked for the election calendar

Row 16 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. A counsel memo covering the Model Code of Conduct and any survey-publication restrictions for the election calendar of the pilot period.

## Acceptance criteria

- The memo names the dates and the consequence for what the product may publish.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- (none: this row is entirely human evidence)

## Template

Copy this into `docs/gate/16/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Counsel: ____ ; date ____ ; election calendar covered: ____ ; blackout dates: ____
```

## Attach

Put the artefacts in `docs/gate/16/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
