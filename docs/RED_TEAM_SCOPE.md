# Independent red-team scope (request for proposal) - S-153, RELEASE_GATE row 2

Status: DRAFT scope for a human to commission. It names no vendor, no budget, no dates and no contacts: those are decisions for whoever issues the engagement (fields marked `____` below). The builders wrote this document; the tester must not be the builders or anyone paid by a person whose work is under test.

## 1. Purpose

Test whether the controls claimed in `docs/THREAT_MODEL.md` (section 4A, controls T-01 to T-52) hold against a determined attacker, and find what the builders missed. The goal is evidence for RELEASE_GATE row 2: a report from an independent party, with every critical and high finding fixed or formally accepted. The system is a civic participation platform (verified residents report local issues; surveys come later). It is not an election and publishes no forecast, but it is election-adjacent, so manipulation, re-identification and loss of trust are the harms that matter most.

## 2. Engagement facts to fill in

| Item | Value |
|---|---|
| Commissioning organisation | ____ |
| Engagement lead (names the accepter of findings) | ____ |
| Security contact for the tester, 24-hour during the test window | ____ |
| Test window | ____ to ____ |
| Retest window | ____ |
| Budget and contract form | ____ |
| Commit to be tested (tag) | ____ |

## 3. Assets and what to protect

| Asset | Where | Why it matters |
|---|---|---|
| Phone-to-person link (keyed hash, encrypted copy) | identity store | Re-identification, harassment, targeting |
| PIN hashes, session tokens, OTP secrets, MFA secrets | identity store | Account takeover |
| Residence and household data | identity store | Location privacy, small-village re-identification |
| Issue reports, voice notes, photos, GPS | issues store, media directory | May name or identify individuals |
| Reporter link ledger | identity store (`issue_links`) | The only way back from an issue to a person |
| Audit log and its anchors | audit store, anchor sink | Proof of what operators and officers did |
| Keys | key provider (development provider in the test build) | Root of every other control |
| Published aggregates and issue metrics | public API | Manipulation target; small-cell privacy |
| Admin and officer roles | roles, `/admin` | Insider and privilege abuse |
| Availability of sign-up and report flows | edge, SMS budget | Billing denial and sign-up denial |

## 4. In scope

Test target: a staging deployment built from the tagged commit, with development stand-ins for external providers (section 6). The builders provide the environment; the tester does not attack production or any real person's data.

| Area | Endpoints and components |
|---|---|
| Identity | `/api/v1/civic/identity/*`: sign-up and recovery OTP, PIN login and change, sessions, SIM linking, residence declaration, attestation, account deletion |
| Network trust | `X-Attestation`, `X-Device-Id`, `X-Asn`, `X-Forwarded-For` handling and caps weighting; trusted-edge headers; `TRUST_PROXY` |
| Households and volunteers | `/api/v1/civic/households/*`: invites, notices, dependents, transfer, volunteer enrolment and activation |
| Issues | `/api/v1/civic/issues/*`: create, me-too, dedupe, media upload (images, voice), moderation and held reports, appeals, officer and moderator consoles, public feed, exports and their rate limits |
| Channels | `/api/v1/civic/channels/*`: missed-call and IVR webhooks, voice-note webhook, recording URL handling, webhook signature and replay protection |
| Admin | `/api/v1/civic/admin/*`: roles, dual-control requests, TOTP MFA; `/api/v1/civic/ops/jobs` |
| Audit | `/api/v1/civic/audit/*`: head, redacted entries, verify; anchor sink behaviour |
| Data stores | Separation of the four stores; the pseudonymous reporter link; erasure across stores; backups and restore (`docs/RUNBOOK.md`) |
| Public APIs and edge | `/api/v1/elections`, `/geo`, `/constituencies`, people and window endpoints; rate limiter, security headers, CSP, body limits, compression |
| Front ends | The main PWA and `/lite`, including the service worker and offline report queue |
| Supply chain | `package.json` dependencies, build output, container image (`docs/DEPLOYMENT.md`), secret handling |

Priority test objectives (each maps to a threat in `docs/THREAT_MODEL.md`; the tester may go beyond them):

