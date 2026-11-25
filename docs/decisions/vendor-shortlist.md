# Decision memo 3: vendor shortlist for SMS/DLT, IVR/missed-call, number intelligence and KMS/HSM (S-152) - DRAFT

Status: **A longlist of candidates whose existence I could confirm, not a recommendation and not an endorsement.** No vendor was contacted. Pricing, terms, India coverage and data-residency are **UNVERIFIED** for every candidate unless stated. Nothing here is a procurement decision. Use the criteria and the due-diligence checklist, then ask each vendor in writing.

How existence was checked: web searches on 22 Nov 2026; the URL shows where. "Exists" means the vendor publishes a product page or documentation; it does not mean the product meets our needs.

## 1. Evaluation criteria (apply to every category)
1. **Data residency and processing location** (India region; no personal data leaving India without counsel approval; CERT-In log duty requires logs in India [VERIFIED, CERT-In directions item (iv)]).
2. **DPDP processor terms**: deletion on our schedule (docs/RETENTION.md), sub-processor list, breach notice time to us, audit rights, no secondary use of numbers or content. [VERIFY WITH COUNSEL]
3. **Neutrality and conflict**: no political clients that could be competing or leaking; ownership; ability to refuse party/government pressure.
4. **Security**: certifications and reports (ISO 27001, SOC 2 or equivalent), MFA, API key scoping, IP allow-listing, webhook signing, incident history.
5. **Reliability at our peaks**: throughput per second and per hour at our OTP budget (default 2000/h, `CIVIC_SMS_HOURLY_BUDGET`) and count-day load (docs/CAPACITY.md); status page; failover; support in India hours.
6. **Cost transparency**: published rate card, minimum commitments, GST, hidden fees (DLT, sender ID, number rental, per-lookup).
7. **Exit**: export of logs and numbers, no lock-in of templates or numbers, notice period.
8. **Telugu and accessibility fit**: Unicode Telugu SMS templates (character limits), Telugu IVR and speech, DTMF reliability on basic phones.
9. **Our adapter fit**: provider adapter exists or is small to write (the code has provider adapters; contract tests are another agent's task).

## 2. SMS aggregator and DLT (India)
India requires sender and template registration on telecom operators' DLT platforms (TRAI framework; DESIGN_2028 3.10 lists "TRAI DLT sender/template registration and consent register" as a [VERIFY] item). I did not read the TRAI rules.

| Candidate | Exists? | Source | Notes (all UNVERIFIED) |
|---|---|---|---|
| MSG91 | Yes, India-based communications platform with SMS, voice, WhatsApp, OTP | https://msg91.com/ph (landing page) | Public pages mention OTP over SMS and voice; DLT handling not confirmed from an official page; pricing seen only on third-party pages |
| Twilio | Yes | https://www.twilio.com/sms/pricing/in | Official India SMS pricing page exists; rates were not shown in the fetched snippet; US company, data location to be checked |
| Infobip | Yes | https://www.infobip.com/docs/number-lookup.md (documentation) | Documentation is for Number Lookup; its SMS offering for India not checked here |
| Others to ask about | Not verified in this session | none | Names that came up in sources but were not confirmed by an official page (for example Exotel, Kaleyra/Tata Communications) |

## 3. IVR and missed-call aggregator
| Candidate | Exists? | Source | Notes |
|---|---|---|---|
| Exotel | Described by third-party sources only (TrustRadius, StackShare as a CPaaS in India and Southeast Asia); **official site not fetched** | https://www.trustradius.com/compare-products/exotel-vs-msg91 | Missed-call and IVR products not confirmed from an official page |
| MSG91 | Yes (voice and OTP over voice listed on public pages) | https://msg91.com/ph | IVR and missed-call features not confirmed |
| Twilio | Yes (voice products exist) | https://www.twilio.com/sms/pricing/in (SMS only checked) | India voice and toll-free availability not checked |
Extra check for this category: toll-free vs local number, per-minute vs per-second billing, recording retention and location, DTMF reliability on feature phones, ability to play our own human-recorded Telugu files by dialect.

## 4. Number intelligence (line type, porting, recent re-issue)
| Candidate | Exists? | Source | Notes |
|---|---|---|---|
| Infobip Number Lookup | Yes | https://www.infobip.com/docs/number-lookup.md | Documentation states that in India the lookup does not query the HLR directly but reads Mobile Number Portability data; if a number is not ported the network is decided from the prefix. So "recently re-issued" signals are **not** evident from it |
| Twilio Lookup (SIM swap, packages) | Yes | https://twilio.com/docs/lookup/lookup-sim-swap | SIM-swap is described as private beta with coverage listed for Europe, Latin America and North America; **no sign India is supported** |
Open question: whether any provider can give "recently re-issued/churned number" or line-type signals for Indian numbers at all. DESIGN_2028 3.1 depends on it; if none exists, the 14-day age gate and caps carry more weight (a design risk to record). Ask the telecom aggregator and the numbering authority route (unverified) as well.

## 5. KMS / HSM
The key requirement is per-purpose keys (hmac, encrypt, sign), rotation, dual-control break-glass, and keys never in the app environment (DESIGN_2028 3.1, 3.8). The code today has a dev key provider; a real provider adapter is not written (another agent's task).

| Candidate | Exists? | Source | Notes |
|---|---|---|---|
| AWS KMS / AWS CloudHSM | Products are well known; **no URL fetched this session**; India region availability and pricing UNVERIFIED | none | Check Mumbai and Hyderabad region availability for both |
| Google Cloud KMS / Cloud HSM | Well known; **not fetched** | none | Check Mumbai/Delhi region availability |
| Microsoft Azure Key Vault / Managed HSM | Well known; **not fetched** | none | Check Central India / South India availability |
| Government or sovereign cloud HSM service | Not researched | none | Neutrality concern: state custody of keys (see operator memo) |
| Self-hosted HSM appliance in an Indian data centre | Not researched | none | Staff and ceremony burden; relevant to the operator decision |
Hyperscaler KMS keys are held under a US-headquartered provider's control plane; whether that is acceptable for Indian voter-adjacent pseudonyms is a counsel/owner question [VERIFY WITH COUNSEL].

## 6. Due-diligence checklist (send to each shortlisted vendor in writing; record answers and dates)
- [ ] Legal entity, registered address in India, ownership, any political or government clients.
- [ ] Data processing agreement: roles (processor), sub-processors, locations, deletion within [period from RETENTION.md], return of data, breach notice within [hours], audit rights.
- [ ] Where are logs, message content, call recordings and phone numbers stored; retention default; can we set it.
- [ ] Security attestations (certificates and dates) and last penetration test summary.
- [ ] Throughput and rate limits; queue behaviour at our hourly budget; SLA and credits; status history.
- [ ] Published price list with all fees; minimums; invoicing in INR with GST; price-change notice.
- [ ] DLT: who registers the entity, header and templates; time to approve; Telugu Unicode templates supported; delivery-report accuracy.
- [ ] Number intelligence: fields returned for Indian numbers, data source (MNP, HLR, operator), latency, accuracy statistics, whether results are stored or shared.
- [ ] KMS/HSM: FIPS or equivalent level, region, key import/export policy, dual-control support, audit log of key use, cost per key and per request, support for our hash-keyed (HMAC) operation without exporting the key.
- [ ] IVR: audio file formats accepted (see docs/AUDIO_RECORDING_GUIDE.md), DTMF handling, recording of voice notes, toll-free availability.
- [ ] Exit: export formats, termination notice, number portability of our virtual numbers and sender IDs.
- [ ] References from an Indian civic or public-service customer, with permission to contact.
- [ ] Conflict statement: will the vendor tell us of any government order to access our data, as far as the law allows.

## 7. Decisions needed from people
Who may sign vendor contracts (depends on the operator decision); budget and funder limits; whether a hyperscaler KMS is acceptable; whether a government or sovereign cloud is acceptable; who evaluates (a small panel including a security reviewer, counsel and a field-operations person); evidence of any quote goes into data/reference/cost-assumptions.json with source URL and date.

Follow-up research and a test plan for the number-intelligence category: [S-62-number-intelligence.md](S-62-number-intelligence.md) (2026-11-24, public claims only, unverified).

SMS gateway follow-up with the DLT worklist for the pilot and a test plan: [S-63-sms-gateway.md](S-63-sms-gateway.md) (2026-11-24, public claims only, unverified).
