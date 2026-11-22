# Incident and CERT-In procedure, vulnerability disclosure policy, bug bounty options - DRAFT

Status: **DRAFT. Not legal advice; not approved; no contact below is real.** Extends `docs/BREACH_RUNBOOK.md` (do not edit that file here). Counsel marks: **[VERIFY WITH COUNSEL]**.

## 1. CERT-In directions of 28 April 2022 (read from the primary PDF this session)

Source: https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf (No. 20(3)/2022-CERT-In, MeitY/CERT-In, dated 28 April 2022, under s.70B(6) IT Act 2000). Facts below are from that text; **whether and how they apply to us is [VERIFY WITH COUNSEL]**, and later CERT-In FAQs, extensions or amendments were not read in full.

| Item | What the text says (paraphrase) | Our action |
|---|---|---|
| (i) NTP | Service providers, intermediaries, data centres, body corporate and Government organisations sync ICT clocks to NIC or NPL NTP (or traceable servers) | Configure servers to NIC/NPL NTP sources; record in deployment doc |
| (ii) Reporting | Mandatorily report cyber incidents listed in Annexure I to CERT-In **within 6 hours** of noticing or being informed. Channels: incident@cert-in.org.in, phone 1800-11-4949, fax 1800-11-6969. | Incident commander reports within 6 hours of noticing, even with partial information |
| (iii) Point of contact | Designate a Point of Contact for CERT-In; send details in the Annexure II format | Operator names the PoC (placeholder below) |
| (iv) Logs | Enable logs of all ICT systems and keep them securely for a **rolling 180 days, within Indian jurisdiction**; give to CERT-In on request or with an incident report | Log retention and hosting region requirement; see cost model and RETENTION row "Security/OTP logs" |
| (v) | Data centres, VPS, cloud and VPN providers keep subscriber registration data 5 years | Applies to our vendors, not to us, as we read it [VERIFY WITH COUNSEL] |
| Annexure I | Includes, among others, unauthorised access of IT systems/data, identity theft/spoofing/phishing, **data breach**, **data leak**, unauthorised access to social media accounts | Map our SEV levels (below) |
| Effective date | Stated as effective after 60 days from issue; later extensions for MSMEs and validation were reported by PIB | Not relevant to date logic now |

Not verified: the exact Annexure I wording for every item, any penalty detail beyond "punitive action under s.70B(7)", the CERT-In reporting form format, and whether a trust, section 8 company or government host is covered as "body corporate".

## 2. Procedure (extends BREACH_RUNBOOK.md)

Clocks start at "noticing or being brought to notice".

| Clock | Action | Owner (placeholder) |
|---|---|---|
| T+0 | Start incident log; assign IC; preserve evidence (audit head hash, log snapshots) | IC: ____ |
| T+30 min | Classify (SEV1/2/3 per runbook); decide containment; map to Annexure I category | IC |
| T+6 h | **Report to CERT-In** (email incident@cert-in.org.in, phone as backup) with what is known; send follow-ups as facts arrive | IC |
| T+0 to T+24 h | Counsel decides whether it is a notifiable personal data breach [VERIFY WITH COUNSEL]; if yes, prepare Board intimation (without delay; detailed report within 72 hours per SECONDARY sources) and notice to affected principals in plain Telugu and English | Compliance + Counsel |
| T+7 d | Blameless post-mortem; update threat model and retention table | IC |

Pre-registered contact sheet (all blank until a human fills it; **do not invent**):

| Role | Name | Phone | Email | Backup |
|---|---|---|---|---|
| CERT-In Point of Contact | TO BE APPOINTED | | | |
| Incident commander | TO BE APPOINTED | | | |
| Counsel | TO BE APPOINTED | | | |
| Board intimation owner | TO BE APPOINTED | | | |

Drill: a table-top using this sheet before the pilot, then every 6 months, one with a key-compromise scenario.

## 3. Vulnerability disclosure policy (DRAFT text to publish after counsel approval)

Publication location (not live): `/.well-known/security.txt` and a public page. Contact address is **to be created by the operator**; do not publish `example.invalid`.

> **People Pulse vulnerability disclosure policy (DRAFT)**
> We welcome reports of security problems. Send details to [SECURITY CONTACT: to be created by the operator]. Please include steps to reproduce and the affected page or API.
> **What we ask:** test only your own account; do not access, change or delete other people's data; do not run denial-of-service, spam or social-engineering tests; do not publish details before we have had a reasonable time to fix [TIME: counsel and operator to set]; stop and report if you reach personal data.
> **What we promise:** we will acknowledge within [N days: to be set], keep you informed, not ask you to sign a gag, and [legal safe-harbour wording: counsel to decide whether any assurance can be given; do not promise immunity from prosecution without counsel].
> **Out of scope:** third-party services, physical attacks, volumetric attacks, findings that need a rooted device with no security impact [list to be finalised].
> **Recognition:** [hall of fame / rewards: operator to decide; see bug bounty options].

Questions for counsel: VDP1 safe-harbour language for good-faith researchers under the IT Act; VDP2 duty interplay with CERT-In (a researcher report of a data leak may start our 6-hour clock when we notice it); VDP3 who may sign.

## 4. Bug bounty options (no endorsement; pricing and terms UNVERIFIED)

| Option | Notes | Verified? |
|---|---|---|
| Self-run VDP with no cash, email only, published policy | Lowest cost; needs staff to triage | n/a (design choice) |
| Self-run bounty with small fixed rewards | Operator must hold funds, handle tax and payment; funding conflict rules apply (see operator memo) | n/a |
| Managed bounty platforms (HackerOne, Bugcrowd, YesWeHack, Intigriti exist as vendors; an India-based platform may also exist) | Triage help, researcher pool; platform fees and data-handling terms must be checked; researcher data may cross borders | Vendor existence from general knowledge only; **no URL or pricing verified**; do not treat as shortlisted |
| Government or CERT-In coordinated disclosure | CERT-In accepts vulnerability reports as part of its role; whether it accepts reports on a private service unverified | UNVERIFIED |

Order: engage an independent red team first (release gate), publish VDP at the pilot, consider a paid bounty only after the pilot and once the operator and funder are settled.
