# Gate row 6: Audit log head anchored externally with independent witnesses

Row 6 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. Agreements with each independent witness (who they are, what they store, how long, who can read it).
2. Anchor samples: at least a week of acknowledged anchors from the witness side, and the result of GET /audit/verify comparing them to the live chain.
3. The production configuration showing CIVIC_ANCHOR_URL (or an equivalent sink) is set.

## Acceptance criteria

- At least one witness outside the operator's control that the operator cannot rewrite.
- A deliberate tamper test on a copy of the database was detected by the verify endpoint using the witness copy.
- Pending (unacknowledged) anchors are zero in steady state.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/audit.public.test.ts#@E2E-159` - HTTP witness sink, retry, verify against the witness
- `tests/civic/core.test.ts#@E2E-51` - chain and external anchor detection
- `tests/civic/jobs.test.ts#@E2E-81` - hourly anchor and verify jobs

## Template

Copy this into `docs/gate/06/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Witnesses: ____ ; agreement dates: ____
Configuration: sink ____ ; since ____
Sample window: ____ to ____ ; acknowledged: ____ ; mismatches: ____
Tamper test: date ____ result ____
```

## Attach

Put the artefacts in `docs/gate/06/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
