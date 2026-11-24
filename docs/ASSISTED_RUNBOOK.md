# Assisted participation: operator runbook

Status: **DRAFT.** Written against `server/civic/assisted/` as it stands on this branch (config, store, service, switch, routes). It documents what exists. Where a control is only a procedure (a person does it, nothing alerts), that is said. Design and limits: `docs/ASSISTED_PARTICIPATION.md`. People side: `docs/ASSISTED_HANDBOOK.md`. Incidents: `docs/BREACH_RUNBOOK.md`.

Owners, dates and ticks in the go-live checklist (section 9) are human decisions and are left blank on purpose.

## 1. Facts to know

- The feature is **off by default**. Every route under `/api/v1/civic/assisted` answers `404 {"code":"assisted_disabled"}` unless all three hold: `ASSISTED_ENABLED=1`, a valid future-or-today `ASSISTED_SUNSET_DATE`, and the kill switch is not engaged. (The kill-switch routes `/switch...` stay reachable while the switch is engaged, so it can be lifted.)
- The record is an issue with `channel = assisted`, in the **issues store**. It carries a pair id, a village and the HMAC of the paper receipt code. It holds **no name, phone or other identifier of the assisted person**; the API refuses such fields.
- Roles: `volunteer` (the pair), `assist_coordinator` (forms pairs), `assist_reviewer` (re-checks, suspends), `admin` (suspends, runs the kill switch under dual control with TOTP). Coordinator and reviewer grants can be scoped to an area.
- Everything is audited: pair create and suspend, record, held record, re-check, receipt delete, receipt flag, switch request and decision, self-approval attempts.
- Assisted records are kept out of survey tooling and rankings by design (see the design note, sections 5 and 7). Verify with the tests before each release (section 10).

## 2. Enable

Prerequisites: every go-live checklist item (section 9) is done and signed. Do not skip to the env change.

1. Choose the sunset date. It is the **last UTC day the feature runs**; it switches off by itself at the end of that day. Pick a date that forces a review (the design suggests the pilot period plus a margin). Renewal means a person changes the date after reading the evaluation, nothing renews it automatically.
2. Set in the environment (the other agent maintains `.env.example`; values below are defaults, read on every call, no restart needed for tuning):

| Variable | Default | Meaning |
|---|---|---|
| `ASSISTED_ENABLED` | `0` | `1` turns the feature on. Anything else is off |
| `ASSISTED_SUNSET_DATE` | none | `YYYY-MM-DD`. Missing or malformed keeps the feature **off** |
| `ASSISTED_PAIR_DAILY_CAP` | 15 | Records per pair in any rolling 24 hours |
| `ASSISTED_VILLAGE_DAILY_CAP` | 40 | Assisted records per village in any rolling 24 hours |
| `ASSISTED_RECHECK_SAMPLE` | 0.2 | Random share re-checked once a pair is past its first records |
| `ASSISTED_RECHECK_NEW_PAIR_N` | 10 | First N records of a new pair are all re-checked |
| `ASSISTED_RECHECK_DAYS` | 7 | Days allowed for a re-check |
| `ASSISTED_SUSPEND_THRESHOLD` | 0.25 | Auto-suspend when not-confirmed share of checked records is strictly above this |
| `ASSISTED_SUSPEND_MIN_CHECKED` | 5 | Minimum checked records before auto-suspend can fire |
| `ASSISTED_RATE_PER_MIN` | 20 | Per-assistant requests per minute |
| `ASSISTED_RECEIPT_ATTEMPTS_PER_HOUR` | 30 | Receipt look-ups per address per hour (a global ceiling of 40 times this also applies) |

3. Restart or redeploy as your process requires, then check `GET /api/v1/civic/assisted/switch` (admin, signed in): `enabled: true`, `reason: ok`, the expected `sunset_date`, `kill_switch_engaged: false`.
4. Create the first pair (coordinator): two enrolled volunteers, in one village, neither the coordinator. Do a supervised dry run with the real device, in Telugu, before any member of the public.
5. Tell the reviewers the start date. The first 10 records of every new pair are all queued for re-check.

Notes:

- Not built in the current code: the design's per-person monthly cap of 3 records (no person identifier is stored, so it cannot be enforced by the system; the pair and village daily caps are the only volume limits). Treat the monthly limit as a handbook rule and a reviewer check.
- Tuning values are clamped to the ranges in `config.ts`; a typo falls back to the default, so confirm effective values after any change.

## 3. Kill switch (dual control)

Use it to stop all assisted participation immediately: no new records, and the public segment disappears (the segment is hidden whenever the feature is not on). Existing data is **not** deleted.

1. **Admin A** (signed in, TOTP) files `POST /switch/requests` with `{"action":"disable","reason":"..."}`. A reason of 5 to 300 characters is required. State why, in a sentence, and no personal data.
2. **Admin B**, a **different** admin, signed in with their own TOTP, approves `POST /switch/requests/:id/approve`. Self-approval is refused (403 `dual_control`) and audited. Requests lapse after **72 hours**.
3. Check `GET /switch`: `kill_switch_engaged: true`, `reason: kill_switch`.
4. To lift it: the same two-person process with `"action":"enable"`. The latest approved request decides the state. If the sunset date has passed, lifting the switch does not turn the feature on: change the date (a deliberate act) first.
5. If the switch table cannot be read, the system fails closed (treated as engaged).

When to use it: a confirmed fabrication pattern across pairs, coercion by a party or group, a data exposure involving assisted records, a legal instruction, or a coordinated attack on the receipt endpoint. A single bad pair is a pair suspension (section 6), not a kill switch.

Drill it before go-live and once each quarter: file, approve, confirm 404, lift, confirm 200, record the audit entries.

## 4. Monitoring and thresholds

What the system does for you:

- Auto-suspends a pair when not-confirmed / (confirmed + not-confirmed) is above `ASSISTED_SUSPEND_THRESHOLD` after at least `ASSISTED_SUSPEND_MIN_CHECKED` checked records. The audit row is `assisted.pair.auto_suspend`.
- Holds records that mention parties or candidates, or that the moderation lexicon flags; takes a not-confirmed record off the public list.
- Applies per-pair and per-village daily caps and per-assistant and per-address rate limits.

What the system does: `GET /assisted/alerts` (shown in the reviewer and coordinator consoles, and in `GET /assisted/switch` for admins) lists warnings for the viewer's area: a pair whose not-confirmed rate is above `ASSISTED_ALERT_UNCONFIRMED_RATE` (default 25%) after `ASSISTED_ALERT_MIN_CHECKED` (default 5) checked records, and an area (village or mandal) where assisted reports are more than `ASSISTED_ALERT_SHARE` (default 30%) of its reports over `ASSISTED_ALERT_DAYS` (default 7), with at least `ASSISTED_ALERT_MIN_ISSUES` reports. Warnings only inform; they push no notification and take no action. What the system does **not** do: page or notify anyone, so a named person still looks at them on a schedule and writes down what they saw. Per pair, `GET /pairs` shows records, queued, confirmed, not-confirmed, unreachable and the not-confirmed rate.

Thresholds are to be **set from the pilot, not guessed** (design note section 8). Until then, these starting watch levels are placeholders to be confirmed by the owner:

| Signal | How to read it | Placeholder watch level | Owner / date |
|---|---|---|---|
| Not-confirmed rate (per pair, per mandal) | `GET /pairs`; audit | any auto-suspension; mandal rate above ____ | ____ |
| Unreachable share | `GET /pairs` | above ____ of checked + unreachable, since a pair whose people cannot be found is a warning too | ____ |
| Re-check backlog and overdue | `GET /rechecks` (`overdue`, `due_by`) | any item overdue by more than ____ days | ____ |
| Assisted share of all issues in an area | issues counts by `channel` | above ____ in a mandal | ____ |
| Pair volume spike | records per pair per day | a pair at its daily cap on consecutive days | ____ |
| Held-for-topic records | `assisted.record_held` audit rows with `party_or_candidate_topic` | more than ____ per pair per week | ____ |
| Receipt flags ("wrong or pushed") | `assisted.flagged` audit rows | any; two on one pair is an escalation | ____ |
| Receipt endpoint abuse | 429 rate on `/receipts/*` | sustained 429s from one address range | ____ |
| Skew by group (faction capture) | aggregate by mandal and pair composition | reviewed monthly | ____ |