1. Create accounts without owning a phone number, or beat the OTP, per-network, per-IP, per-phone, per-device and SMS-budget caps (T-02 to T-09).
2. Make the server believe a client-supplied device id or ASN, or bypass the trusted-edge check (T-06, T-07).
3. Take over another resident's account: OTP replay, PIN brute force across sources, recovery abuse, session fixation, shared-SIM confusion (T-04, T-13, T-15).
4. Defeat the IVR personal-PIN step or call the webhooks without a valid signature, replay a signed request, or file as another person (T-11, T-12, T-40).
5. Re-identify a reporter or supporter from the issues store, the public API or the exports, or rejoin the stores without the key (T-18, T-24, T-26).
6. Read or alter data across roles: officer jurisdiction escape, moderator or admin actions without MFA or without a second admin, privileged reads that are not logged (T-29, T-34, T-35).
7. Rewrite or truncate the audit chain undetected, with and without the anchor sink configured (T-25, T-27).
8. Abuse household invites, dependents or volunteer enrolment to create or inflate accounts (T-37, T-39).
9. Evade the held-for-review moderation for reports naming individuals (T-19).
10. Make erasure incomplete, or recover erased data from other tables, media, logs or backups (T-32, T-33).
11. Inject script or content through issue text, labels, media metadata or the offline queue; abuse media parsing; server-side request forgery through recording URLs (T-40, T-41, T-43).
12. Exhaust the SMS budget or the process cheaply (billing and availability denial) at low volume (T-09, T-10).

## 4A. Assisted participation (conditional: in scope only if the owner decides to enable it)

Added for S-49. Design and limits: `docs/ASSISTED_PARTICIPATION.md`; code: `server/civic/assisted/`; operator view: `docs/ASSISTED_RUNBOOK.md`. The design note (section 9) makes an independent red-team of this flow a go-live condition (conditional gate A-1, `docs/gate/assisted/README.md`). Endpoints: `/api/v1/civic/assisted/*` (my-pair, records, segment, receipts status/delete/report, pairs, rechecks, switch). Test with the feature enabled on staging (`ASSISTED_ENABLED=1`, a future `ASSISTED_SUNSET_DATE`). Test people are the tester's own accounts; no real resident takes part.

These cases are **not yet mapped** to rows of the traceability table in `docs/THREAT_MODEL.md` (section 4A there), because the control-to-test mapping for this feature has not been reconciled. They are listed here so the tester covers them; the threat model gets rows once the mapping exists.

| # | Case | What the tester tries | What should hold |
|---|---|---|---|
| AP-1 | Fake pairs | Form a pair without a coordinator; self-form; use the same volunteer in two pairs; make a coordinator a member of their own pair; get a pair formed in a village outside a coordinator's scope; use one person with two sessions as "two assistants"; replay the second assistant's token | Pairs only through a coordinator whose grant reaches the village; two different people, both signed in on the request; one active pair per volunteer; refusals are audited |
| AP-2 | Receipt replay and guessing | Reuse a receipt code after use; enumerate or brute-force codes; replay one code from many addresses; probe timing to find valid codes; use a code to read another person's report; delete another person's record; use the flag endpoint to knock an honest pair into review | Look-ups rate-limited per address and globally; failures look the same; the code reveals only status of its own record; deletion is idempotent and leaves a stub; repeated flags are visible in the audit and cannot suspend a pair by themselves |
| AP-3 | Steering and coercion | Make the entry screen or API accept text that was put in the person's mouth; make a record without the consent ticks or the adult attestation; submit with one assistant's consent only; skip the re-check queue for chosen records; learn which records are sampled | All four consent ticks from both assistants; adult attestation; sampling is unpredictable to the pair (new pairs and flagged pairs sampled in full); a reviewer cannot re-check their own pair's records |
| AP-4 | Topic creep | Record party, candidate, minister or election content in English, Telugu, transliteration, with spacing and mixed scripts; use survey-like wording; smuggle it through the category or the segment snippet | Such entries are held for review, not shown in the public segment; no survey tooling reads assisted records |
| AP-5 | Capture and quota behaviour | Single faction or group fills pairs and reviewers; one pair stays under the daily cap but spikes volume across many pairs in one village; a reviewer who is related to the pair records "confirmed" for all; outcomes for deleted records; a coordinator who forms pairs from one group | Daily caps per pair and village; reviewer scope by area; own-pair exclusion; skew is visible to operators (a monitoring procedure, with no automatic alarm: report if the data needed is missing) |
| AP-6 | Personal data about the assisted person | Send name, phone, age, address, Aadhaar, GPS, photo, voice fields; put such data in the free text; check logs, audit rows, errors, exports and backups for the person | Personal fields refused; free text screened and held; audit metadata scrubbed; no identifier of the person is stored |
| AP-7 | Insider and admin abuse | Self-approve the kill switch; replay an expired switch request; lift the switch after the sunset date; read pairs outside the role's area; suspend a pair without a reason; edit a record's content as a reviewer | Dual control with TOTP and a different admin; requests expire at 72 hours; sunset keeps the feature off whatever the switch says; scoped reads are audited; reviewers cannot edit |
| AP-8 | Misrepresentation | Find any API or page where assisted records count in organic totals, rankings, support counts, or survey weights, or lose the `channel: assisted` mark | Separate labelled segment; no ranking; every item marked assisted; feature off means the segment disappears |
| AP-9 | Availability and abuse of the off switch | Reach any assisted route while the feature is off, past the sunset date, or while killed; flood the receipt endpoint to deny the person | Routes answer 404 `assisted_disabled` (the switch routes excepted while killed); per-address limits do not lock out other addresses |

