# Conditional gate A-1: assisted participation going live (S-49)

**Status: NOT DONE.** This row is conditional: it applies only if the owner decides to switch assisted participation on (`docs/ASSISTED_PARTICIPATION.md`). It is deliberately **not** numbered into the 18-row table in `docs/RELEASE_GATE.md`, so `npm run gate:status` does not count it and cannot be satisfied by it. If assisted participation is not switched on, the 18-row gate is unaffected. If it is switched on, this row must be complete before `ASSISTED_ENABLED=1` is set in production. Owner and date are human decisions and are left blank.

## The row (same format as RELEASE_GATE.md)

| # | Gate | Evidence to attach | Owner | Date | Done |
|---|---|---|---|---|---|
| A-1 | Assisted participation (S-49) may go live: every item of the go-live checklist in `docs/ASSISTED_RUNBOOK.md` section 9 has an owner, a date and an attached artefact | Pilot skew report showing the need; counsel sign-off on consent, notice and data-protection position; a phone-free grievance route with a named officer; two named, trained independent reviewers per district; the independent red-team section on this flow (`docs/RED_TEAM_SCOPE.md`, section 4A) with findings closed or accepted; the owner's decision in `DESIGN_2028.md` section 8 question 5; sunset date; kill-switch drill; native-speaker review of the Telugu handbook text. Automated so far: `server/civic/assisted/` and `tests/civic/assisted.test.ts` exist and cover the controls in the design note; they show the controls are built, not that the programme is safe or lawful | | | [ ] |

## Evidence required

1. Everything listed in the runbook go-live checklist (`docs/ASSISTED_RUNBOOK.md` section 9, items 1 to 15), each with owner and date.
2. Red-team report section on assisted participation: fake pairs, receipt replay, steering, topic creep, capture.
3. Signed approvals: the two approvers of `docs/RELEASE_GATE.md`, one independent of the build team.

## Acceptance criteria

- No item is ticked without an attached artefact in `docs/gate/assisted/evidence/`.
- The Telugu text in `docs/ASSISTED_HANDBOOK.md` carries a native-speaker and counsel review record, and the "machine-drafted" marks are removed only then.
- The sunset date is set and the kill switch has been drilled by two admins.

## Template

```
Decision: ____ ; owner: ____ ; date: ____
Checklist items complete: ____ of 15 ; red-team report: ____ ; counsel memo: ____
Sunset date: ____ ; kill-switch drill date: ____
```
