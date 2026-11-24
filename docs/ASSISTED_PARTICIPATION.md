# Assisted participation (S-49): design note

Status: **DRAFT for the owner's decision. Nothing is built.** Phase 3, after the pilot, and only if approved. Date: 2026-11-24. Written from `docs/DESIGN_2028.md` (sections 3.9, 5, 8, 9), `docs/THREAT_MODEL.md` and the existing volunteer enrolment code (S-136). Not legal advice; items marked **[VERIFY]** need counsel or a source check.

## 1. What it is, and what it is not

**It is:** a trained pair of local people (an SHG member plus a volunteer) helping an adult who has no phone, or cannot use one, to **report a local issue or give feedback on a consultation**, in the person's presence and with the person's consent. The record is clearly marked as assisted.

**It is not:** voting, polling, surveys, or anything that measures opinion on parties or candidates. Assisted records are **excluded from every survey, weight and published opinion figure**. This follows `DESIGN_2028.md` §3.9 and threat row H2 (voice and assisted channels are platform-linkable, so they never carry survey answers).

## 2. Why this is risky (the honest version)

Assisted participation is the part of the platform most open to coercion and fabrication, because a second person types for the first.

| Risk | What could go wrong |
|---|---|
| Fabrication | A volunteer invents "assisted" people to inflate an issue, or to push a cause. |
| Coercion and steering | A family head, local leader or volunteer decides what the person "says". |
| Capture by a party or caste group | Volunteers are recruited from one faction and the segment skews. |
| Privacy | The helper sees and remembers the person's complaint, name and village. |
| Misrepresentation | Assisted counts get quoted as if they were organic citizen counts. |
| Paid or quota-driven behaviour | Volunteers rewarded per record will produce records. |

The security reviewers in the debate wanted this dropped; the inclusion reviewers wanted it earlier. The compromise is the narrow scope below, and a **go/no-go gate after the pilot** (section 9).

## 3. Scope (hard limits)

1. **Topics:** issue reports and consultation feedback only. No surveys, no election-related content, no party or candidate topics. A report that mentions a party or candidate is held for review.
2. **Who may be assisted:** an adult (18+) with no phone of their own, or who says they cannot use one. Minors are never assisted participants.
3. **Where:** in person, at an SHG meeting, a village kiosk or a Common Service Centre. Never by phone call, never door-to-door sales style visits.
4. **Frequency:** at most 3 assisted records per person per month, at most 15 per volunteer pair per day.
5. **Sunset:** the feature carries an expiry date in config. It switches off automatically unless the owner renews it after reviewing the evaluation.

## 4. Roles

| Role | Who | Can | Cannot |
|---|---|---|---|
| Assistant pair | One SHG member plus one enrolled village volunteer | Record on behalf of a consenting adult, in the person's presence, with both of them signed in | See survey answers, see other people's assisted records, record alone |
| Reviewer | Independent of the village (mandal-level coordinator or moderator) | Re-check a sample, call the person back where a number exists, suspend a pair | Edit the content |
| Admin | Existing admins | Suspend pairs, see audit, change quotas (dual control) | See people's names in clear without a logged reason |

Pairs use the existing `volunteer` role and the household "assisted" member status already in the data model. Women assist women where possible (the SHG-leader risk row in the design).

## 5. Flow

1. **Enrolment of the pair.** Each of the two is an enrolled volunteer with identity checked by the programme (same process as T2 attestors). A pair is formed per village by a coordinator, never self-formed. Pairs and their members are logged.
2. **Consent in the room.** The assisted adult is told, in Telugu, aloud and on screen: what will be recorded, who will see it, that it is not a vote, that they can say no, and that they can ask for it to be deleted. Consent is recorded as: both assistants confirm on the device that consent was given, plus a spoken confirmation from the adult captured **only as a yes/no tick by the assistants**, not as a recording (no voice storage).
3. **Record.** The assistants enter the report using the normal issue form, with the person's words (not summarised into other words). The record gets `channel = assisted`, `pair_id`, a village code, and **no name or phone** for the adult.
4. **Receipt.** The adult is given a short code on paper (or told it) so they can ask later "what happened to my report", and can request deletion with it. The code is random and not linkable to a phone number.
5. **Review.** Each record joins a queue. A random sample (default 20%, higher for new pairs and for any pair with a flagged record) is re-checked by a reviewer within 7 days, by an independent visit or call-back to the person where reachable. Results are logged: confirmed, not confirmed, unreachable.
6. **Publication.** Assisted records appear in the issue feed **in a separate, labelled segment** ("Reported with assistance"), never merged into the organic counts or rankings.

## 6. Data model (additions)

