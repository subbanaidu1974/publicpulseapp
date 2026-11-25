# Counsel review pack (S-150) - DRAFT

Status: **DRAFT. Prepared by engineering, not by a lawyer. Nothing here is legal advice and no legal conclusion has been reached.** Every legal statement is marked **[VERIFY WITH COUNSEL]**. No counsel has reviewed anything yet; no officer is appointed; no contact is real.

How to use: give counsel this file, `ARTEFACT_TEXT.md` (exact EN/TE text, generated), `artefacts.json` (index), `docs/RETENTION.md`, `docs/BREACH_RUNBOOK.md`, `docs/THREAT_MODEL.md`, and `docs/DESIGN_2028.md` sections 3.1, 3.8-3.10. Ask counsel to answer each numbered question in writing. Only after written sign-off may a human change an artefact status from DRAFT (that edit is a human act, never automated).

Source labels used below: **[PRIMARY-READ]** = I read the text of a government document in this session (named, with URL). **[SECONDARY]** = reported by a law-firm or news page only. **[MEMORY]** = engineering recollection, unverified. Anything not labelled PRIMARY-READ must be treated as unverified.

## (a) Index of user-facing legal artefacts

All are DRAFT. Exact EN and TE text is in `ARTEFACT_TEXT.md` (regenerate with `npx tsx scripts/gen-compliance-text.ts`).

| ID | Artefact | File | Status | Telugu reviewed by linguist? |
|---|---|---|---|---|
| A1 | Signup data notice v1 | `server/civic/households/notices/signup.v1.json` | DRAFT | No |
| A2 | Household invite notice v1 | `server/civic/households/notices/household_invite.v1.json` | DRAFT | No |
| A3 | Minor dependent / parental consent notice v1 | `server/civic/households/notices/minor_dependent.v1.json` | DRAFT | No |
| A4 | Grievance officer contact (placeholder: name "TO BE APPOINTED", email `grievance@example.invalid`, address "TO BE FILLED BY OPERATOR") | `server/civic/households/notices/grievance_officer.json` | DRAFT | No |
| A5 | Privacy page | `src/i18n/content.ts` (`PRIVACY`) | DRAFT | machine-draft |
| A6 | Terms of use page | `src/i18n/content.ts` (`TERMS`) | DRAFT | machine-draft |
| A7 | Who-sees-what page | `src/i18n/content.ts` (`WHO_SEES`) | DRAFT | machine-draft |
| A8 | Takedown / correction request form (no standalone takedown page) | `src/components/people/peopleText.ts` (`ppl.report.*`) | DRAFT | No |
| A9 | Consent banner chrome | `src/components/civic/ConsentNotice.tsx` + `civicText.ts` | DRAFT | No |
| A10 | Legal-page draft banner | `src/components/pages/LegalPages.tsx` + `src/i18n/index.tsx` | DRAFT | No |
| A11 | Retention table | `docs/RETENTION.md` | DRAFT | n/a |
| A12 | Breach runbook | `docs/BREACH_RUNBOOK.md` | DRAFT | n/a |
| A13/A14 | Incident/CERT-In procedure and vulnerability disclosure policy | `docs/compliance/INCIDENT_AND_VDP.md` | DRAFT | n/a |

### Gaps found while indexing (for counsel and the product owner)
- **G1** There is no standalone "takedown process" page. Only a request form on people pages (`POST /people/requests`, kinds correction/takedown/other, with a "hide photo now" option). A public page describing who handles requests, timelines and appeals is missing. Counsel to say what it must contain.
- **G2** The grievance officer contact is a placeholder on a reserved-invalid domain. It is shown to users through `GrievanceContact.tsx`. It must not be presented as real.
- **G3** The signup notice does not name the Data Fiduciary (operator not chosen; see `docs/decisions/01-operator-options.md`). A notice normally has to say who is asking. [VERIFY WITH COUNSEL]
- **G4** Notices say "the retention table" but the table is not user-facing. Decide whether to publish it.
- **G5** Telugu on all notices is machine-assisted. DPDP-style requirements on language of notice [VERIFY WITH COUNSEL] (see question B8 below).
- **G6** Notices mention "grievance officer" while the DPDP Rules language (per the PIB explainer) is a designated officer or a Data Protection Officer. Align terms after counsel decides which role applies.