Report any finding on this section in the same format as section 9, with the case number.

## 5. Out of scope

- Volumetric denial of service and network-layer flooding, load testing beyond the rates agreed in writing (capacity is measured separately; RELEASE_GATE row 7).
- Social engineering, phishing or physical attacks against residents, volunteers, officers, builders or the hosting provider. Social engineering of the builders' staff only if the engagement lead approves a written plan.
- The external providers' own infrastructure (SMS gateway, telecom, aggregator, cloud provider, CDN) and anything not owned by the commissioning organisation.
- Production systems and any real person's data. Do not test against a production deployment or against real phone numbers.
- The legacy browser-side admin and login code and the legacy server routes, which are disabled; report if reachable in the tested build.
- Findings that exist only because a development stand-in is installed (section 6), unless the tester shows the same flaw would remain with a real provider.

## 6. Known stand-ins and known gaps (not findings by themselves)

Findings about these are expected; the useful test is whether the surrounding controls hold anyway. `docs/THREAT_MODEL.md` sections 4A and 6 are the authoritative list.

- Key provider: development provider, keys derived from one environment string; no HSM/KMS, no rotation (T-20, T-21).
- SMS: console/outbox provider; number intelligence: a fixture list; device attestation: a development HMAC token (T-02, T-07).
- Telephony: simulated aggregator; audio prompts are placeholders (T-11, T-12).
- All four stores share one host, volume and key provider (T-23).
- Per-network cap is an address-prefix proxy (/24, /48), not an ASN database (T-05).
- No sender or notification feature, no surveys, no count-day snapshots (T-46, T-47, T-49).
- Missed-call counters and IVR call state are in process memory (T-10).
- Notices are drafts; the grievance officer address is a placeholder (T-38).

## 7. Rules of engagement

1. Test only the staging deployment and the accounts and numbers provided. Stay inside the listed hosts, ports and paths.
2. No access to, copying of, or retention of data about real people. If real personal data is found, stop, do not copy it, and tell the security contact immediately.
3. Rate limit yourself to the agreed request rate: `____` requests per second per source. The OTP and SMS caps are a target of testing; the engagement lead may ask the builders to raise or reset them, and the tester must record when they do.
4. Do not send real SMS, place real calls or use real phone numbers. Use only numbers allocated for the test (section 8).
5. No destructive actions on shared data (no mass deletion, no filling the disk, no corrupting the audit store beyond a copy provided for tamper tests). Tamper tests run against a database copy the builders provide.
6. Stop and report at once, by the agreed channel, any critical finding that is actively exploitable by others, and any sign of a third party in the environment.
7. Findings, tools and data stay confidential until the engagement lead approves disclosure. No public disclosure before the fix and retest, or 90 days after the report, whichever the engagement lead sets: `____`.
8. The tester has no commit access to the repository during the test. Read-only source access is granted for a white-box review (see section 8), and the tester says in the report whether each finding came from black-box testing or from source reading.
9. A good-faith test inside these rules is authorised by the commissioning organisation: `____` (the human who can authorise; the authorisation is attached to the engagement, not inferred from this document).

## 8. Test accounts, environment and source access

The builders provision these on the staging deployment and deliver credentials out of band to the named tester. Credentials are never written in this repository.

| Account | Purpose | Notes |
|---|---|---|
| Resident A, Resident B | Two ordinary verified residents in different villages | For cross-account and IDOR testing |
| Resident on a shared SIM | Two adults sharing one number, each with a PIN | For shared-SIM and IVR tests |
| Pending volunteer enrolment | A volunteer and one enrolled-but-not-activated resident | For enrolment tests |
| Officer, Moderator | Scoped to one jurisdiction each | For jurisdiction and moderation tests |
| Admin x2 | Two admins with TOTP set up | For dual control and MFA tests |
| Webhook secret | A staging-only secret for the signed webhooks | To test signature handling, not to be reused |
| Unauthenticated | No account | For anonymous attack surface |

