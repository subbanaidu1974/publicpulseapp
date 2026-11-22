# Gate row 2: Independent red-team and penetration test report

Row 2 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. The final report from a party independent of the builders, signed by the testing organisation, covering the scope in docs/RED_TEAM_SCOPE.md.
2. A findings table with severity, status (fixed, accepted, open) and retest result for each finding.
3. For every accepted critical or high finding: a named accepter and a reason.

## Acceptance criteria

- No open critical or high findings, each either fixed and retested or formally accepted by a named person.
- The tester had no commit access to the repository during the test and was not paid by a person whose work was under test.
- Findings are appended to docs/THREAT_MODEL.md section 8 with status.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `docs/RED_TEAM_SCOPE.md` - draft scope and rules of engagement

## Template

Copy this into `docs/gate/02/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Tester: ____ (organisation ____, independence statement attached: yes/no)
Test window: ____ to ____  Commit tested: ____
Findings: critical __ high __ medium __ low __ info __
Open critical/high: __ ; accepted by: ____
Retest date: ____
```

## Attach

Put the artefacts in `docs/gate/02/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