## (b) DPDP Act 2023 and Rules: applicability questions for counsel

What I could verify from a primary government source this session:
- **[PRIMARY-READ]** PIB explainer "DPDP Rules, 2025 Notified", 17 Nov 2025: https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf . It states: the Rules were notified on 14 November 2025; there is an eighteen-month period for phased compliance; every Data Fiduciary must issue a separate consent notice, clear, with the specific purpose; Consent Managers must be India-based companies; breach: affected individuals informed without delay in plain language (what happened, impact, steps taken, contact details); every Data Fiduciary must display contact information for queries, which may be a designated officer or a DPO; Significant Data Fiduciaries face independent audits and impact assessments; access/correction/erasure requests must be answered within ninety days; the Data Protection Board is digital with four members; appeals go to TDSAT; for a child's data, verifiable consent of a parent or guardian is required unless processing relates to essential services such as healthcare, education or real-time safety; penalty bands up to 250 crore (security safeguards), 200 crore (breach notification, children), 50 crore (other).
- **[SECONDARY]** Law-firm and news summaries (Bar and Bench, SCC Online, Mondaq, AZB, Storyboard18) report: Board intimation without delay then a detailed report within 72 hours; a staggered commencement with the later phase at about 18 months (one source gives 12 May 2027; sources differ on 13 versus 14 November for notification). **Not read in the gazette.** The gazette text, rule numbers and exact phase dates are unverified.
- **Not verified at all:** the DPDP Act 2023 section text (I did not fetch India Code), rule numbers, Significant Data Fiduciary thresholds, any exemption for the State or for research/statistics, the notified commencement date of each Act section.

Questions (all answers [VERIFY WITH COUNSEL]; the "why we ask" column is engineering context, not a legal view):