Environment: the staging build runs with development providers, so one-time codes are available to the tester through the development outbox. This is deliberate for testing; it is not a finding that codes can be read there. Source: a read-only checkout of the tagged commit, `docs/THREAT_MODEL.md`, `docs/STORES.md`, `docs/RUNBOOK.md`, `docs/DEPLOYMENT.md`. Database copies for tamper tests on request.

The test-only seeding endpoint (`/api/v1/civic/e2e/*`) exists in non-production builds when `CIVIC_E2E_SEED=1`. It must be off in the staging build under test; the tester should confirm it is unreachable and report it if it is not.

## 9. Reporting format

One report, delivered as a signed PDF plus a machine-readable findings file (CSV or JSON), containing:

1. Executive summary (one page): scope, dates, method, headline risks, a plain statement of which threat-model rows were confirmed, contradicted or untested.
2. Method and coverage: what was tested, what was not, and why; tools; black-box versus white-box per finding.
3. Findings, one entry each, with: ID, title, severity (section 10), affected component and commit, description, impact, reproduction steps precise enough for the builders to repeat, evidence (requests and responses with secrets and personal data removed), recommended fix, relation to a threat-model row (T-nn) if any, and whether it is exploitable with the development stand-ins only or with real providers too.
4. Positive results: attacks that failed and the control that stopped them.
5. Retest section (filled in later, section 11).
6. Independence statement: who performed the work, their relationship to the builders and to the commissioning organisation, and any conflict.

The builders then append each finding to `docs/THREAT_MODEL.md` section 8 with its status, and the engagement lead records the accepter for each accepted critical or high finding.

## 10. Severity scale

Rated by impact on the people and the process, then adjusted by how easy it is to exploit. CVSS v3.1 or v4.0 scores are welcome as a second column; this scale decides what blocks release.

| Severity | Definition (any one is enough) | Release rule |
|---|---|---|
| Critical | Re-identify reporters or respondents at scale, or take over accounts at scale; read or alter the identity or issues store without authorisation; forge, delete or undetectably alter audit entries; act as an admin or officer without the required MFA or second approver; bypass the OTP and device caps cheaply enough to farm accounts; remote code execution | Blocks release. Fix and retest, no acceptance |
| High | Take over a single account; read another resident's private data; privilege escalation within roles or jurisdictions; bypass of webhook authentication or the IVR PIN; a billing or sign-up denial that needs little effort; stored script injection reaching other users; erasure that leaves personal data behind | Blocks release unless fixed or formally accepted by a named person with a written reason |
| Medium | Information disclosure of non-personal or coarse data; weak limits that need meaningful effort to abuse; missing logging of a privileged read; moderation bypass for one report; flaws needing a victim's cooperation | Fix or accept before release; recorded in the risk register |
| Low | Hardening gaps, verbose errors, missing headers with no demonstrated path to impact | Tracked |
| Informational | Observations, documentation errors, defence-in-depth suggestions | Tracked |

## 11. Retest policy

- The builders fix findings on a branch and tell the engagement lead, who passes the commit to the tester.
- The tester retests every critical and high finding, and any medium the engagement lead selects, on the fix commit and reports each as: fixed, partially fixed, not fixed, or new issue introduced. Retest evidence is attached to the report.
- A finding is closed only by the tester's retest or by a written acceptance from the named accepter. The builders cannot close their own finding.
- One retest round is included; further rounds, if needed, are agreed with the engagement lead. Retest happens within `____` days of a request.
- New critical or high findings from a retest follow the same rule. The release gate row stays unchecked until the final retest report is attached.

## 12. Vendor requirements (for the proposal)

- Independence: no commits to, and no commercial relationship with the builders beyond this engagement; a signed statement.
- Experience: demonstrated web API, mobile web and telephony-adjacent testing; at least one engagement involving personal data under Indian data-protection law or equivalent.
- Staffing: named testers; Telugu reading ability for content and IVR prompts is an advantage, not a requirement.
- Deliverables and timeline: the report in section 9, a retest, and a 60-minute read-out for the builders and the approvers.
- Handling: how the tester stores findings and test data, and deletes them after the engagement.
- Price and terms: fixed price per section 2 fields.

## 13. Evidence for the release gate

Attach the final report, retest report, independence statement and the list of accepted findings with accepters to `docs/gate/02/evidence/`. `npm run gate:status` then shows the row has human evidence; a person still sets owner and date and checks the box.
