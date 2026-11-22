# Gap audit and data-source findings (Nov 2026)

Source for stories S-51 onward in `docs/stories/tracker.json` (each carries `source: gap-audit: <numbers>`). Items marked
[verified] were read in code or fetched during the audit; everything else is stated as unverified. Legal points are
research-level only and need counsel sign-off.

## 1. Gaps by area (130 found; the critical ones)

**Critical, legacy server (verified).** `/api/admin/config` trusts a client `x-user-role` header and can read or overwrite
SMTP/Web3Forms secrets; `/api/send-otp` is an unauthenticated mail relay that logs OTP and phone; SMTP TLS verification is
disabled; the legacy login and admin gate live in the browser (seeded plaintext accounts, `Math.random` OTPs).

**Other high-severity.**
- IVR/missed-call endpoints are spoofable: any phone number can drive the flow (single-adult SIMs skip the PIN).
- Volunteer enrolment: the volunteer chooses the adult's PIN and no OTP proves the adult controls the phone.
- Retention purge, 18th-birthday erasure, invite expiry and audit anchoring exist but nothing schedules them.
- Dev key provider and dev SMS provider are the defaults outside `NODE_ENV=production`; demo geo is auto-seeded into an empty DB.
- No security headers/CSP/trust-proxy; no public-API rate limits; no observability, backups or deployment story.
- Legacy analytics, constituency profiles and survey run on synthetic AP-only data (`Math.random`); the district map reads
  fields the API never returns (district, turnout, Telugu name).
- Census is demo data; no real boundaries are committed; the boundary fetch script targets URLs that now return 404.
- Alliances exist only for AP 2024; no LS-to-assembly mapping; no per-year party registry.
- Forecast blackout is an env flag and fails open; the back-test is poor.
- No UI for multi-adult login, PIN recovery, residence declaration, invite acceptance, officer/moderator consoles or issue
  photo/voice upload (the voice-note "upload" sends a fake key).

Full numbered list lives in the tracker's `source` fields; see stories S-51 to S-153.

## 2. Verified open data sources (geo and population)

| Need | Source | Status |
|---|---|---|
| Admin units (districts AP 28 / TG 33, mandals 688/621, ~29k villages, GPs, urban bodies, wards) | LGD Parquet mirror, `https://ramseraph.github.io/opendata/lgd/data/metadata.json` | Fetched; daily refresh; Telugu names only for TG villages |
| Village/ward to AC and PC | LGD `constituencies_mapping_pri` / `_urban` in the same mirror | Fetched; AP 173/175 ACs and TG 109/119 ACs have rural rows (rest urban); part-mandal ACs need a check against the 2008 ECI order |
| AC polygons | DataMeet `assembly-constituencies/India_AC.shp` (CC BY 2.5 India) | Fetched; AP and TG both under ST_CODE 28, must be split and re-keyed |
| PC polygons | DataMeet `india_pc_2019_simplified.geojson` (CC0) | Fetched; AP 25, TG 17, with Wikidata QIDs |
| Reservation and PC link per AC | DataMeet `2008-constituencies.csv` | Fetched; lists TG ACs under old AP code |
| Telugu names | Wikidata: 36/36 districts, 1,194/1,246 mandals, TG 119/119 ACs; LGD TG villages 99%, AP villages ~2% | Queried |
| Population (village level) | Census 2011 PCA via Census Digital Library, Dataful or data.gov.in | Not verified: data.gov.in returned 503; catalogue needs login; Dataful licence unknown |
| Census 2027 | Houselisting 2026, enumeration planned Feb 2027 | No results yet; reported dates conflict |
| Electors by AC | CEO PDFs (SSR 2025) | Not fetchable in checks; only the 2014 roll is machine-readable |
| Village polygons | SHRUG (CC BY-NC-SA) / Stanford | Not downloaded; the NC licence is a likely blocker |

Boundaries: the 2008 delimitation is still in force (AP 175/25, TG 119/17), so 2008 polygons are current. Districts in the
LGD mirror are AP 28 and TG 33; older datasets use 13/10 or 26/33 and need a crosswalk.

## 3. Verified sources and guardrails (people data)

- **Parties:** hand-curated registry (Wikidata colours and HQ are unreliable). Commons has free files for TDP flag, JSP flag,
  BRS flag, AIMIM flag, BSP, CPI, CPM and others; no free YSRCP or TDP symbol was found. Some files carry "insignia" or
  "trademarked" tags: use only to identify the party, never to imply endorsement. Fall back to a text chip.
- **Members:** `sansad.in/api_ls/member` (undocumented, no stated licence) returns the 2024 Lok Sabha members; its payload also
  holds phone, address, DOB and family data that must not be ingested. Wikidata MLA data is incomplete (AP constituency
  qualifier missing for most) and its party field is not "party at election".
- **Photos:** only Wikimedia Commons images (P18; about 70 of 226 AP and 65 of 131 TG people have one) with per-image
  licence and attribution. ECI affidavit photos and MyNeta are link-only: ADR forbids scraping and redistribution; the ECI
  portal blocked automated access and its terms were not read.
- **Affidavit data:** link out; never publish "criminal candidate" lists or scores; declared cases are not convictions.
- **Office holders (verified from Wikidata/Wikipedia/news, not from official sites):** AP CM N. Chandrababu Naidu, Deputy CM
  Pawan Kalyan; TG CM A. Revanth Reddy. Jubilee Hills by-election (11 Nov 2025) won by INC; ten BRS MLAs defected to INC and
  the Speaker's decisions are not fully verified.
- **DPDP:** public-record exemptions may not cover photos; add a correction/takedown channel and counsel review.

## 4. Decisions needed from a human

1. Operator, funding and legal structure (design gate, DESIGN_2028 section 8.1).
2. Census source: key-gated data.gov.in, Dataful (price?), or the Census Digital Library (login).
3. Village polygons: accept the SHRUG non-commercial licence or go without village maps.
4. ADR written consent for any bulk affidavit use; ECI affidavit portal terms.
5. Counsel review of notices and candidate/photo publication; grievance officer appointment.
6. SMS provider, number-intelligence vendor and KMS/HSM choice.
