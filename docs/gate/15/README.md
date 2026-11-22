# Gate row 15: IT Act s.79 intermediary duties, takedown and appeals; defamation handling

Row 15 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. A written process for takedown requests, appeals and defamation complaints about reports naming individuals, with timelines and who decides, reviewed by counsel.
2. A record that the process was exercised on a test case end to end.

## Acceptance criteria

- The process maps onto the hold, appeal and takedown flows in the product.
- Counsel confirmed the timelines against the current rules.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/issues.test.ts#@E2E-36` - named-individual hold, appeal, takedown audited
- `tests/civic/issues.moderation.test.ts` - evasion-tolerant detection

## Template

Copy this into `docs/gate/15/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Counsel: ____ ; date ____ ; process document: ____
Test case run: date ____ outcome ____
```

## Attach

Put the artefacts in `docs/gate/15/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
