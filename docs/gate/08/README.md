# Gate row 8: Sender security (FIDO2, signed payloads, anti-phish word, kill-switch)

Row 8 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. If notifications are in scope: a test record showing FIDO2-only sender sign-in, signed payloads, the anti-phish word in messages, and the kill-switch drill.
2. If notifications are NOT in scope for this release: a written decision, with the name of the approver, that no sender feature ships.

## Acceptance criteria

- Either every item is demonstrated, or the release contains no sender or notification feature and the approver said so in writing.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `docs/THREAT_MODEL.md` - T-46 records this control as not built

## Template

Copy this into `docs/gate/08/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
In scope: yes/no ; decided by: ____ date ____
If yes: FIDO2 test ____ signed payload test ____ anti-phish ____ kill-switch drill ____
```

## Attach

Put the artefacts in `docs/gate/08/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
