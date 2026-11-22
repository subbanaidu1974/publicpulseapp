# People Pulse 2028 — Civic Participation Platform for the Telugu States

Status: **Draft v2.1 — four-way adversarial review plus a second-opinion review, all fixes applied** · Date: 2026-11-22 · Builds on [DESIGN.md](DESIGN.md) (election trends explorer, already implemented).

---
## 0. Read this first: three facts that shape everything

1. **Which election is "2028"?** Telangana's assembly term ends in Dec 2028, so its election falls in **Nov–Dec 2028**. Andhra Pradesh's assembly (and the Lok Sabha) are due in **~Apr–May 2029**. Local-body polls (panchayat, municipal, GHMC) fall on separate State Election Commission schedules. The platform must support all three tiers, with *election mode* switchable per state. Confirm dates with ECI / the State Election Commissions; I have not verified the notified schedules. Simultaneous-election legislation could move these dates, and the Model Code of Conduct (MCC) would begin roughly two months before polling (about Oct 2028 for Telangana), which overlaps Phase 4.
2. **"Voting online" cannot be an official vote.** I am not aware of any legal basis for binding online voting in assembly, Lok Sabha or local-body elections (the RP Act 1951 and the Conduct of Election Rules govern ballot and EVM voting; ECI's remote-voting machine idea was proposed, not adopted). So this platform offers a **non-binding "Pulse Survey"** (opinion poll), clearly branded so no one mistakes it for an election. For *official* registration and polling-booth details it deep-links to ECI (Voters' Services Portal / Voter Helpline). Please get legal review before launch.
3. **Delimitation and Census 2027 may change the map** (seat counts, boundaries, 33% women's reservation timing). Administrative units must be keyed by stable IDs (LGD codes) with effective-dated boundary versions, never by names.

---
## 1. Requirements (from the brief) → capabilities

| # | Requirement | Capability |
|---|---|---|
| R1 | Public follows election trends | Trends explorer (done) + election-mode live count, booth-level (Form 20), candidate affidavits |
| R2 | Register | Mobile-OTP account, trust tiers, optional residence verification |
| R3 | Vote online | **Pulse Surveys**: non-binding, one-verified-person-one-vote polls; link-out to official ECI services |
| R4 | Issues by constituency down to village | Issue reporting + tracking on a State→District→Constituency→Mandal→Village hierarchy |
| R5 | Registered people add family members | Households with consent-based members and dependents |
| R6 | Voting tied to mobile registration | Phone-bound identity (HMAC-hashed), device/risk checks |
| R7 | Push notifications by government | Verified-sender notification service with MCC (Model Code of Conduct) controls |
| R8 | Government takes public pulse on bills | Consultations: bill text, plain-language summaries, clause-level feedback |
| R9 | Roles: politician, journalist, IAS officer, Election Commissioner, common man | Role-based, geography-scoped access (§5) |

---
## 2. Architecture

```
PWA (Telugu-first, offline queue) ─┐   WhatsApp / IVR / SMS (assisted channels)
                                   ▼
 API gateway (rate limits, WAF) → Auth (OTP, sessions) ─ RBAC/ABAC (role + geo scope)
        │
        ├─ Identity & Households   ├─ Issues (geo, status workflow, SLA)
        ├─ Polls & Consultations   ├─ Notifications (FCM/SMS/WhatsApp, approvals)
        ├─ Elections data (done)   └─ Audit log (append-only, hash-chained)
        ▼
 PostgreSQL + PostGIS · Redis (rate limit/queues) · Object store (photos) · Analytics store (aggregates only)
```
- **Canonical geography:** Local Government Directory (LGD) codes for state, district, mandal, gram panchayat/ward, village; assembly/LS constituency mapped many-to-many to villages with effective dates. Boundaries from DataMeet/Survey of India derived data, villages from Census/LGD.
- **Storage:** current JSON snapshots stay for public election data; user data moves to Postgres. India-region hosting; encryption at rest and in transit.
- **Channels:** web push (FCM) for smartphones, SMS via a TRAI **DLT-registered** sender for fallback, WhatsApp Business templates, IVR for low literacy. All content EN + తెలుగు.
- **Scale target for election/count day:** read-heavy; static-cache public result pages behind a CDN, poll/consultation writes queued.

---
## 3. Core design

> v2 changes: revised after a four-way adversarial review (politicians/press, officials/legal, citizens/inclusion, security red team). Legal statements are from memory and marked **[VERIFY]**: they need counsel, not trust.

### 3.1 Identity, registration and trust tiers (R2, R6)
- Sign-up = **mobile number + OTP**, bound to one number at a time (a PWA or feature phone cannot bind to a SIM). Number-intelligence check on sign-up (recently re-issued/churned number, VoIP/bulk-prepaid batch signals), device attestation **only inside the Android/iOS app** (not available to PWA or feature-phone users, who rely on number intelligence and caps), per-device/IP/ASN caps, and a **14-day account-age gate** before eligibility for any Pulse Survey.
- **Phone storage:** keyed hash with the key in an **HSM/KMS** (never in the app environment), per-purpose keys, rotation plan. A plain HMAC of a 10-digit Indian number is brute-forceable if the key leaks, so the key never leaves the HSM. An encrypted copy exists only for sending OTPs/notifications and is deleted on account deletion. The hash is *pseudonymous personal data*, not anonymous.
- **No Aadhaar storage.** Aadhaar Act ss.8/29 restrict use **[VERIFY]**. The DigiLocker address route may return Aadhaar-derived data, so for T2 we store only a yes/no attestation, not the address document. DigiLocker needs requester onboarding, so it is optional in v1.
- **Shared phones (design change from review):** one SIM may link several adults, each with a **personal PIN** (no voice passphrase: voice prints are biometric data under DPDP and out of scope); the SIM-holder's OTP is used only to *link*, not to speak for others. A PIN is set by each adult in their own app/web session where possible; on a feature phone it is set on an IVR call with attempt limits (5 tries, then lockout; the SIM holder is told of a lockout but never sees a PIN). **Residual risk, stated plainly:** a SIM holder who watches a feature-phone call can coerce or guess a short PIN. OTPs are never read aloud on IVR, and linking requires the new adult's own confirmation. We publish the phone-ownership gap by gender so skew is visible.
- **Trust tiers** are shown to users as simple badges and to analysts as a **verified-quality score** beside every result:
  - T0 phone verified · T1 residence self-declared (hamlet/colony names searchable, mapped to LGD village through our own reviewed hamlet gazetteer (LGD has no hamlets and no village-to-constituency mapping)) · T2 residence confirmed by **two independent attestors** (rotating village volunteers; women verify women; SHG groups count) with a daily per-volunteer quota and random re-checks. T2 never changes weights; it is a labelled stratum.
- Voter-roll matching is **optional and self-declared** (EPIC number for ECI deep-link). We do not scrape ECI rolls or claim to confirm enrolment.
- **Privacy-first copy:** a plain-language "who sees what" screen, a pseudonymous display mode, and Telugu text "answering this will not affect your pension, ration card or any benefit". Responses are never linked to scheme eligibility, by design and by policy.

### 3.2 Households and family members (R5)
- A household has a head (a transferable role, not a privilege) and members.
- **Adults (18+)** are invited by phone number. **Before any data about them is stored**, the invitee receives a notice (what, who, why) and must accept with their own PIN/OTP. Review found that an invite to a number the head controls is not real consent, so: acceptance requires the invitee to choose their own PIN on first use, invites expire in 72 hours, and a spouse can decline or report "I did not agree to this". The head never sees an adult member's answers.
- **Minors** are dependents with verifiable parental consent (DPDP Act 2023 **[VERIFY the Rules' method and age/exemption details]**). Data is minimised (year of birth, no name), never polled, and erasable at 18.
- **Phone-less adults** (mostly women and elderly): see §3.9. Inclusion starts in Phase 1 through voice access and SHG enrolment; *assisted participation* itself (a volunteer recording for a phone-less adult) is Phase 3, after the pilot, issues-only.

### 3.3 Pulse Surveys — the safe form of "voting online" (R3, R6)
- **Naming:** "Pulse Survey". The words *vote, ballot, result* are not used in the UI. Every page carries **"Opinion survey — not an election."** I am not aware of any legal basis for binding online voting in Indian elections **[VERIFY, cite RP Act 1951 / Conduct of Election Rules]**; official registration and booth lookup link out to ECI.
- **Authorised creators and agenda control:** each survey is **registered publicly at creation** (question text frozen, close date fixed, audience fixed). It cannot be cancelled without a public reason, and cancelled surveys stay in the public registry. Ruling and opposition parties (and independent civic groups) have **equal-access creation quotas**; question wording is reviewed by an **independent panel** (rotating, including nominees from opposing parties and civil society). Government departments are tenants subject to the same registry.
- **One verified person = one response per survey, final once submitted** (single-shot: no edits, no re-vote), unique on `(person, survey)` and enforced server-side; re-submission is rejected. The earlier "last answer wins" rule is withdrawn: an unlinkable token cannot overwrite an earlier answer.
- **Secrecy (honest threat model):** secret from creators, officials and routine admins; **not** secret from a compromised server holding every key, and **not coercion-resistant** (a family member or volunteer can watch a person answer), so no receipts are issued and answers are final once submitted. Design:
  - Eligibility via an **anonymous credential / blind-signed token**: the server signs an eligibility token without learning which response uses it; the response is redeemed with the token, no person ID.
  - **Secrecy is per channel.** (1) App/web: the blind-signed credential is computed on the user's device, so the platform cannot link person to answer. (2) Voice/IVR/USSD and assisted channels cannot do client-side crypto, so the server would blind and redeem on the user's behalf and *can* link them; these responses are labelled "channel-assisted, platform-linkable", kept as a separate stratum, and **limited to issue and service surveys (no party/candidate or other sensitive political surveys)**. Users are told which guarantee applies before they answer.
- Response rows carry **no timestamps**, random UUIDs (no sequences), only the survey-close epoch; they enter a **shuffled batch buffer** flushed at random intervals; `has_responded` and `response` live on separate services with separate keys, and logs hold neither.
  - Response rows store the minimum strata needed (no joinable quasi-identifier combinations).
- **Publishing rules (replaces the bare "n ≥ 30"):** n ≥ 30 is a statistical choice, not a legal safe harbour. In addition: publish only on a **fixed geographic partition**; apply **complementary suppression** so no hidden cell can be derived as parent minus siblings; apply the threshold to the *minority option too*; **never publish live or partial counts**; round counts; per-survey **differencing/query budget** with a bit of noise; suppress cross-tabs like tier × gender × village. Results auto-publish at close with sample size, response mix, verified-quality score and weighted + unweighted views (never a headline "% support" without them).
- **Weights:** post-stratification to published marginals (Census 2011 until Census 2027 data lands, plus electoral-roll age/gender where lawfully available) by age band × gender × district; method and code are published and the unweighted view always sits beside. Consultations use the same strata, **one dimension at a time** (no cross-tabs).
- **Election-choice surveys** (party/candidate preference) are **off by default** and gated by a fail-closed feature flag. They are disabled from MCC announcement until results, and exit-poll rules (RP Act s.126A, and 48-hour silence s.126 **[VERIFY exact text/scope]**) are encoded as flags set from the ECI schedule with counsel sign-off. Issue and service surveys stay on.
- **No poll-of-polls forecast.** The earlier house-effect-adjusted "aggregator" is dropped from the election window; outside it, any aggregate is labelled "not a forecast" and its model and code are published.

### 3.4 Issues, constituency → village (R4)
- Anyone verified can report an issue: category (water, roads, electricity, health, education, agriculture/irrigation, welfare schemes, law and order, other), description in Telugu or English (voice note supported), optional photo and GPS, village selected from LGD.
- **Dedupe and support:** nearby similar issues are merged; neighbours "me too" (one per person) to show weight.
- **Workflow:** Reported → Verified → Assigned (department/officer) → In progress → Resolved → Confirmed-by-citizens (or reopened). SLA timers per category; overdue items escalate up the hierarchy automatically.
- **Views:** village page, mandal, constituency, district, state; top issues, ageing, resolution rate, response time by officer/department. Politicians and officers see their own geography; the public sees aggregates and individual public issues (no reporter identity).
- Issue content moderation: reports of individuals, caste/religion targeting, and defamation are blocked or held for review.

- **Metrics and fairness:** public metrics default to **department level**; officer-level views only with jurisdiction tagging, an officer rebuttal field and an out-of-jurisdiction route. Citizen confirmation of resolution has a **time-boxed window** and can be satisfied by sampled neighbours, so one silent reporter cannot block or force closure. Integration with existing grievance systems (e.g. CM grievance dashboards, PGRS/Prajavani-type channels **[VERIFY names]**) so officers work in one place; SLA clocks need a government order to bind officers. Names of individuals in reports are held for review; appeals path for moderated content.
- **Credit:** politicians can post public replies and "resolved under scheme X" notes (labelled as such), which answers the incentive to take credit without letting anyone hide or edit reports. Bulk issue-event feed is public (journalists and opposition get the same raw data).

### 3.5 Government notifications (R7)
- **Sender onboarding:** only verified government departments (letter + domain/gov.in checks); each message has a sender, category, geography, and a digital signature shown in-app.
- **Categories:** Emergency/disaster · Service & scheme · Consultation invite · Civic info. **No campaign, party or promotional content, ever.**
- **Two-person approval** before send; rate caps per sender; targeting by geography and service attributes only — never by political leaning, caste, religion or poll answers.
- **Model Code of Conduct mode:** when ECI/SEC notifies an election, scheme-announcement and promotional categories are blocked automatically; only emergency and essential-service messages go out, each carrying a department MCC self-declaration (the Election Commission, not the platform, decides what is permitted; whether ECI will engage at all is an open question, and the platform must not become a co-sender).
- Users control categories, quiet hours and language; emergency is sent on every channel by default (users can still block OS-level push, so the SMS fallback applies). Full audit log, publicly viewable per sender.

- **MCC keys off a district-level ECI/SEC calendar**, with only a short list of pre-cleared templates in MCC mode; the block log is public.

### 3.6 Consultations on bills (R8)
- A department posts the **draft bill/policy**: full text, a plain-language EN/తెలుగు summary (AI-drafted, **human-reviewed and labelled**), affected groups, comment window.
- Structured feedback: overall support / oppose / amend, **per-clause** reactions, free-text suggestions, plus an optional "how does this affect you" profile (farmer, student, employee, small business…).
- Anti-astroturf: verified accounts only, one response per person, burst detection, duplicate-text clustering; flagged items stay visible but are marked.
- Publication: raw counts + breakdown by trust tier, region, age, gender; methodology link. **A consultation is a signal, not a referendum** — the UI says so, and the closing report must include the department's written response to the top themes.

- **Capacity honesty:** AI clustering of comments is a triage aid; human review samples clusters rather than every comment, the UI says which items were reviewed, and a closing report states how many comments were read. A consultation is a signal, not a referendum.

### 3.7 Election mode (R1)
- Live count-day feed from ECI results (no public API is known, so this means scraping or a licensed feed: treated as fragile, with a delayed TCPD fallback), with CDN-cached pages; booth-level Form 20 results post-election; candidate affidavits (criminal cases, assets, education) from ADR/MyNeta-style open data; polling-booth finder deep-link to ECI.
- Pre-election: constituency pages combine history, census, active issues, and "what is on the ballot" information. No endorsements, no ranking of parties, alphabetical ordering by default.
- No forecast or poll-of-polls during the election window (see §3.3). Outside it, aggregates are labelled "not a forecast" with published method and code.

---
### 3.8 Threat model and security requirements (new, from red-team review)
Adversaries: political parties and paid crowds, organised cadres with real phones, insiders (officers, volunteers, admins), sender-account hijackers, DDoS/booter services, the operator itself under pressure, state-level actors. Required controls:
1. **Written threat model** published with the code, including what secrecy does *not* guarantee (§3.3).
2. **Sybil/OTP-farm cost raising:** number intelligence, 14-day age gate, device attestation, per-ASN/device caps, cohort-level anomaly review *before* publishing, anomaly stats published. Real-person brigading is handled by weighted + unweighted views and source-cohort reporting, not only by burst detection.
3. **Keys:** pepper, signing and encryption keys in HSM/KMS with per-purpose keys and rotation; identity, issue and survey data in separate stores with no cross-store joins; dual-control break-glass, itself published.
4. **Sender security:** FIDO2 hardware keys mandatory (no SMS-OTP login); emergency messages from pre-registered templates, free-text emergency needs 2-of-N signatures; payloads signed by an HSM key and verified against a client-pinned key; SMS fallback uses one DLT header, a fixed short-code, and a user-set personal **anti-phish word**; notifications **never ask for OTPs, bank details or links to login**; instant revoke and kill-switch; anomaly alerts per sender.
5. **Audit log:** hash chain proves order, not authenticity, so the head is **anchored externally** at intervals (multiple independent witnesses, e.g. a university, a newspaper, an electoral body if it agrees); privileged *reads* are logged, not only writes; the public view is redacted so it leaks no response timing.
6. **Count day:** pre-rendered, signed, multi-CDN static result snapshots with published hashes; ingest on an isolated path; write endpoints behind queues and rate tokens; **OTP-send budget capped** (billing-DoS defence); documented degraded mode.
7. **Breach blast radius:** retention schedule (delete phone/residence data N days after a survey closes where possible), erasure that reaches `has_responded` and the audit log (by redaction), CERT-In incident reporting **[VERIFY]**, public disclosure policy and bug bounty.
8. **Release gate:** independent red-team and penetration test before any election-adjacent survey goes live.

### 3.9 Inclusion and channels (new, from citizen review — moves earlier in the plan)
- **Voice-first from Phase 1:** missed-call, Telugu voice menu, voice-note issue reports, reference SMS; IVR menus on a shared feature phone using the personal PIN, in the pilot state only and subject to a telecom/aggregator agreement. **USSD is deferred** (needs per-telco agreements). IVR surveys are limited to issue/service topics (§3.3 channel rule). PWA "lite" mode (<~150 KB target, no map tiles by default, image optional), 2G-tested.
- **Language:** icon-led categories, human-recorded Telugu audio for every question (TTS is weak; cover Rayalaseema, Telangana and coastal dialects), 60-second audio summaries per affected group for bills; trust tiers shown as simple badges, not jargon.
- **Access routes:** SHG-led enrolment drives, Common Service Centres/kiosk access, an in-person grievance path, scam-resistance copy for elders ("we never call to ask for OTPs").
- **Accessibility:** WCAG 2.2 AA plus Telugu screen-reader testing as acceptance criteria; testing with people with disabilities; captioned audio.
- **Assisted participation** (phone-less adults) is limited to issue reporting and feedback, recorded by trained SHG/volunteer pairs with logged identities and random re-checks, shown as a separate segment, never mixed into survey weights. Whether it is acceptable at all stays open (§8).
- **Pilot first:** 2–3 mandals with evaluation (response skew by gender/age/phone ownership) before any state-wide survey. The first panels are already skewed if we skip this.
- **Cost model:** SMS/IVR/data cost per user is budgeted and published; who pays is an open question (§8).

### 3.10 Compliance checklist (new, all **[VERIFY]** with counsel)
DPDP Act 2023 and Rules: Telugu/English notice and consent artefacts, Data Fiduciary / Significant Data Fiduciary assessment, DPO and grievance contact, breach notification, retention, processor contracts with SMS/WhatsApp vendors, children's data. IT Act s.79 intermediary duties (grievance officer, takedown, appeals for moderated content). RTI position of the operator. Law-enforcement/court-order access policy and transparency report. TRAI DLT sender/template registration and consent register. Survey-publication rules and MCC. Aadhaar Act limits. Defamation handling for issue reports naming individuals.

## 4. Data model (core tables)
`person(id, phone_hash, tier, created_at)` · `household(id, head_person_id)` · `household_member(household_id, person_id|null, relation, status[invited|accepted|dependent|assisted], consent_id)` · `admin_unit(lgd_code, level, parent, name_en, name_te, valid_from, valid_to)` · `residence(person_id, lgd_village, declared_at, verified_by)` · `issue(id, unit, category, status, sla_due, geo, ...)` · `issue_event(issue_id, from, to, actor, at)` · `poll/consultation(id, creator_role, audience_unit, opens, closes, kind)` · `question/option(...)` · `has_responded(person_id, survey_id)` (identity service) and `response(survey_id, uuid, answers, age_band, gender, tier, mandal)` (separate service, no timestamps; coarse strata only) · `sender(id, org, verified_at)` · `notification(id, sender, category, geo, signed_payload, approvals)` · `consent(id, person_id, purpose, version, at)` · `audit_log(seq, prev_hash, actor, action, object, at)`.

---
## 5. Roles and access

| Role | Can | Cannot |
|---|---|---|
| Citizen / household head | Register, report issues, respond to polls, respond to consultations, manage household | See individual answers of anyone |
| Village volunteer | Verify residences (T2), assist phone-less adults, triage issues | See poll answers |
| Politician (MLA/MP/ward) | See issues and aggregates in own geography, post public responses, create surveys within the equal-access quota (public registry) | Send notifications, see individuals, cap/withhold results |
| Journalist (verified press) | Bulk issue-event feed and open aggregates via API (same raw data as everyone), published method and code; no privileged early access | Individual data |
| IAS officer / dept | Be assigned issues, update status, create consultations, send notifications (with approval) | Edit or delete citizen reports, suppress results |
| Election Commission liaison (only if ECI/SEC chooses to engage) | Read-only integrity and audit dashboards, receives the block log | Operate platform controls, see individual answers, edit results. MCC/blackout mode follows the published ECI/SEC calendar and is set by the operator's compliance officer, with or without ECI engagement |
| Platform admin | Operate infra | Read response contents (keys held in KMS, break-glass with dual control) |

---
## 6. The debate (v2: four independent adversarial reviews)

The first draft's debate was written by one author and every persona conceded in one line, which the politicians' reviewer rightly called too convenient. v2 replaces it with four independent reviews (separate agents, each arguing in character, read-only), then a moderated adjudication. Legal views are from memory and need counsel.

### Round 1 — positions
| Group | Core attack | What they actually want |
|---|---|---|
| **Ruling MLA** | Public officer/department response metrics are a weapon; auto-publish removes the power to kill a bad survey; MCC silences scheme announcements; the operator is unaccountable | Credit for fixes, a say in commissioning surveys, notice before publication |
| **Opposition MLA** | "Verified tenants" let government pick wording, timing and which surveys see daylight; opposition must ask the government for permission; a tuneable poll-of-polls; officers can bury issues in "Verified/Assigned" | Equal creation rights, a public log of every survey including cancelled ones, raw data |
| **Journalist** | Aggregates only means no audit; the "not joinable" claim is weak; public audit log may leak; legal claims unverified | Bulk issue feed, published method and code, a whistleblower channel for officers |
| **District Collector** | No legal footing for SLA clocks or officer-level metrics; reports name individuals (defamation); a non-responding reporter can block closure | Department-level metrics, "disputed/out of jurisdiction", integration with existing grievance systems |
| **Election commission / legal** | "Vote" wording and OTP-per-person look like a ballot; blackout rules are wider than the draft; ECI should not be a co-sender; DPDP duties are mostly missing | Rename, hard feature flags from the ECI schedule, certified MCC declarations, pre-launch intimation |
| **Farmer (shared feature phone)** | Own-phone rule excludes his wife and mother; PWA/push/GPS assume a smartphone; fears answers affect benefits | Voice and missed-call access now, a "no effect on benefits" guarantee |
| **SHG leader** | Phone ownership is gendered; the head holds the OTP; volunteer verification is a coercion route | Women verify women, SHG enrolment, private complaint channel |
| **First-time urban voter** | Number + village + opinion = a political profile; "non-profit" needs proof | Independent audit, pseudonymous mode, deletion |
| **Security red team** | Cheap OTP farms; differencing on small cells; secrecy split leaks via timing/IDs; HMAC of a phone number is brute-forceable; sender takeover; count-day DDoS | Threat model, anonymous credentials, HSM, FIDO2, external audit anchoring |

### Round 2 — rebuttals and where the moderator sided
- **Agenda control vs. openness (opposition vs. ruling).** Publication timing alone doesn't solve agenda-setting. *Resolved:* public registry of all surveys at creation (cancellations visible), equal-access quotas, independent wording panel. *Not resolved:* who sits on the panel and who appoints it. This is the hardest political question and the doc does not pretend otherwise.
- **Metrics as weapon vs. accountability (ruling vs. press/citizens).** *Compromise:* department-level by default, officer-level only with jurisdiction tags and a rebuttal field; public replies and "resolved under scheme X" credit for politicians; raw issue data open to everyone equally.
- **Own phone vs. inclusion (security vs. SHG/farmer).** The sharpest conflict: OTP farms are cheap, but own-phone rules skew toward richer young men. *Resolved:* one SIM may link several adults each with a personal PIN/voice passphrase, plus number-intelligence and age gates to raise Sybil cost; skew is measured and published; assisted participation stays limited to issue feedback. *Residual risk:* shared-phone coercion can't be fully removed, and a coerced PIN is possible.
- **Secrecy.** The red team showed the has_responded/response split wasn't enough. *Resolved:* anonymous credentials, no timestamps, shuffled batches, separate services; the doc now states exactly what secrecy does and doesn't promise (no coercion-resistance, no receipts).
- **MCC and ECI.** The earlier draft imagined a cooperative Election Commissioner approving messages. The legal review rejects that: the platform must not become a co-sender. *Resolved:* department-certified declarations, pre-cleared templates, public block log; whether ECI engages at all is open (§8).
- **AI summaries.** A "human-reviewed" promise assumed unlimited reviewers. *Resolved:* sampled review with disclosed coverage.

### Round 3 — dissents recorded (not forced to agreement)
- Ruling MLA maintains that auto-publish is hostile to government; the doc keeps it because the alternative (government holds results) destroys credibility.
- Security reviewers wanted T2 and assisted participation dropped entirely; inclusion reviewers wanted them earlier. Compromise above; revisit after the pilot.
- Legal reviewer wanted election-choice surveys banned outright; the doc makes them off-by-default behind a fail-closed flag. Counsel decides whether the flag ever turns on.

## 7. Decision log
| ID | Decision | Source |
|---|---|---|
| A1 | Independent operator; departments are tenants; funders and board published, no party/government money above a cap | all |
| A2 | Results auto-publish at close; no early access for anyone | press, opposition |
| A3 | Public audit log, head anchored externally, privileged reads logged, redacted for timing | red team, press |
| A4 | Public survey registry (creation, cancellation with reason), equal creation quotas, independent wording panel | opposition |
| B1 | Rename to **Pulse Survey**; never "vote/ballot/result"; non-election banner | legal |
| B2 | ECI deep-links (registration, booth, helpline) prominent | citizens, legal |
| B3 | Counsel review and ECI/SEC intimation before launch | legal |
| B4 | Election-choice surveys off by default, fail-closed flag from ECI schedule; no forecast in the election window | legal |
| C1 | One SIM, several adults with personal PIN (no voice passphrase); own-phone rule relaxed; residual coercion risk stated | inclusion, Fable |
| C2 | Number intelligence, device attestation, 14-day age gate, caps, cohort anomaly review | red team |
| C3 | T2 needs two independent attestors, quotas, women verify women; never alters weights | red team, SHG |
| C4 | Verified-quality score and weighted/unweighted views beside every result | red team |
| D1 | Adult invitee gets notice and chooses own PIN before any data is stored; invites expire; decline/report path | SHG, legal |
| D2 | Minors: consented dependents, minimal data, erasable at 18 | legal |
| E1 | MCC keyed to district ECI/SEC calendar, pre-cleared templates, department self-declaration, public block log | legal |
| F1 | Closing report with department response and disclosed comment-review coverage; AI labelled | officer, press |
| G1 | Department-level metrics by default; officer rebuttal; out-of-jurisdiction route; time-boxed citizen confirmation | officer, ruling |
| H1 | Publishing rules: fixed partition, complementary suppression, minority-option check, no live counts, noise/query budget | red team |
| H2 | Single-shot responses; anonymous credential on app/web only; voice/assisted channels labelled platform-linkable and limited to issue/service topics; no receipts | red team, Fable |
| I1 | HSM keys, FIDO2 senders, signed + pinned messages, anti-phish word, kill switch | red team |
| J1 | IVR/missed-call in the Phase 1 pilot (USSD deferred); PWA lite; audio-first Telugu; WCAG 2.2 AA | inclusion, Fable |
| J2 | Pilot in 2–3 mandals before any state-wide survey | inclusion |
| K1 | Compliance checklist and independent red-team as release gates | legal, red team |
| L1 | Phase 1 cut to one pilot state, gated on operator decision and counsel | Fable |
| L2 | Post-stratification weights defined (age × gender × district); one-dimension breakdowns only | Fable |

## 8. Open questions (need a human decision, not more design)
1. Operator entity, board, funders, exit plan if it closes, what happens to data on shutdown.
2. Who appoints the independent wording panel; how equal-access quotas are defined.
3. Will ECI/SEC engage at all? The platform must be designed to work if they do not.
4. Exact legal reading (counsel): online-voting perception, survey blackout, MCC, DPDP Rules, Aadhaar limits, RTI status, intermediary duties.
5. Is assisted participation acceptable at all?
6. Who pays SMS/IVR/data, and the per-user budget.
7. Telugu language/dialect review panel and audio recording capacity.

## 9. Delivery plan (v2)
| Phase | When (target) | Scope |
|---|---|---|
| 0 | Done | Elections trends explorer, API, pipeline, E2E harness |
| 1 | Earliest Q1 2027, **gated on §8.1 (operator/funding) and counsel sign-off** | One pilot state / 2–3 mandals only: threat model and legal review first; OTP identity with HSM keys, shared-phone PINs, LGD + hamlet gazetteer, issues with IVR/missed-call and PWA-lite, audit log with external anchoring. Households after identity is stable. No USSD and no surveys yet. |
| 1b | Q2 2027 | **Pilot in 2–3 mandals**, measure skew, red-team round 1 |
| 2 | Q3 2027–Q1 2028 | Pulse Surveys (anonymous credentials, publishing rules), consultations, survey registry, verified-sender notifications (FIDO2/HSM), roles, department workflow |
| 3 | Q1–Q2 2028 | MCC mode and blackout flags, election-mode data (affidavits, booth finder), assisted participation (if approved), WhatsApp, load/DDoS tests, independent penetration test |
| 4 | Jul–Dec 2028 | Telangana election run: count-day runbook, signed static results, legal sign-off; AP 2029 preparation |

Story IDs S-18 to S-49 in [stories/tracker.json](stories/tracker.json); scenarios E2E-25+ in [E2E_SCENARIOS.md](E2E_SCENARIOS.md).

## 10. Risks (top)
Perceived as an election (B1–B4) · captured by a party or government (A1–A4, unresolved panel appointment) · coordinated manipulation by real people (C2, C4) · re-identification in small villages (H1) · secrecy over-claimed (H2 states the limits) · exclusion of phone-less women and elderly (C1, J1, J2) · sender hijack and phishing (I1) · legal non-compliance, with all legal items unverified (K1) · count-day scale and billing-DoS (§3.8) · funding and sustainability (§8).
