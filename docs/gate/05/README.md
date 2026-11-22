# Gate row 5: Identity, issue and survey data in separate stores with no cross-store joins

Row 5 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. The architecture diagram (docs/STORES.md) with a reviewer's sign-off.
2. Production deployment evidence: each store file on its own volume or host, with its own access control, and the per-store credentials or file permissions.
3. The output of the schema/placement check run against the production configuration.

## Acceptance criteria

- Reviewer is independent of the author.
- The production layout is at least separate volumes with separate access, or the gap is formally accepted by a named person.
- The placement check passes on production data.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/stores.test.ts#@E2E-89` - no ATTACH, no cross-store SQL, per-store tables, no persons.id in issues
- `docs/STORES.md` - layout and diagram

## Template

Copy this into `docs/gate/05/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Reviewer: ____ date ____
Deployment: identity ____ issues ____ survey ____ audit ____ (volume/host, access control)
Placement check run: date ____ result ____
```

## Attach

Put the artefacts in `docs/gate/05/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
