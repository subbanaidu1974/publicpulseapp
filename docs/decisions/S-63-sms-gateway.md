# S-63 decision note: SMS gateway, DLT registration worklist and test plan

Status: DRAFT for the owner. Research of 2026-11-24 from public web pages (TRAI pages, vendor and law-firm blogs). Prices and timings below are vendor-blog claims and conflict across sources; get written quotes. No vendor was contacted and nothing was registered. Not legal advice. S-63 is closed as "what is built" (owner decision 2026-11-25): the adapter, template guard and this plan. A gateway choice, DLT registration and a real-handset check remain a launch prerequisite.

## 1. What India requires before any SMS can be delivered

TRAI's [advice to senders](https://trai.gov.in/advice-to-senders) lists the sequence for bulk messaging: register as a Principal Entity (PE), get a header (an alphanumeric sender name of at most 11 characters), register each message template, send the PE ID, header and template ID with every message, register a consent template if consent is used, and keep consumer consent. This is done on each telecom operator's DLT portal (a gateway usually helps). Reported paperwork: legal entity name matching its registration documents, PAN, GST where applicable, address, authorisation letter; reported time 1 to 3 weeks (vendor blog, unverified). Whether OTP and service messages have lighter rules was not confirmed; TRAI amended its rules in 2025 and a 2026 draft exists, and I could not read their substance. Ask the gateway and counsel for the current text.

Consequence for us: the entity must exist first. The DLT registration needs the operating organisation's papers, so this follows the S-152 work (entity name and type).

## 2. What our code needs registered (worklist for the pilot)

Our templates live in `defaultCivicTemplates` (`server/civic/providers/sms.ts`) with empty template IDs; production refuses to send an unregistered one. For the pilot (IVR off, notifications off, per `docs/gate/pilot-profile.json`) register these:

| Template id | Purpose | Note |
|---|---|---|
| `otp` | Sign-in code | English today. A Telugu version is not defined; add one only after a native speaker approves it |
| `pin_lockout` | Warning that sign-in was locked | Longer than 160 characters, so more than one part |
| `adult_added` | Tells a number's owner another adult was added | |
| `issue_reference` | Reference for a filed issue | |
| `enrol_activation` and `household_invite` | Enrolment and household invite, carry long fixed notice text | Very long; consider moving the notice into the app and keeping the SMS short, which also cuts cost |

Not needed in the pilot: `ivr_failed` (IVR off) and `notify_sms_en` and `notify_sms_te` (notifications off). Template IDs go in a JSON file named by `CIVIC_SMS_TEMPLATES_FILE`.

Telugu cost warning: Unicode (UCS-2) messages carry about 70 characters per part against 160 for plain English, so a Telugu message costs roughly twice as many parts (source: [Sent.dm India guidance](https://www.sent.dm/resources/in-sms-guidance), a vendor page). Budget for it in `docs/decisions/cost-model.md`.

## 3. Candidates (all UNVERIFIED; ask each in writing)

| Candidate | Public claim | To ask |
|---|---|---|
| MSG91 | India-based; one vendor-blog source quotes about 0.25 rupees per SMS at 5,000 messages falling to about 0.16 at volume, plus 18 percent GST | DLT help, Telugu Unicode support, delivery-receipt format and signing, data location, DPA |
| Gupshup | Prepaid wallet, no platform fee; no clear per-SMS rate found | Same; support responsiveness (one review calls it slow) |
| Kaleyra | Volume-based, negotiated by sales | Same |
| Exotel | Per-SMS rate not found | Same; also relevant to IVR later |
| Twilio | [India SMS pricing page](https://www.twilio.com/sms/pricing/in) exists | US company; data location; DLT handling |

One source says a single PE ID can be bound to several gateways, which would allow a second gateway for failover. Unconfirmed; ask.

## 4. Test plan

1. Pick 2 gateways. Ask the section 6 questions in `docs/decisions/vendor-shortlist.md` plus: DLT registration support and cost, delivery-receipt format and how it is signed, and whether receipts show a real operator delivery or only "accepted".
2. After the entity and DLT registration exist, send the pilot templates to 20 or more team-owned handsets on Airtel, Jio, Vi and BSNL in AP and TG. Record delivery time, whether the English template renders correctly, and whether a Telugu test message renders correctly on a basic phone.
3. Map the gateway's real field names, receipt format and signature into `CIVIC_SMSGW_*` and run the adapter's contract tests against the gateway's sandbox.
4. Put the quoted price per part and the real part counts into `data/reference/cost-assumptions.json` with source and date.
5. Test the failure path once: gateway down, then the circuit breaker and the quiet-failure policy as built.

## 5. Decisions for the owner

* Which two gateways to trial, and who signs the contract (the entity from S-152 must exist).
* Whether to keep the long notice text in SMS or move it into the app.
* A Telugu OTP template: yes or no for the pilot, and who approves the Telugu text.
* Budget for the pilot's SMS (see the cost model; every price there is still unknown).