| # | Question | Why we ask / our facts |
|---|---|---|
| B1 | Is the operator a Data Fiduciary for signup, household and issue data? Are SMS/IVR/WhatsApp/cloud vendors Data Processors, and what must the processor contracts say (deletion on our schedule, sub-processors, breach notice)? | We choose purposes and means; vendors send OTPs and host data. Retention table assumes processors delete on the same schedule. |
| B2 | Which commencement phases apply to us, and on what dates? Which duties bind us before the later phase? | PIB says phased over 18 months; exact dates unverified. Pilot date may fall in the interim. |
| B3 | Could we be notified as a Significant Data Fiduciary (volume, sensitivity, risk to democracy/electoral integrity)? What would DPO-in-India, independent audit and impact assessment require of us? | We hold opinion-survey data adjacent to elections; scale is pilot (3 mandals) then state-wide. |
| B4 | Is a Consent Manager needed or useful? Is our own notice-and-consent flow sufficient? | We run our own versioned notices and consent records. |
| B5 | Is our signup notice a valid "separate, clear" notice with specified purpose? What must be added (identity of fiduciary, rights, how to withdraw, how to complain to the Board, language options)? | Draft A1. See gaps G3, G5. |
| B6 | Children: is our design (child under 18 added as a dependent by a parent; year of birth plus relation only, no name; no account; no survey question) within the verifiable-parental-consent rule? What counts as "verifiable" when the adult is identified only by phone OTP and PIN? Does any carve-out apply, and does not storing a name change anything? | A3. Our parent is a phone-verified adult, not ID-verified. We never track or target the child. |
| B7 | Persons with disabilities / lawful guardians: any duty when an adult is enrolled by a volunteer or by an SHG on their behalf? | Assisted participation is Phase 3 and still an open question in DESIGN_2028 section 8. |
| B8 | Must notices be offered in English and in the languages of the Eighth Schedule that users use? Is Telugu-plus-English enough for AP and Telangana? What standard of translation review is expected? | Telugu is machine-assisted today. |
| B9 | Data Principal rights: do the 90-day figure and any shorter internal SLA (we propose acknowledge 3 days, resolve 30 days) conflict with anything? How do we authenticate a rights request by phone-only users? | `grievance_officer.json` sets 3 and 30 days. Rights request channel does not exist yet. |
| B10 | Right to nominate: what must we build? | Not built. |
| B11 | Cross-border: do we transfer personal data outside India (any vendor, any CDN, any backup)? What restrictions might the Central Government impose? What do we do if a vendor stores outside India? | We intend India-region hosting; CERT-In log rule also requires logs in India (see (e)). |
| B12 | Breach: when is a breach notifiable to the Board and to principals? Format and timelines? Who signs? Is the plain-language Telugu notice in `BREACH_RUNBOOK.md` adequate? | Runbook placeholders: Board "without delay" then 72 hours (SECONDARY). |
| B13 | Retention: confirm each row marked [VERIFY] in `docs/RETENTION.md`, in particular the 3-year consent evidence period, 7-year audit log, 180-day security logs, and whether erasing a child's record at 18 versus retaining proof of parental consent is consistent. | A11. |
| B14 | Is a Data Protection Officer mandatory for us, or only a designated contact? Must the officer be based in India, report to the board? (The PIB text says every fiduciary must publish a contact that may be a designated officer or a DPO; whether a DPO is compulsory only for Significant Data Fiduciaries is not stated there and is unverified.) | See (f). |
| B15 | Exemptions: does any exemption for processing for research/statistics, or for State instrumentalities, apply to us? We do not assume any. | Depends on the operator model (see decision memo). |
| B16 | Public-record data: people pages (members, contestants, photos) rely on publicly available data. What basis applies to publishing photos and declared details of public figures, and what is the takedown standard? | GAP_AUDIT section 3 flagged photos. A8. |
| B17 | Legitimate-use versus consent: is consent the only basis for issue reports, or do other lawful uses apply (for example voluntarily provided data)? | Currently everything is consent-based. |
| B18 | Voice: IVR voice notes are stored as media. Are recordings of voice personal data requiring special handling? (Design avoids voiceprint biometrics.) | DESIGN_2028 3.1 and 3.9. |
| B19 | Aadhaar: confirm that never storing Aadhaar, and storing only a yes/no attestation for T2, keeps us outside the Aadhaar Act restrictions. | DESIGN_2028 3.1 cites ss.8/29 as [VERIFY]. |
| B20 | RTI: is the operator a public authority under the RTI Act in any of the operator models? | Operator-dependent. |

## (c) IT Act s.79 intermediary duties, takedown and appeals

Verified from a primary source this session:
- **[PRIMARY-READ, via search result snippets of the MeitY-hosted rules; full text not read]** IT Intermediary Guidelines and Digital Media Ethics Code Rules 2021 consolidated text is on MeitY: https://www.meity.gov.in/static/uploads/2024/02/Information-Technology-Intermediary-Guidelines-and-Digital-Media-Ethics-Code-Rules-2021-updated-06.04.2023-.pdf . The search summary of it said: grievance officer acknowledges within 24 hours and resolves within 15 days; some removal complaints within 72 hours; appeal to a Grievance Appellate Committee within 30 days. **I did not read the PDF myself, so treat these numbers as [SECONDARY]. Counsel to confirm against the current consolidated text and any later amendments.**
- Section 79 safe-harbour conditions: **[MEMORY]**, not verified here.

Mapping of our features to the workflow (all [VERIFY WITH COUNSEL]):

