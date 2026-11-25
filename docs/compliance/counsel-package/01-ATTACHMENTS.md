# Attachment list and honest status of each (read before sending)

Everything is copied unchanged from the repository on the date of this package. Remove any file you do not want counsel to see.

| File | What it is | Status as written in the file |
|---|---|---|
| `../COUNSEL_ENGAGEMENT_BRIEF.md` (fill the blanks first) | Facts, ordered questions, selection criteria, grievance officer steps | Draft; fields marked `____` still empty: entity name and type, funder, timeline |
| `attachments/COUNSEL_PACK.md` | The actual numbered questions, each legal statement marked [VERIFY WITH COUNSEL] | Draft by engineering, not a lawyer |
| `attachments/ARTEFACT_TEXT.md` | Exact English and Telugu text of every user-facing notice and consent | Draft; Telugu is machine-assisted, not reviewed by a linguist |
| `attachments/artefacts.json` | Index of the artefacts and their versions | Machine index |
| `attachments/RETENTION.md` | Proposed retention periods and deletion triggers | Draft; rows marked [VERIFY] |
| `attachments/BREACH_RUNBOOK.md` | Breach notification runbook | Draft; timelines are placeholders to confirm |
| `attachments/INCIDENT_AND_VDP.md` | CERT-In, disclosure and bug-bounty procedure | Draft |
| `attachments/GRIEVANCE_OFFICER_ROLE.md` | Role description and checklist | Draft; nobody appointed |
| `attachments/THREAT_MODEL.md` | What the code does today and what is only planned | Draft; not yet red-teamed |
| `attachments/DESIGN_2028_sections_3.1_3.8-3.10.md` | Identity and trust tiers, threat model, inclusion, compliance checklist | Design document extract |

## Known weaknesses to tell counsel, so the package does not overstate

* No real vendor is contracted (SMS, number intelligence, key management); everything is verified against simulators.
* No grievance officer or DPO exists; `grievance@example.invalid` is a placeholder.
* No notice text, English or Telugu, has been reviewed by anyone qualified.
* Legal statements in the drafts are from memory or public pages and are unverified, except the CERT-In directions of 28 April 2022.

## Before you send: checklist

- [ ] Fill every `____` in `../COUNSEL_ENGAGEMENT_BRIEF.md` and in `00-COVER-EMAIL.md`
- [ ] Choose counsel and check their conflict statement is requested (it is in the cover email)
- [ ] Decide which email address the entity sends from
- [ ] Attach the files above, as a single zip if the firm prefers
