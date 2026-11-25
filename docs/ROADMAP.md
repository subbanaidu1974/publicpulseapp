# Roadmap and gap list (written 2026-11-25)

Source of truth for status is `docs/stories/tracker.json` (`npm run tracker`). This page explains the gaps and the order. Every story below has an id in the tracker.

## Where things stand

162 stories were done before this roadmap, 14 of them narrowed to "what is built". The release gate is **0 of 18** rows signed. Everything the code can do without outside people is built and tested against simulators. What is left is almost entirely people, vendors and paperwork.

## Built in this round (code, tests, docs)

| Story | What | Tests |
|---|---|---|
| S-165 | Email sign-up, sign-in and PIN recovery for people with no phone; `email_only` accounts report issues but cannot take surveys | E2E-189, E2E-190 |
| S-166 | Demo personas: 14 ready-made accounts (admin, officer, moderator, volunteer, residents...) with no registration; dev only | E2E-191, E2E-192 |
| S-167 | Add a phone to an email-only account, the path to survey eligibility | E2E-193, E2E-194 |
| S-168 | Role matrix: which role can reach which gated route, across all personas | E2E-195 |

## Gaps that remain, grouped, with the story that closes each

| Gap | Why it matters | Story | Needs |
|---|---|---|---|
| No operating entity | Every contract, registration, letter and appointment is in its name | S-169 | Owner, counsel, accountant |
| No counsel review of notices, takedown, MCC, breach | Gate rows 13 to 16 | S-170 | Counsel |
| No grievance officer or DPO; placeholder contact | Required before collecting personal data | S-171 | A named person |
| SMS never run on a real gateway or handset | Sign-up codes and phone upgrade depend on it | S-172 | Entity, gateway, DLT |
| No real number-intelligence source | Recycled and young numbers cannot be weighed | S-173 | Vendor, DPA |
| No real key service run or drill | Keys are the root of trust | S-174 | Entity, cloud account |
| No real mail vendor | Email accounts and officer confirmation cannot go live | S-179 | Vendor, sending domain |
| Telugu audio is machine drafts | IVR must stay off | S-175 | Linguist, speakers |
| Telugu screens and portfolios unreviewed | Includes the new email and demo screens | S-183 | Native reviewer |
| No polling-station data | Feature built, empty | S-176 | CEO reply |
| No ADR consent | Affidavit figures cannot be shown | S-177 | ADR reply |
| Officer onboarding never run with real people | Domain list is a guess until offices answer | S-178 | Entity, offices, mail |
| Release gate unsigned, owners are placeholders | Release is BLOCKED | S-180 | Named approvers |
| No independent crypto review or red-team | Gate rows | S-181 | Reviewers |
| No pilot run | Nothing is proven with real residents | S-182 | All of the above, or the pilot profile |
| No email notifications for email-only accounts | They get no updates by any channel | S-184 | Design, S-179, counsel |

## Order

1. **Now (done):** S-165 to S-168, so the product can be used and tested by every kind of person without registering and without a phone.
2. **Unlock everything:** S-169 entity, then in parallel S-170 counsel and S-171 grievance officer.
3. **Providers, in the entity's name:** S-179 mail, S-172 SMS, S-174 keys, S-173 number intelligence.
4. **Real-world data and outreach:** S-176, S-177, S-178, S-183.
5. **Proof:** S-181 review and red-team, S-180 gate sign-off, S-182 pilot.
6. **Later:** S-175 recordings (only when IVR is switched on), S-184 email notifications.

## How the demo personas help the plan

With `CIVIC_DEMO_PERSONAS=1` anyone can click through the admin, officer, moderator, volunteer and resident views without registering (`docs/DEMO_PERSONAS.md`). Use it for walkthroughs with counsel, the host institution and the independent reviewers, and for user-acceptance testing. It is refused in production by the start-up guard.

## Rules this roadmap keeps

* A story is "done" only for what is built and tested. Blocked stories say who they wait for.
* Placeholders (`PLACEHOLDER-*`, `grievance@example.invalid`) never count as real owners, dates or contacts.
* Nothing in a send-ready package has been sent.
* Simulator-verified is not the same as verified against a real service; the notes say which is which.
