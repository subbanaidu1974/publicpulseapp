# Counsel engagement brief and grievance officer appointment steps (S-150) - DRAFT

Status: DRAFT, ready for the owner to fill in and send. It is not legal advice, names no lawyer or fee, and nothing in it has been sent. Fill the `____` fields. It sits on top of `COUNSEL_PACK.md`, which holds the actual questions.

## 1. Facts to give counsel (as decided so far)

| Fact | Value |
|---|---|
| What the platform is | A civic participation platform for Andhra Pradesh and Telangana: verified residents report local issues and, later, answer surveys with an anonymous one-time credential. Detail: `docs/DESIGN_2028.md`, `docs/THREAT_MODEL.md` |
| Operator (owner decision 2026-11-24) | An independent non-profit, section 8 company or registered trust (counsel and a chartered accountant to advise which), with a university or civil-society partner hosting the pilot. Entity name and type: ____ |
| Pilot funding (owner decision 2026-11-24) | Owner or one named grant, disclosed; no say over survey topics, wording or publication. Funder: ____ |
| Pilot scope | At most 3 mandals, invited users, SMS and web only; no IVR or missed-call, no resident notifications, assisted participation off (see `docs/gate/pilot-profile.json`, a draft) |
| Personal data held | Phone number as a keyed hash plus an encrypted copy, residence, household membership, issue reports with optional voice, photo and location, officer applications (name, work email, letter) |
| Build status | Software built and tested on simulators; no real vendor yet; no production deployment |

## 2. What to ask counsel for (written answers, in this order)

1. **Structure** (`COUNSEL_PACK.md` and `docs/decisions/01-operator-options.md` section 4, questions 7 to 11): trust or section 8 company; Data Fiduciary and Significant Data Fiduciary status; RTI public-authority status; tax, registration and FCRA; trustee or director liability; enforceable asset lock and funding cap.
2. **DPDP Act and Rules** (section b of the pack): notices, consent, children, rights requests within the statutory time, breach notice, retention; approve or correct the exact English and Telugu text in `ARTEFACT_TEXT.md`.
3. **IT Act section 79 and defamation** (section c): intermediary duties, takedown and appeal route, reports naming individuals. Gate row 15.
4. **Model Code of Conduct and survey-publication rules** (section d): for the pilot dates and any publication plan. Gate row 16.
5. **Breach, CERT-In and disclosure** (section e): the procedure in `docs/BREACH_RUNBOOK.md` and `docs/compliance/INCIDENT_AND_VDP.md`; who holds the CERT-In point of contact. Gate row 14.
6. **Grievance officer and DPO** (section f): qualifications, independence, where published.

Ask for: a memo with a clear answer or "cannot say" per question, edits to the artefact text, a list of anything that must be done before a pilot starts versus before a public launch, and counsel's name, firm, bar details and date for the evidence folder.

## 3. Selecting counsel (suggested; yours to decide)

* Experience in Indian data protection and technology or intermediary law, and election law for item 4. One firm may cover both, or two may be engaged.
* No client or personal link to a political party, a candidate, or the state governments concerned. Ask for a one-line conflict statement.
* Fixed scope and fee, written deliverables, and a start-to-memo timeline of ____ weeks.
* Willing to review Telugu text with a native-speaker colleague, or to accept a separate native review.

## 4. Grievance officer and DPO: how to appoint

The role description and checklist are in `GRIEVANCE_OFFICER_ROLE.md`. Steps for the owner:

1. Pick a named person at the operating entity, independent of the engineering team and of any funder or party, who can answer in Telugu and English.
2. Give them a monitored mailbox on the entity's own domain (not a personal address) and a phone number or postal address as counsel advises.
3. Counsel confirms the appointment and the published wording.
4. Replace the placeholder `grievance@example.invalid` everywhere it appears (listed by `grep`; the main files are `server/civic/households/notices/grievance_officer.json`, `docs/compliance/ARTEFACT_TEXT.md`, `docs/gate/13/README.md`). Tell me the real contact and I will change it and re-run the checks.
5. Test the route once: send a complaint to the mailbox and confirm a named person replies within the time counsel sets.

## 5. Order and timing (suggested)

Week 0 fill sections 1 and the fee fields, choose counsel. Week 1 send this brief with `COUNSEL_PACK.md`, `ARTEFACT_TEXT.md`, `artefacts.json`, `docs/RETENTION.md`, `docs/BREACH_RUNBOOK.md`, `docs/THREAT_MODEL.md`. Weeks 2 to 4 counsel works; the owner appoints the grievance officer meanwhile. Then fix text, replace the placeholder contact, attach evidence under `docs/gate/13` to `16`.

## 6. What this brief does not do

It does not choose or instruct a lawyer, appoint anyone, or reach any legal conclusion. S-150 stays blocked until counsel has answered and a real grievance officer or DPO is appointed.