Review the table weekly during the first month, then monthly. Publish in aggregate only.

## 5. Handling an unconfirmed-rate alert

Whether it came from an auto-suspension or from your own watching:

1. **Do not tell the pair or the village who was checked.** Note the time and the pair id.
2. Check the facts: `GET /pairs` for the pair, the number checked (a small number can swing), the reviewers' notes and the dates. Confirm that reviewers followed the neutral script and were independent (not from the same group or village as the pair; see handbook B5).
3. If the pair is not suspended already, suspend it now (section 6). Suspension is immediate and audited. A coordinator in scope lifts a manual suspension (`POST /pairs/:id/reinstate`, reason required); an automatic suspension needs two admins, each with TOTP (`POST /pairs/:id/reinstate-request`, then a different admin approves under `/switch/requests/:id/approve`). The pair then starts with a fresh re-check count. Form a new pair instead if the review finds the members should not continue together.
4. Look sideways: are other pairs in the same village, mandal or under the same coordinator rising? Is the same text or the same category showing up? Is the sample too thin?
5. Re-check **all** remaining records of the pair (the system already samples a pair with a not-confirmed record at 100%); give the reviewers more time if needed.
6. Decide, and record: **explained** (for example, a reviewer error or an old reachability problem), **pair error** (retrain, reform), or **misuse** (end the volunteer's role, escalate, tell counsel; if it looks like deliberate fabrication or coercion, go to section 8).
7. The design requires a district to be suspended or the feature switched off if the unconfirmed-rate or assisted-share alert fires and is **not explained within 14 days**. Put the 14-day date in the log when you open it.
8. Write a short note in the programme log. No personal data.

## 6. Suspending a pair or a district

**A pair** (immediate, by a coordinator or reviewer whose grant reaches the village, or an admin): `POST /pairs/:id/suspend` with `{"reason": "..."}` (5 to 300 characters). The pair's members can no longer record (`pair_suspended`). Their earlier records stay, and their queued re-checks remain. Tell the members that suspension is a protection step, not a finding.

**A district or mandal** has no single switch. Do one of:
- suspend every active pair in the area (list with `GET /pairs`, suspend each); or
- engage the kill switch for the whole feature (section 3), if the problem is not confined to the area.

Stop forming new pairs in the area (a coordinator decision; instruct them) until the review is done. Record the decision, the reason and who decided.

## 7. Deletion requests

- **By receipt:** the person (or someone they trust, with the paper, in their presence) can delete directly on the public receipt page. It erases the words, GPS and media references, writes a stub row (so counts and the audit trail add up) and leaves the audit entry `assisted.delete` with the pair id. It is idempotent. Nothing for the operator to do beyond confirming that the page works.
- **By someone without a code:** a coordinator or reviewer in scope, with the person present, picks the record from the pair's record list (`GET /pairs/:id/records`, an audited read) and files a deletion request with a reason (`POST /delete-requests`). Nothing is deleted until a different coordinator, reviewer or admin in scope approves it (`POST /delete-requests/:id/approve`); a pair member can neither file nor decide, and requests lapse after 72 hours. Do not try to find a record by village, category or time without the person. **[VERIFY with counsel.]**
- **Erasure and retention:** the stub keeps the village, category, pair id and times. Content, media references and location are removed. Backups keep earlier copies until they rotate out (`docs/RETENTION.md`). Confirm the erasure run on production-like data (gate row 14).
- **Wrong deletion by an assistant:** a deletion made without the person is misuse. Report it (section 8).

## 8. Incident steps

Use these for fabrication, coercion, capture, data exposure, or an attack:

1. **Stop the harm:** suspend the pair (section 6), or engage the kill switch (section 3) if wide.
2. **Preserve:** note the audit head hash and the time before any change; do not delete records or audit rows.
3. **Triage** with `docs/BREACH_RUNBOOK.md`: it applies if any personal data may have been exposed, such as receipt hashes with the key, operator access misuse, or assisted text that names or identifies someone. Assisted records are designed to hold no personal identifier of the adult, but the free text can contain one, so check.
4. **Classify:**
   - fabrication or coercion by a pair: misuse process with the programme and counsel;
   - leaked or guessable receipt codes: rate-limit data (section 4), and consider the kill switch while investigating; the code space is 32^12, and look-ups are rate-limited per address;
   - insider or admin misuse: access review of admin actions in the audit chain, rotate affected roles;
   - public misrepresentation of assisted counts as organic: correct publicly, and check the API still marks every item `channel: assisted`.
5. **Notify** per the breach runbook (counsel decides) and the grievance contact.
6. **Review:** write a short post-incident note, update the handbook and this runbook, and add or adjust a red-team case in `docs/RED_TEAM_SCOPE.md`.

## 9. Go-live checklist (mirrors section 9 of `docs/ASSISTED_PARTICIPATION.md`)

**All blank on purpose.** A box is ticked by the named person who attached the evidence. Owners and dates are never filled in by tooling or by the builders. The mirror row in the release gate is in `docs/RELEASE_GATE.md` (conditional gate) and `docs/gate/assisted/README.md`.

| # | Item (design note section 9) | Evidence to attach | Owner | Date | Done |
|---|---|---|---|---|---|
| 1 | Pilot skew report (`docs/PILOT_SKEW_PLAN.md`) shows phone-less adults are materially under-represented without assisted participation | Published skew report with method | | | [ ] |
| 2 | Counsel signs off consent and notice wording, and the data-protection position **[VERIFY: DPDP Rules on consent, notice, data of persons who cannot read, any need for a verifiable consent manager]** | Counsel sign-off; the approved Telugu consent script, replacing the draft in `docs/ASSISTED_HANDBOOK.md` | | | [ ] |
| 3 | A grievance route for the assisted person exists that does not depend on a phone | Description of the route; named grievance officer (replaces the placeholder; gate row 13); printed slip | | | [ ] |
| 4 | At least two independent reviewers per district are named and trained | Named list per district (kept outside this repository if it holds names), training record | | | [ ] |
| 5 | The independent red-team covered this flow (`docs/RED_TEAM_SCOPE.md`, section on assisted participation) | Red-team report section, findings fixed or formally accepted | | | [ ] |
| 6 | The owner records the decision in `DESIGN_2028.md` section 8 (question 5) | The decision record, with the date | | | [ ] |

Also required by the same design note (sections 3, 7, 10, 11), to be confirmed before go-live:

| # | Item | Evidence to attach | Owner | Date | Done |
|---|---|---|---|---|---|
| 7 | Sunset date chosen and recorded; renewal process agreed | Config change record | | | [ ] |
| 8 | Kill switch drilled with two admins (file, approve, confirm 404, lift) | Drill record | | | [ ] |
| 9 | Alert thresholds set from the pilot (section 4), watchers named | Filled table | | | [ ] |
| 10 | Native-speaker review of every Telugu block in the handbook | Reviewer name and date | | | [ ] |
| 11 | Assistants trained, code of conduct signed, no per-record pay or target | Signed copies held by the programme; stipend terms if any | | | [ ] |
| 12 | Who trains, pays and is accountable for assistants and reviewers decided (design question 2) | Written decision | | | [ ] |
| 13 | Re-check sample affordable and the minimum viable sample decided (design question 4) | Cost note | | | [ ] |
| 14 | Owner accepts the reputational risk (design question 6) | Written acceptance | | | [ ] |
| 15 | The tests in section 10 pass at the release commit | CI link or log with commit hash | | | [ ] |

## 10. Verification before every release

```
npx vitest run tests/civic/assisted.test.ts
npm run check:docs
npm run gate:status
```

Confirm in the test results: two assistants required; no personal fields stored; caps; consent ticks; exclusion from surveys and rankings; receipt look-up, deletion and flag; auto-suspension; kill switch dual control; feature off by default and after the sunset date.

## 11. Open points a person must decide

- Alert thresholds (section 4): the defaults above are guesses to be set from the pilot.
- Un-suspending: built (above). Open question: whether the owner wants a manual reinstatement to need a second person as well.
- The no-code deletion route (section 7) is built with two-person approval; counsel should confirm it.
- The per-person monthly cap: only a procedure today.
- Pager and notification for alerts: none is built (warnings are shown in the consoles only).
