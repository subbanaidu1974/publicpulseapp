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