| Duty (as we understand it) | Our feature | Status | Gap |
|---|---|---|---|
| Is the platform an "intermediary" for user-generated issue reports and comments? | Issue reports (public feed), comments, photos | Unknown | C1: counsel to decide; also whether we are a "significant social media intermediary" (almost certainly not at pilot scale; threshold unverified) |
| Publish rules and a user agreement telling users not to post prohibited content | Terms section "Reports you submit" (A6) | DRAFT | Text is short; align with rule list counsel gives |
| Grievance officer, details published, acknowledge and resolve in set times | `grievance_officer.json` placeholder | Not appointed | G2 |
| Takedown on notice from a court or appropriate government agency; time limits | `POST /people/admin/takedowns`, moderator hide, issue moderation | Engine exists | No intake path for government/court orders; no log format; see C3 |
| Notice to user when content is removed, with reasons, and a way to appeal | Moderation consoles (Wave 4) | Partly | C4: confirm the user is told why and how to appeal; appeal reviewer must be a different person |
| Monthly compliance report | none | Missing | C5: only if counsel says it applies |
| Preserve records for authorities | audit log, retention rules | Partly | C6: retention conflicts with data-minimisation; counsel to set the duration |
| Respond to lawful requests from law enforcement | none written | Missing | Need a written law-enforcement and court-order policy, transparency report (DESIGN_2028 3.10) |

Questions: C1 intermediary status and safe-harbour conditions; C2 what due diligence must be shown and published; C3 how to accept and log orders from courts and agencies, and the time limits; C4 notice-and-appeal design for hidden content, including whether our own appeal step counts or the Grievance Appellate Committee route applies; C5 reporting; C6 evidence preservation duration versus our retention table; C7 do we need a nodal contact for law enforcement.

### Defamation exposure for issue reports naming individuals [VERIFY WITH COUNSEL]
Facts: Terms tell users not to name private individuals; moderation has a lexicon; issue reports about a department or official are the product. Questions: D1 where is the line between reporting a public servant's failure and defamation; D2 does intermediary safe harbour cover us if we pre-moderate or edit; D3 should we auto-hold reports naming a private individual until a moderator reads them; D4 what notice-and-counter-notice process for the named person; D5 criminal defamation and our exposure as operator; D6 should reports about officials by name be allowed at all in the pilot. Engineering default until counsel answers: department-level display (DESIGN_2028 G1), no person names in public text.

## (d) Model Code of Conduct and survey-publication rules: questions

Facts: the platform runs non-binding opinion surveys ("Pulse Survey"), never called a vote or an election. Election-choice surveys are off by default behind a fail-closed flag. Forecast blackout exists (DESIGN_2028 B4, E1). Dates of Telangana (late 2028) and AP (about April-May 2029) elections are **unverified** (DESIGN_2028 section 0).

Questions: E1 what restrictions apply to publishing opinion or exit polls, and for how long before and after polling; does our issue/service-topic survey fall within them; E2 does ECI or the State Election Commission need to be informed or consulted before launch (DESIGN_2028 B3), and what is the contact route; E3 does the MCC bind a private civil-society operator, a government-hosted operator, or only parties and government; E4 can government departments use the platform for consultations during the MCC period, and what self-declaration do we need (E1 decision); E5 the Representation of the People Act provisions on publishing poll results: confirm the window and the penalty; E6 must our public map and people pages go dark or add banners in the election period; E7 how to treat local-body elections run on separate State Election Commission calendars; E8 is any stated requirement on the "blackout flag" being tied to an official calendar rather than an env var; E9 anything about paid or party-linked promotion of the platform.

## (e) Breach and CERT-In incident procedure; vulnerability disclosure

See `INCIDENT_AND_VDP.md` in this folder. Verified from the primary text, read in this session: CERT-In Directions dated 28 April 2022 under s.70B(6) IT Act, https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf .

## (f) Grievance officer / DPO role

See `GRIEVANCE_OFFICER_ROLE.md` in this folder.

## What counsel should return

1. Written answers B1-B20, C1-C7, D1-D6, E1-E9.
2. Redlined EN text for A1-A3, A5-A8 and A10, and approval or edits for the TE text via a named Telugu legal-language reviewer.
3. A decision on which role to appoint (grievance officer, DPO, both) and its required qualities.
4. A signed review note per artefact (name, date, version, hash of the reviewed text) to be stored under `docs/compliance/signoffs/` by a human. Statuses change only after that.

Cover brief to send with this pack, plus grievance officer appointment steps: [COUNSEL_ENGAGEMENT_BRIEF.md](COUNSEL_ENGAGEMENT_BRIEF.md) (draft, nothing sent).
