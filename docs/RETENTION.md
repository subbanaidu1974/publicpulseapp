# Data retention table (DRAFT - needs counsel sign-off)

Status: **DRAFT.** Periods below are engineering proposals, not legal advice. Every row marked [VERIFY] must be confirmed against the DPDP Act 2023 and Rules, the IT Act, CERT-In directions and any sectoral rule before launch. Design basis: DESIGN_2028.md 3.8 item 7 and 3.10.

| Data | Where | Purpose | Retention (proposed) | Deletion trigger / method |
|---|---|---|---|---|
| Phone number, keyed hash | identity store | Account binding, one person one account | Life of account, plus 30 days | Account deletion or consent withdrawal; hash row deleted |
| Phone number, encrypted copy | identity store | Send OTPs and notices only | Life of account | Deleted immediately on account deletion |
| Pending household invite (phone hash only) | hh_invite | Match the invitee to the invite | 72 hours | Hash nulled on expiry, decline, report or acceptance |
| Invite record without hash (status only) | hh_invite | Abuse review of the invite flow | 90 days [VERIFY] | Scheduled purge |
| Household membership (adult) | hh_member | Roster | While a member | Member leaves, is removed, or account deleted |
| Member PIN credential (keyed hash) | hh_pin | Shared-phone personal PIN | Life of account | Account deletion |
| Minor dependent (year of birth + relation, no name) | hh_member | Household count | Until the child turns 18 | `eraseDependentsAt18` job (runs daily); earlier if head removes |
| Parental consent record | core consent table | Evidence of consent | 3 years after the dependent is erased [VERIFY] | Scheduled purge; the record holds no child identity |
| Consent records (signup, household invite) | core consent table | Evidence of consent and notice version | Life of account plus 3 years [VERIFY] | Scheduled purge |
| Declared residence (village) | identity/geo | Eligibility and strata | Life of account; survey-linked copies deleted N days after survey close | Account deletion; survey close job |
| Survey responses | response store | Aggregated publication | Per survey rules (no person IDs) | Erasure reaches `has_responded` and redacts the audit log |
| Issue reports | issues store | Civic issue tracking | Public record; reporter link removed on account deletion | Reporter pseudonymised |
| Audit log | core | Integrity and accountability | 7 years [VERIFY] | Entries redacted (not removed) to keep the hash chain; no phone, PIN or answers are ever logged |
| Security/OTP logs | infra | Fraud and incident response | 180 days [VERIFY CERT-In log rule] | Rolling deletion |
| Grievance tickets | ops | Handle complaints | 3 years after closure [VERIFY] | Scheduled purge |

Rules: no Aadhaar is stored; consent withdrawal triggers the same deletion path as account deletion; processors (SMS/WhatsApp vendors) must delete on the same schedule under contract [VERIFY].
