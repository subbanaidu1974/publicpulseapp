# Gate row 17: IVR personal-PIN step built

Row 17 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. The CI run (or a recorded local run) of tests/civic/channels.pin.test.ts at the release commit, attached with the commit hash.
2. If live telephony exists: a recorded test call through the real adapter showing the PIN step.

## Acceptance criteria

- The PIN step is required for single-adult and shared SIMs by default, locks out after 5 wrong PINs, and the PIN is never stored, echoed or sent by SMS.
- The standalone /voice-note webhook behaviour (single adult needs PIN, shared SIM refused) is understood by the approver.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/channels.pin.test.ts#@E2E-71` - personal PIN flow, lockout, no echo, default-on
- `tests/civic/channels.pin.test.ts#@E2E-55` - who-then-PIN flow
- `tests/civic/channels.ivr.test.ts#@E2E-161` - IVR flow

## Template

Copy this into `docs/gate/17/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Commit: ____ ; test run: ____ (CI link or log)
Live adapter test: date ____ result ____ ; approver: ____
```

## Attach

Put the artefacts in `docs/gate/17/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
