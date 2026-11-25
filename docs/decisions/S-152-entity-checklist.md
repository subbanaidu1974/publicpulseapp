# Entity formation checklist (follow-on to S-152) - DRAFT

Status: DRAFT for the owner. Not legal or tax advice, and nothing here has been done, filed or sent. It turns the owner's 2026-11-24 decision (independent non-profit, section 8 company or trust, with a university or civil-society partner hosting the pilot; pilot self-funded or one named grant, disclosed) into steps and names what each later piece of work waits for. Counsel and a chartered accountant must confirm every step; the form (section 8 company or registered trust) is theirs to recommend.

Tick a box only when the evidence named in the third column exists. Mark each step with who does it and the date, as in `docs/gate/OWNERS_AND_SCHEDULE.md`; leave `PLACEHOLDER-*` until a real person is named.

## 1. Decide before filing (owner)

| Done | Step | Evidence to keep |
|---|---|---|
| [ ] | Entity name, and a check that it does not imply government or party links | One-line name decision with date |
| [ ] | Founding board: at least 3 people, none a party office-bearer or serving officer, no funder seat. Record each person's declared party or government links | Signed declarations, one per person |
| [ ] | Who appoints the independent wording panel (`docs/DESIGN_2028.md` 8.2) | Appointment rule, written |
| [ ] | Funder for the pilot: self-funded, or one named grant. Funder gets no say over survey topics, wording or publication | Funding letter or statement, and the disclosure text |
| [ ] | Exit plan: who inherits or deletes data and keys if the entity closes | One-page statement approved by the board |
| [ ] | Pilot host (university or civil-society body) and who signs for it | Name and signatory |

## 2. Engage advisers (owner)

| Done | Step | Evidence |
|---|---|---|
| [ ] | Engage counsel and a chartered accountant using `docs/compliance/COUNSEL_ENGAGEMENT_BRIEF.md` | Engagement letters; conflict statements |
| [ ] | Ask them for a written recommendation, section 8 company or trust, covering Data Fiduciary and Significant Data Fiduciary status, RTI public-authority status, tax and registration, FCRA if any foreign money is contemplated, director or trustee liability, and enforceable asset lock and funding cap (questions 7 to 11 in `01-operator-options.md`) | Memo |

## 3. Form the entity (counsel and accountant lead; the exact steps depend on the form chosen)

| Done | Step | Evidence |
|---|---|---|
| [ ] | Constitutional documents drafted with the asset lock, funding cap and disclosure rule, the no-party-office-bearer board rule, and a clause that survey wording and publication are not for sale | Draft approved by counsel |
| [ ] | Registration filed and completed | Certificate of incorporation or trust deed with registration details |
| [ ] | PAN, bank account and (if applicable) GST registration | Account opened in the entity's name; PAN and GST numbers on file |
| [ ] | Tax-exemption and donation-eligibility steps if counsel advises them | Counsel's note and any certificates |

## 4. Make the entity operate (board)

| Done | Step | Evidence |
|---|---|---|
| [ ] | Written pilot agreement with the host: roles, data handling, who answers complaints, audit-log witness, exit | Signed agreement |
| [ ] | Appoint named people with independent roles: grievance officer or DPO, CERT-In point of contact, and two independent break-glass key custodians | Appointment letters; replace `grievance@example.invalid` and tell me the real contact |
| [ ] | Name the two release-gate approvers (one independent of the build team) and a real owner and date for each of the 18 gate rows | Names and dates; I will fill `docs/RELEASE_GATE.md` and re-run `npm run gate:status` |
| [ ] | Publish the entity name, board and funding disclosure on the site and in the notices (gap G3 in the counsel pack) | Published page; counsel-approved notice text |

## 5. What this unlocks, in order

| Once this exists | These can start |
|---|---|
| Entity registration papers and bank account | DLT registration and an SMS gateway contract (S-63); cloud account under the entity (S-64) |
| Entity name, signatory and letterhead | The polling-station request letters (S-91); the affidavit consent request (`affidavit-consent-request-draft.md`); the officer-onboarding letters (S-141) |
| Board, appointed roles and advisers | Counsel review of the notices and grievance officer appointment (S-150); gate rows 13 to 16 |
| Funding decision | Pilot budget in `docs/decisions/cost-model.md`; gate row 18 |
| Named gate owners and approvers | Gate sign-off work (S-153); optional switch to the pilot-only profile (`docs/gate/pilot-profile.json`, `enabled:true`) |
| Real vendors and entity-held contracts | Number-intelligence trial (S-62); independent crypto review and red-team scope (S-48) |

## 6. Open questions that block the next step

1. What name, and who are the first board members? Any party or government link among them?
2. Which pilot host, and who signs?
3. Who will you engage as counsel and as the chartered accountant?
4. Who are the grievance officer, CERT-In contact, key custodians and the two gate approvers?

## 7. What this checklist does not do

It does not form the entity, choose a lawyer, name a person or fix a date. S-152 stays done as a design decision; this checklist is the work that follows it.
