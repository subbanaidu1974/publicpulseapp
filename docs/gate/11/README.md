# Gate row 11: Telecom or aggregator agreement for missed-call and IVR

Row 11 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. The executed agreement with the telecom or aggregator for the pilot state.
2. TRAI / DLT registrations (entity, header, templates) relevant to SMS and voice.
3. The webhook secret exchange record (not the secret) and the source IPs registered.

## Acceptance criteria

- The agreement names the pilot state and the services (missed-call callback, IVR, SMS).
- Registrations are active, not applied for.
- A live test call passed through the signed webhook and the personal-PIN step.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/channels.webhook.test.ts#@E2E-71` - webhook authentication against a simulated aggregator
- `tests/civic/channels.pin.test.ts#@E2E-71` - IVR personal PIN

## Template

Copy this into `docs/gate/11/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Aggregator: ____ ; agreement date: ____ ; states: ____
DLT entity id: ____ ; templates: ____
Live test call: date ____ result ____
```

## Attach

Put the artefacts in `docs/gate/11/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
