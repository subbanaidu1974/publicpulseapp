# Release gate checklist (E2E-58, manual evidence)

**E2E-58 is a manual-evidence checklist. It is tracked here and in `docs/stories/tracker.json` but is deliberately NOT automated.** No election-adjacent survey may go live until every item below has an owner, a date and an attached artefact. Items are unchecked until real evidence exists; this repository contains none of the evidence yet.

Scope: DESIGN_2028 section 3.8 item 8, section 3.9 (pilot first), section 3.10 (compliance, all **[VERIFY]** with counsel).

| # | Gate | Evidence to attach | Owner | Date | Done |
|---|---|---|---|---|---|
| 1 | Threat model reviewed against the current build (`docs/THREAT_MODEL.md`) | Reviewed copy with reviewer name and commit hash | | | [ ] |
| 2 | Independent red-team and penetration test report | Report from a party independent of the builders; all critical and high findings fixed or formally accepted | | | [ ] |
| 3 | Pilot skew report (2-3 mandals): response by gender, age, phone ownership | Published report with method | | | [ ] |
| 4 | Keys in HSM/KMS with per-purpose keys, rotation and dual-control break-glass | Configuration evidence and drill record | | | [ ] |
| 5 | Identity, issue and survey data in separate stores with no cross-store joins | Architecture diagram and schema check | | | [ ] |
| 6 | Audit log head anchored externally with independent witnesses | Witness agreements and anchor samples | | | [ ] |
| 7 | OTP-send budget, per-ASN/device caps and degraded mode load-tested (E2E-56) | Load test results | | | [ ] |
| 8 | Sender security (FIDO2, signed payloads, anti-phish word, kill-switch), if notifications are in scope | Test record | | | [ ] |
| 9 | WCAG 2.2 AA audit including Telugu screen-reader testing with people with disabilities (E2E-57 automated checks are necessary, not sufficient) | Audit report | | | [ ] |
| 10 | Human-recorded Telugu audio for every IVR prompt (coastal, Rayalaseema, Telangana variants); placeholders replaced | Signed-off `data/civic/audio-manifest.json` with `status` changed from `placeholder` | | | [ ] |
| 11 | Telecom or aggregator agreement for missed-call and IVR in the pilot state | Executed agreement; TRAI/DLT registrations | | | [ ] |
| 12 | PWA-lite measured on 2G-class connection and low-end device | Measurement log (automated size budget is in `tests/civic/channels.size.test.ts`) | | | [ ] |
| 13 | DPDP notices and consent artefacts approved by counsel; Data Fiduciary assessment; DPO and grievance contact appointed | Counsel sign-off; real grievance officer replacing the placeholder | | | [ ] |
| 14 | Retention schedule, erasure (including audit-log redaction), CERT-In incident reporting procedure, disclosure policy and bug bounty | Policies and a tested erasure run | | | [ ] |
| 15 | IT Act s.79 intermediary duties, takedown and appeals; defamation handling for reports naming individuals | Process documents | | | [ ] |
| 16 | MCC and survey-publication rules checked for the election calendar | Counsel memo | | | [ ] |
| 17 | IVR personal-PIN step built (shared SIMs currently refused) | Test record | | | [ ] |
| 18 | Cost model for SMS/IVR/data published; who pays decided | Published model | | | [ ] |

## Sign-off

Release is blocked until all rows are checked and two named approvers (one of them not on the build team) sign below.

- Approver 1: ____________  Date: ______
- Approver 2 (independent): ____________  Date: ______