- `issue.channel` gains the value `assisted` (the channel enum already separates app, voice, SMS).
- `assisted_record(issue_id, pair_id, village_code, consent_ticked_at_by[two ids], receipt_code_hash, recheck_state, created_at)`. **No assisted-person identifier is stored**, only the hash of the paper receipt code.
- `assist_pair(id, village_code, member_a, member_b, formed_by, status, suspended_reason)`.
- `assist_recheck(record_id, reviewer_id, outcome, at)`.
- Lives in the **issues store** with the usual pseudonymised reporter handling; the receipt hash is the only link a person can use to ask for deletion. Erasure removes the content and keeps a stub for counts (same staged-erasure rule as other issues).
- All reads and writes go to the audit log with the pair id.

## 7. Controls mapped to the risks

| Risk | Control |
|---|---|
| Fabrication | Two assistants must both be signed in; sample re-checks with call-back or visit; unconfirmed rate above a threshold suspends the pair automatically; per-pair daily and per-person monthly caps |
| Coercion and steering | Consent script says the person may refuse; assistants are trained and sign a code of conduct; reviewers ask the person in a neutral script whether the words were theirs; family heads cannot consent for another adult |
| Faction capture | Pairs formed by a coordinator from different groups where possible; segment skew monitored by mandal and published in aggregate; reviewers rotate |
| Privacy | No name or phone stored for the assisted person; no voice recording; content shown to assistants only at entry; minimal fields |
| Misrepresentation | Separate labelled segment; excluded from rankings and from survey weights; the API marks every item `channel: assisted`; the published method states it plainly |
| Paid behaviour | No per-record payment or target for assistants; any stipend is flat and funded by the operator, recorded in the annual report |
| Abuse by insiders | Admin actions need dual control; suspension is immediate and audited; the pair can be reported by the adult using the paper receipt |
| Topic creep | Content linter (existing banned-wording and party/candidate keyword hold) applies to assisted entries too |

## 8. Metrics and monitoring

Tracked per mandal and per pair, shown to reviewers and admins, and published only in aggregate:

- Re-check outcomes: confirmed, not confirmed, unreachable (rates).
- Assisted share of all issues in the area (to spot capture).
- Share by gender and age band of assisted adults **as reported by the assistants for the pilot evaluation only**, not stored per person afterwards.
- Time from record to re-check.
- Reports of misuse via the paper receipt.

Alert thresholds (to be set from the pilot, not guessed now): unconfirmed rate, assisted share, pair volume spikes.

## 9. Go/no-go gate (decision for the owner, after the pilot)

Switch on only if all are true:

1. Pilot skew report (`docs/PILOT_SKEW_PLAN.md`) shows phone-less adults are materially under-represented without it.
2. Counsel signs off consent and notice wording and the data-protection position **[VERIFY: DPDP Rules on consent, notice, data of persons who cannot read; any need for a verifiable consent manager]**.
3. A grievance route for the assisted person exists that does not depend on a phone.
4. At least two independent reviewers per district are named and trained.
5. The independent red-team covered this flow (add it to `docs/RED_TEAM_SCOPE.md`).
6. The owner records the decision in `DESIGN_2028.md` §8 (question 5).

Switch off (or suspend a district) if the unconfirmed rate or assisted-share alert fires and is not explained within 14 days.

## 10. Build plan (if approved)

1. Data model and migration in the issues store; `assisted` channel; no assisted-person identifier.
2. Pair management (coordinator creates and suspends pairs) with two-person sign-in.
3. Assisted entry screen (Telugu-first, large touch targets, offline-capable), with the consent step before the form.
4. Receipt code issue and deletion request path.
5. Re-check queue and reviewer console; automatic suspension rules.
6. Separate-segment display and API field; exclusion from survey tooling enforced in code with a test.
7. Config sunset date and a kill switch under dual control.
8. Tests: API (caps, two-assistant rule, no personal fields stored, exclusion from surveys and rankings), browser journey E2E-59 (extend: pair signs in, consent, record, appears labelled, re-check logged), accessibility (axe, 375 px, Telugu), red-team cases (fake pairs, replay of receipt codes, steering).
9. Docs: `ROLES.md`, `STORES.md`, a volunteer handbook and the consent script (Telugu, reviewed by a native speaker and counsel).

Existing pieces to reuse: volunteer enrolment (S-136), T2 attestor identity checks, issue moderation and linter, staged erasure, audit chain, dual-control admin actions, scoped dashboards.

## 11. Open questions for the owner

1. Is assisted participation acceptable at all, given the coercion risk? (Design question 5.)
2. Who trains and pays the assistants and reviewers, and who is accountable for them (operator, an NGO partner, the SHG federation)?
3. Should the adult's consent also be captured another way (for example a thumbprint or signature on paper held by the SHG), and what does counsel advise on retention?
4. Is the 20% re-check sample affordable, and what is the minimum viable sample?
5. Should assisted records be visible to officers by default, or only after review?
6. Does the operator accept the reputational risk if a misuse case surfaces?

## 12. Effort and cost (rough, for planning only)

Engineering is moderate (new tables, two screens, one console, tests) because most pieces exist. The cost and risk are mostly **human**: recruiting, training, paying and auditing assistants and reviewers. Treat the human programme, not the software, as the main workload.
