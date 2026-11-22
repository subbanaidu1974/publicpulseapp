# Gate row 14: Retention schedule, erasure, CERT-In procedure, disclosure policy, bug bounty

Row 14 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. A counsel-approved retention schedule (docs/RETENTION.md turned from draft).
2. A tested erasure run on production-like data: a person with reports, media and household links erased, with the dump-all-tables check run before and after, and the audit redaction shown.
3. A CERT-In incident reporting procedure with real contacts and timelines confirmed by counsel (docs/BREACH_RUNBOOK.md).
4. A published disclosure policy and a bug bounty or equivalent.

## Acceptance criteria

- Erasure leaves no table or column holding the person id or phone hash, other than backups that are within the stated rotation window.
- The runbook has no placeholder contacts.
- The disclosure policy is public.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/identity.test.ts#@E2E-52` - erasure and audit redaction
- `tests/civic/issues.erasure.test.ts#@E2E-158` - dump-all-tables after deletion
- `tests/civic/identity.test.ts#@E2E-53` - retention job
- `docs/RETENTION.md` - retention draft
- `docs/BREACH_RUNBOOK.md` - breach runbook draft

## Template

Copy this into `docs/gate/14/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Counsel approval: ____ date ____
Erasure run: date ____ operator ____ result ____ backups rotate by ____
CERT-In contact: ____ ; disclosure policy URL: ____ ; bounty: ____
```

## Attach

Put the artefacts in `docs/gate/14/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
