# Personal data breach notification runbook (DRAFT - needs counsel sign-off)

Status: **DRAFT.** The timelines and recipients below are placeholders from memory. Counsel must confirm duties under the DPDP Act 2023 and Rules (notice to the Data Protection Board and to affected Data Principals), CERT-In directions (reporting of incidents, currently understood as within 6 hours [VERIFY]), and any contractual duties. Nothing here is legal advice.

## Roles
- Incident commander (IC): on-call engineer lead. Compliance officer / Grievance Officer: decides on notification with counsel. Communications lead: drafts user and public notices. Scribe: keeps a timestamped log.
- Contacts are filled in by the operator: IC ____, Compliance ____, Counsel ____, CERT-In reporting address ____, DPB contact ____.

## 1. Detect and triage (target: first 30 minutes)
1. Open an incident channel and a private log. Record who found it, when, and how.
2. Classify: confidentiality (data read by someone unauthorised), integrity (data altered), availability. Note which store: identity, households, issues, responses, audit log.
3. Severity: SEV1 = identity data or any response contents exposed, or keys suspected compromised; SEV2 = limited exposure of pseudonymous data; SEV3 = no personal data.

## 2. Contain
- Revoke affected sessions and credentials; rotate keys per purpose (hmac, encrypt, signing) via the KMS/HSM; disable the affected provider adapter.
- Preserve evidence: snapshot logs and the audit-log head hash before changes. Do not delete anything.
- If the audit log chain is suspect, compare against the externally anchored head.

## 3. Assess
- What data, how many people, which fields (phone hash, encrypted phone, village, household links, dependent year of birth, consent records). Households and dependents: note that adult members' answers are never visible to heads and that dependents hold no name.
- Can the data be re-identified? A leaked phone hash plus a leaked key is brute-forceable (DESIGN_2028 3.1).
- Decide notifiable status with counsel.

## 4. Notify (timelines to be confirmed [VERIFY])
| Who | When | Content | Owner |
|---|---|---|---|
| CERT-In | Within the period counsel confirms (placeholder: 6 hours of becoming aware) | Incident type, systems, indicators | IC |
| Data Protection Board of India | Per the DPDP Rules (placeholder: without delay, then detailed report within 72 hours) | Nature, extent, timing, likely impact, mitigation | Compliance |
| Affected Data Principals | Without delay when notifiable | Plain-language Telugu and English: what happened, what data, what we did, what you can do, grievance contact | Comms |
| Processors / vendors (SMS, cloud) | Immediately | Request logs, containment | IC |
| Public disclosure | After counsel review | Same as users, no personal data | Comms |

Never ask users for OTPs, PINs or links to log in in a breach message; use the in-app notice and the pre-registered SMS sender with the user's anti-phish word.

## 5. Recover and review
- Restore from clean state, re-verify audit log integrity, monitor for reuse of leaked data.
- Blameless post-mortem within 7 days: root cause, timeline, what detection missed, actions with owners. Publish a redacted version per the disclosure policy.
- Update the threat model and retention table if the cause was over-retention.

## 6. Drills
Table-top exercise before pilot launch and every 6 months; at least one drill covers a key-compromise scenario and a household-data scenario.
