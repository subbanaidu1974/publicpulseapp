# Release gate evidence folders

One folder per row of `docs/RELEASE_GATE.md` (S-153, E2E-168): `NN/README.md` lists the exact evidence required, the acceptance criteria, the automated evidence that already exists and a template; `NN/evidence/` is where the human attaches artefacts.

`npm run gate:status` prints, per row, the automated evidence found, the human evidence missing, whether an owner and date are set, and the blocked rows. `npm run gate:status -- --json` prints the same as JSON. Owners and dates are human decisions and are never filled in by tooling.

| Row | Folder |
|---|---|
| 1 | [01](./01/README.md) Threat model reviewed against the current build |
| 2 | [02](./02/README.md) Independent red-team and penetration test report |
| 3 | [03](./03/README.md) Pilot skew report (2-3 mandals) |
| 4 | [04](./04/README.md) Keys in HSM/KMS with per-purpose keys, rotation and dual-control break-glass |
| 5 | [05](./05/README.md) Identity, issue and survey data in separate stores with no cross-store joins |
| 6 | [06](./06/README.md) Audit log head anchored externally with independent witnesses |
| 7 | [07](./07/README.md) OTP-send budget, per-ASN/device caps and degraded mode load-tested |
| 8 | [08](./08/README.md) Sender security (FIDO2, signed payloads, anti-phish word, kill-switch) |
| 9 | [09](./09/README.md) WCAG 2.2 AA audit including Telugu screen-reader testing |
| 10 | [10](./10/README.md) Human-recorded Telugu audio for every IVR prompt |
| 11 | [11](./11/README.md) Telecom or aggregator agreement for missed-call and IVR |
| 12 | [12](./12/README.md) PWA-lite measured on 2G-class connection and low-end device |
| 13 | [13](./13/README.md) DPDP notices and consent artefacts approved by counsel; DPO and grievance contact appointed |
| 14 | [14](./14/README.md) Retention schedule, erasure, CERT-In procedure, disclosure policy, bug bounty |
| 15 | [15](./15/README.md) IT Act s.79 intermediary duties, takedown and appeals; defamation handling |
| 16 | [16](./16/README.md) MCC and survey-publication rules checked for the election calendar |
| 17 | [17](./17/README.md) IVR personal-PIN step built |
| 18 | [18](./18/README.md) Cost model for SMS/IVR/data published; who pays decided |

Conditional row A-1 (assisted participation going live, status NOT DONE) is described in [assisted](./assisted/README.md). It is outside the 18 rows above and is not read by `gate:status`.

Plan: [owner roles, order of work and dependencies](./OWNERS_AND_SCHEDULE.md) (draft; owners and dates are still the owner's to set).

Commissioning pack: [fill-in sheet and ready-to-send briefs](./COMMISSIONING_PACK.md) (draft, nothing sent).

## Draft pilot-only gate profile (off by default)

`docs/gate/pilot-profile.json` defines a smaller gate for a CLOSED PILOT: 12 rows stay required (1 to 7 and 13 to 17) and 6 are deferred while stated conditions hold (8, 9, 10, 11, 12, 18). Both approvers, one independent, are still required. It is a DRAFT for the owner and counsel and is not approved.

* **Off by default.** `"enabled": false` means nothing changes: `npm run gate:status` shows the full 18-row gate. Set `"enabled": true` to make the pilot profile the default report, or look at it without enabling it with `npm run gate:status -- --profile pilot` (and `-- --profile full` to force the full gate).
* **Not a launch gate.** The limits listed in the file (at most 3 mandals, invited users only, no IVR or missed-call, no resident notifications, assisted participation off, no results shown before the skew report, counsel memo on the election calendar, named funder) are what make the deferrals valid. Nothing in code enforces those limits; the approvers must confirm them.
* **Checked by automated tests on fake data:** `tests/gate/gate-status.test.ts` builds throw-away repositories with fake owners, evidence and approvers to prove the pilot gate can pass while the full gate still blocks, that placeholders never count, that a deferred row with a ticked box is judged like any other, and that asking for the pilot profile without the file is an error.
