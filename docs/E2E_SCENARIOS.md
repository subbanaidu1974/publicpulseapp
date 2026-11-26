| E2E-20 | UI | Mobile viewport (375px) navigation | No horizontal scroll on home, elections and analytics; menu usable || E2E-19 | UI | Admin data status needs a server-verified admin session | No session or unconfirmed session is denied; only a 200 from the server admin check shows per-source status || E2E-18 | UI | Methodology and sources page with public data status | Page reachable; per-source status table shown; no synthetic survey stats || E2E-16 | UI | Survey validation: missing required field, duplicate submission | RETIRED with E2E-15 (S-124) || E2E-15 | UI | Citizen takes survey (valid) | RETIRED: legacy survey removed (S-124). Survey tab is an honest coming-soon page (E2E-139) || E2E-13 | UI | Map layer switch (winner → margin → turnout) | RETIRED: the synthetic district map was removed (S-123). Analytics is covered by E2E-138; a real choropleth returns with committed boundaries |# E2E Scenarios

Each scenario has an ID used as a tag in `e2e/` specs (`@E2E-xx`). Status is tracked in `docs/stories/tracker.json`.
Layers: **API** = HTTP-level test (no browser), **UI** = Playwright browser.

| ID | Layer | Scenario | Expected |
|---|---|---|---|
| E2E-01 | API | `GET /api/v1/states` | Returns AP and TG with seat counts 175/25 and 119/17 |
| E2E-02 | API | `GET /api/v1/elections?state=TG&year=2023&type=assembly` | 119 results, winners by constituency, INC largest party |
| E2E-03 | API | `GET /api/v1/elections/AP/summary?year=2024&type=assembly` | Party seat tally sums to 175; alliance aggregation endpoint returns TDP+JSP+BJP total |
| E2E-04 | API | `GET /api/v1/elections/AP/swing?from=2019&to=2024` | Swing per party, sums to ~0 pp |
| E2E-05 | API | `GET /api/v1/elections/TG/marginal?threshold=2` | Only seats with margin < 2% of votes |
| E2E-06 | API | `GET /api/v1/census/TG/districts` | Returns census-year-tagged district rows incl. population, literacy, SC/ST % |
| E2E-07 | API | Invalid state / year → 400/404 with JSON error | No stack traces |
| E2E-08 | API | Data quality gate over all generated snapshots | Seat counts, unique ids, margin ≤ votes |
| E2E-09 | UI | Open home; switch state AP→TG | Header, headline numbers, and map change; URL has `?state=TG`; choice persists on reload |
| E2E-10 | UI | Elections page: choose TG 2023 assembly | Seat tally chart + table; "Source: ECI" shown |
| E2E-11 | UI | Toggle alliance view for AP 2024 | Alliance seats shown, caveat text visible |
| E2E-12 | UI | Search a constituency by name (English and Telugu) | Profile opens with history, census context, survey card |
| E2E-13 | UI | Map layer switch (winner → margin → turnout) | Legend updates, keyboard focus reachable, table fallback available |
| E2E-14 | UI | Compare two constituencies across states | Side-by-side with sources |
| E2E-15 | UI | Citizen takes survey (valid) | Submission accepted, thank-you, results gated until n≥30 |
| E2E-16 | UI | Survey validation: missing required field, duplicate submission | Inline errors; duplicate rejected |
| E2E-17 | UI | Language toggle EN ↔ తెలుగు | Nav and key labels translate; persists |
| E2E-18 | UI | Demo-data badge on synthetic survey stats | Badge visible; methodology link works |
| E2E-19 | UI | Admin login → data refresh status page | Shows per-source last-updated; non-admin blocked |
| E2E-20 | UI | Mobile viewport (375px) navigation | No horizontal scroll, menu usable, map table fallback |
| E2E-21 | UI | Accessibility smoke (axe) on home, elections, constituency | No critical violations |
| E2E-22 | UI | Offline/slow data: API 500 on elections | Friendly error + retry, no blank page |
| E2E-23 | Pipeline | Ingest from fixture CSV → snapshot | Normalised JSON equals golden file; re-run idempotent |
| E2E-24 | Pipeline | Census ingest with missing API key | Falls back to CSV fixture, logs warning, exit 0 |

## 2028 civic-platform scenarios (planned, see DESIGN_2028.md v2.1)

| ID | Layer | Scenario | Expected |
|---|---|---|---|
| E2E-25 | API | Sign up with mobile OTP | Account at T0; stored phone value is a keyed hash, never the clear number in the DB or logs |
| E2E-26 | API | Recently re-issued number; account under 14 days old | Flagged by number intelligence; not eligible for any survey |
| E2E-27 | API | Two adults link to one SIM, each sets a PIN | Both accounts exist; each answers separately |
| E2E-28 | API | 6 wrong PINs | Lockout after 5; SIM holder told of the lockout but never sees a PIN |
| E2E-29 | API | One volunteer attests residence | Stays T1; two independent attestors move it to T2; per-volunteer daily quota enforced |
| E2E-30 | UI | Head invites an adult | Invitee sees notice before any data is stored; invite expires at 72h; "I did not agree" report works; head never sees their answers |
| E2E-31 | UI | Add a minor dependent | Consent recorded; only year of birth stored; no survey access; erased at 18 |
| E2E-32 | API | Hamlet search to village to constituency at two boundary versions | Correct unit per effective date |
| E2E-33 | UI | Report an issue (Telugu text, photo, GPS) near an existing one | Merged; me-too counts once per person and is rate limited |
| E2E-34 | API | Officer marks resolved; reporter silent past the window | Sampled neighbour confirmation decides; out-of-jurisdiction issue is re-routed |
| E2E-35 | API | Public issue metrics | Department-level by default; officer view needs jurisdiction tag and shows rebuttal field; bulk feed identical for every caller |
| E2E-36 | UI | Report naming an individual | Held for review; appeal path works; takedown logged |
| E2E-37 | API | Creator edits wording or cancels without a reason | Rejected; cancelled surveys stay in the public registry; quota enforced per party |
| E2E-38 | API | Same person submits twice | Second rejected (single-shot) |
| E2E-39 | API | Inspect response store and logs (app/web channel) | No timestamps, no person IDs, random UUIDs; has_responded and response on separate services with separate keys |
| E2E-40 | API | Voice-channel respondent on a political survey | Refused; allowed on issue/service topics, labelled platform-linkable, separate stratum |
| E2E-41 | API | Queries across village, mandal and constituency; request live counts | Hidden cells not derivable; minority option below threshold suppressed; live counts refused |
| E2E-42 | API | Fetch results | Weighted and unweighted views, quality score, sample size and method link present |
| E2E-43 | API | Election-choice survey during blackout flag; flag service down | Hidden/disabled; fail-closed when flag unknown |
| E2E-44 | UI | Open a bill consultation | EN and తెలుగు plain-language summary, clause feedback, audio per affected group |
| E2E-45 | API | 500 near-identical comments in a minute | Clustered and flagged, counted once per person; closing report states review coverage and department response |
| E2E-46 | API | Unverified sender, or one without FIDO2, publishes | Blocked; verified sender needs a second approver; payload signature verifies against the pinned key |
| E2E-47 | UI | User disables Service category, sets quiet hours | Not delivered; emergency still goes out via SMS fallback; no message asks for OTP or login |
| E2E-48 | API | MCC calendar active; scheme announcement sent | Blocked and logged publicly; only pre-cleared templates with a self-declaration pass |
| E2E-49 | API | Politician requests data outside own constituency | 403 |
| E2E-50 | Pipeline | Count-day feed fixture; feed unavailable | Signed static snapshot served; fallback shown with delay label |
| E2E-51 | API | Tamper with an audit-log entry; read sensitive data | Chain verification fails; the read is logged; external anchor mismatch detected |
| E2E-52 | API | Account deletion request | Phone copy deleted, has_responded redacted, audit log redacted not removed |
| E2E-53 | API | Retention job after survey close | Phone/residence data older than the retention window removed |
| E2E-54 | UI | First sign-up | Telugu/English notice and consent shown and recorded with version; grievance contact visible |
| E2E-55 | Pipeline | Missed call, Telugu IVR menu, voice-note issue | Issue created; reference SMS sent; PWA lite under size budget |
| E2E-56 | API | OTP flood from one ASN | Capped; SMS budget not exhausted; degraded mode shows a notice |
| E2E-57 | UI | Axe and Telugu screen-reader run on key flows | WCAG 2.2 AA with no critical failures; large touch targets |
| E2E-58 | Process | Release gate checklist | Threat model, red-team report and pilot skew report attached before any election-adjacent survey (manual evidence, tracked, not automated) |
| E2E-59 | UI | Volunteer records a phone-less adult's issue | Separate segment; excluded from surveys; random re-check logged |
| E2E-60 | UI | Open Elections for TG with real data | Seat, vote-share and swing charts render for assembly and Lok Sabha with table fallback; provenance banner shows TCPD; no DEMO badge |
| E2E-61 | UI | Forecast endpoint returns a projection | Disclaimer 'model projection from past results' visible; seat ranges, safe/lean/toss-up counts, toss-up table and back-test line shown; no 'poll' or 'prediction' wording outside the server disclaimer |
| E2E-62 | UI | Forecast endpoint reports blackout | Only a blackout notice is shown; no alliances, seats or disclaimer-bearing projection |
| E2E-63 | UI | Toggle to Telugu on Elections | Forecast, trend and provenance labels render in Telugu |
| E2E-64 | UI | Axe on Elections with charts and forecast | No critical WCAG 2.x A/AA violations |
| E2E-65 | UI | Elections at 375px | No horizontal page overflow |

## Gap-audit scenarios (planned, from the Nov 2026 gap audit)

| ID | Layer | Scenario | Expected |
|---|---|---|---|
| E2E-66 | API | Delete /api/admin/config and header-trusted admin; secrets never returned or written at runtime | Request with spoofed x-user-role gets 404/401; no endpoint returns SMTP or API secrets |
| E2E-67 | API | Delete /api/send-otp mail relay; never log OTPs or phones; remove TLS-verification bypass | Route absent; log scan finds no OTP/phone; SMTP code removed |
| E2E-68 | API | Replace client-side legacy login/admin with server sessions (or remove it); no seeded accounts or role-switch | No plaintext accounts in bundle; admin pages need a server-verified admin session |
| E2E-69 | API | Security headers, CSP, HSTS, trust-proxy, CORS policy and public API rate limits/caching | Response headers present; burst against /api/v1 gets 429; CSP report-only clean |
| E2E-70 | API | Production startup guards: refuse dev key provider, dev OTP flag, DEMO geo seed, demo data when NODE_ENV=production | Server exits non-zero in production with any dev provider or demo dataset |
| E2E-71 | API | Webhook auth for missed-call/IVR (HMAC or allow-list); never return callId to caller; PIN by default | Forged IVR call for a known phone is rejected; no callId in the response |
| E2E-72 | API | Scope JSON body parsers per router; 1 MB base64 photo accepted, global default kept small elsewhere | 1 MB base64 upload succeeds; oversize elsewhere gets 413 |
| E2E-73 | API | Secret scanning (gitleaks) and secrets-manager config; remove unused genai/nodemailer, pin engines, audit and Dependabot | CI fails on a planted secret; npm audit clean at high; engines enforced |
| E2E-74 | API | Login/OTP hardening: per-phone+person+source keys, per-purpose OTPs, weak-PIN blocklist, logout, session list/revoke, shorter TTL | Flooding one phone cannot lock the owner; weak PIN rejected; logout revokes server session |
| E2E-75 | API | Trusted proxy and device attestation (Play Integrity/App Attest) for the app channel; edge-supplied ASN | Spoofed x-device-id/x-asn headers no longer change limits |
| E2E-76 | API | Invite and SMS abuse caps: per-head daily invites, per-target-number cap, global SMS budget | 11th invite/day refused; repeat to one number refused |
| E2E-77 | API | Real number-intelligence vendor adapter with failure policy | Churned/VoIP numbers flagged via adapter; vendor outage degrades safely |
| E2E-78 | API | Production SMS provider adapter (DLT templates, delivery receipts, cost budget) | Provider contract test passes; OTP sent through DLT template |
| E2E-79 | API | KMS/HSM key provider, per-purpose keys and rotation/re-hash plan | Master key never in app env; rotation test re-hashes phones |
| E2E-80 | API | Reconcile THREAT_MODEL and RELEASE_GATE with the code; fix claims (ASN, logs, keys, anchor) | Every [DONE] claim maps to a test; mismatches fixed or marked |
| E2E-81 | API | Job scheduler for retention purge, 18th-birthday erasure, invite expiry, audit anchoring and chain verification | Jobs run on schedule, are audited, and alert on failure |
| E2E-82 | API | Observability: structured logs, request ids, /healthz and /readyz (DB + audit chain), metrics and alerts | Readiness fails when audit chain breaks; request id in every log line |
| E2E-83 | API | Encrypted scheduled backups, restore drill and key escrow runbook | Restore from backup reproduces DB; drill documented |
| E2E-84 | API | Deployment: Dockerfile, env/runbook, India-region hosting and TLS guide, E2E against production build | Container boots with NODE_ENV=production; Playwright passes against dist |
| E2E-85 | API | CI upgrades: production build, ESLint, audit, secret scan, coverage thresholds, Windows matrix | CI red on any of them failing; coverage gate on server/civic and src/lib |
| E2E-86 | API | Tracker gate reads real test results (no skips) and verifies STORY_TRACKER.md is current | Skipped or failing tagged test blocks a 'done' story |
| E2E-87 | API | Migration checksums, pre-migrate backup, rollback doc | Schema drift detected at startup |
| E2E-88 | API | Async/worker scrypt, capacity plan and Postgres/PostGIS migration path | Login p95 under load stays flat; capacity doc committed |
| E2E-89 | API | Split identity, issue and survey stores with no cross-store joins | Separate DB files/keys; cross-store join test fails by design |
| E2E-90 | UI | Real lite entry page, 2G budget measurement and load tests (OTP flood, count-day) | Lite page under 150 KB gzip on 2G profile; k6 scenario passes |
| E2E-91 | API | Scheduled data-refresh pipeline with freshness alerts and forecast-cache invalidation | Stale data raises an alert; cache refreshes after pipeline run |
| E2E-92 | API | README, complete .env.example (all CIVIC_* vars) and docs check in CI | Fresh clone follows README to a running app; env vars all documented |
| E2E-93 | API | Fix boundary fetch: DataMeet India_AC shapefile, split TG from AP, re-key to ECI/LGD codes, validate 294 ACs | 175 AP + 119 TG AC polygons join on acNo; gate fails on mismatch |
| E2E-94 | API | PC polygons from DataMeet 2019 simplified (CC0) with Wikidata QIDs; AP 25 / TG 17 | 42 PC polygons joined to LS results |
| E2E-95 | API | LGD Parquet ingest: districts (AP 28, TG 33), mandals, blocks, villages, GPs, urban bodies; effective-dated, census codes kept | Counts match LGD (688/621 mandals, ~29k villages); rerun idempotent |
| E2E-96 | UI | LGD village/ward to AC and PC mapping; flag ACs without rural rows; check part-mandal ACs against the 2008 ECI order | Every AC has villages or wards; 12 flagged ACs reviewed |
| E2E-97 | API | Reservation (SC/ST/GEN) and PC link per AC from 2008 constituency table | Reservation shown on constituency page |
| E2E-98 | API | Telugu name gazetteer: Wikidata (districts, mandals, ACs), LGD TG villages, AP villages from OSM/Wikidata, gaps flagged | Coverage report per level; missing names flagged not guessed |
| E2E-99 | API | Census 2011 PCA ingest at district, mandal and village with LGD census-code crosswalk; remove demo census | Real census replaces demo; district totals match published |
| E2E-100 | API | Old-to-new district crosswalk (AP 13 to 26 to 28; TG 10 to 33) for comparable history | 2014 and 2024 results aggregate to either district vintage |
| E2E-101 | API | Electors by AC (CEO PDF parser, SSR 2025) with turnout, NOTA and gender fields in the API | Turnout % per seat returned; source PDFs fetchable (CEO sites unreachable in checks) |
| E2E-102 | API | Seats API carries district, electors, Telugu name for AP and LS (not only TG assembly) | /elections seats return district and acNameTe for every seat |
| E2E-103 | API | District boundary polygons for AP 28 / TG 33 (dissolved from mandals or OSM) | Districts render on map with codes joined |
| E2E-104 | API | Mandal boundary polygons with licence review (OSM ODbL or other) | Mandal layer loads; attribution shown |
| E2E-105 | API | Village boundary polygons: licence decision (SHRUG is CC BY-NC-SA) or alternative source | Licence cleared or village map stays point/table based |
| E2E-106 | API | Polling-station reference list (number, name, location only); never ingest electoral-roll PDFs | No voter names/addresses in any store; legal guard test |
| E2E-107 | API | Boundary versioning and post-census delimitation readiness | Two boundary versions selectable by date |
| E2E-108 | API | Per-dataset provenance manifest (source, licence, checksum, asOf) shown on API envelopes | Every API response carries source and asOf |
| E2E-109 | UI | Licence compliance register and attribution page (TCPD, DataMeet, ODbL, CC BY-SA, Esri) | Attribution page lists every dataset; CI checks register vs manifest |
| E2E-110 | UI | LS-to-assembly segment mapping and split-voting endpoint | /split-voting returns per-AC LS vs assembly winners |
| E2E-111 | UI | Real choropleth map (AC and district) replacing the tile grid; table fallback; self-hosted Leaflet CSS; no third-party map tiles (S-190 removed Esri; S-191 adds a self-hosted OpenStreetMap background, tested present and with the file missing) | Map colours seats by selected metric; keyboard/table alternative; no third-party CSS |
| E2E-112 | UI | Drill-down map: state to district to constituency to mandal to village with population and issue overlays | Clicking a district opens its constituencies; breadcrumb works in Telugu |
| E2E-113 | UI | Constituency profile: boundary map, population, electors, history, current member, civic issue aggregates | Profile shows all sections with sources; issue cells suppressed under 30 |
| E2E-114 | UI | Mandal and village profile pages (population, SC/ST, literacy, linked constituency, issues) | Village page resolves from search; shows census code and constituency |
| E2E-115 | API | Geo search API and constituency endpoints (/geo/units, /constituencies/:state/:acNo) in EN/Telugu | Search by Telugu or English name returns the unit tree |
| E2E-116 | API | Hamlet gazetteer review workflow and real import replacing DEMO data | Unreviewed hamlets hidden; reviewer queue works |
| E2E-117 | API | LGD-to-ECI constituency link table, effective-dated | Issues aggregate to the election constituency |
| E2E-118 | API | Canonical party registry: aliases, Telugu names, hand-curated colours, founding year, website, Wikidata QID, merger history | Every party code in elections.json resolves; one palette app-wide |
| E2E-119 | API | Party flags and symbols with per-file licence/author/attribution; neutral text chip where no free file exists | Flag shown only if licence recorded; attribution page generated |
| E2E-120 | API | Per-year alliance dataset (AP 2014/2019/2024, TG 2014/2018/2023, LS years) with sources and pre-poll vs hindsight label | Alliance view works for every election with a cited source |
| E2E-121 | UI | Party profile page: seats and vote-share history, alliances, leaders, symbol | Page per party in EN/Telugu with sources |
| E2E-122 | API | Party leaders and office holders (CM, deputy CM, speaker, party presidents, ministers), curated and dual-sourced with dates | Each person has two cited sources and an asOf date |
| E2E-123 | API | Current MLA/MP roster: ECI results + minimal sansad.in fields + by-election/defection overlay with citations | 119 TG and 175 AP seats each show a current member; no contact/DOB/family fields stored |
| E2E-124 | UI | Contestant profile: name, party, votes, position, sex, age, incumbency per election (TCPD/ECI) | Every contestant has a profile page; no unsourced fields |
| E2E-125 | API | Winner photos from Wikimedia Commons with licence, author, attribution and takedown; initials avatar otherwise | Photo shown only with an accepted licence and credit; others show avatar |
| E2E-126 | API | Affidavit link-outs (MyNeta/ECI) with neutral layout; no scraping; ADR written-consent request for any bulk use | Link shown for every contestant; no criminal-case lists or scores |
| E2E-127 | API | Party-switch / turncoat records, citation-only (Speaker/ECI/news) | Each switch has a citation and date |
| E2E-128 | API | Correction and takedown channel for person data and photos | Takedown request removes item within SLA and logs it |
| E2E-129 | UI | MCC neutrality rules for candidate/party/leader pages: identical layout, no rankings, blackout hides promotions | Layout test proves identical sections for every candidate |
| E2E-130 | API | By-election and re-poll tracking | Jubilee Hills 2025 by-election appears in seat history |
| E2E-131 | UI | Pre-2014 undivided-AP history mapping and AP/TG LS 2014 split | 2009 and 2014 history selectable with comparability notes |
| E2E-132 | API | Per-candidate and per-party assembly vs Lok Sabha comparison; incumbency analytics | Charts with sources and caveats |
| E2E-133 | API | Calendar-driven, fail-closed election-window service (forecast, surveys, notifications) | Forecast hidden when calendar unknown; flag source audited |
| E2E-134 | API | Forecast product review: skill warning, calibration and cache invalidation | Back-test shown beside every headline; refresh clears cache |
| E2E-135 | UI | Turnout, NOTA and gender-turnout analytics page | Turnout by seat/district with sources |
| E2E-136 | API | Golden tests for real data (totals vs ECI by year); comparability notes for swing | Seat tallies pinned per election; swing endpoint carries notes |
| E2E-137 | API | Share cards with provenance and misinformation guardrails | Card image includes source, date and disclaimer |
| E2E-138 | UI | Retire staticData and the synthetic constituency profiler; Telangana parity for Home, Analytics and Constituencies | No Math.random data; every tab state-aware or removed |
| E2E-139 | API | Retire the legacy survey/admin portal (or move behind Phase 2 anonymous surveys); drop fake counters and leader preference | No localStorage tallies; no vote/poll wording or leader-preference question |
| E2E-140 | API | Remove hard-coded reports, news, testimonials and hotlinked media | No third-party media URLs in source |
| E2E-141 | API | i18n completeness: key-parity test EN/TE, localised error codes, translate all hard-coded labels | Test fails on missing te key; API errors render in Telugu |
| E2E-142 | API | Product naming, metadata, hreflang, Open Graph; README rewrite | Title/meta localised; no AI Studio leftovers |
| E2E-143 | API | Banned-wording copy lint (vote/ballot/result for surveys) in CI | CI fails on banned words in public pages |
| E2E-144 | UI | Privacy policy, terms, third-party consent notice and who-sees-what screen | Policy page shipped in EN/TE; the map-tile consent banner was removed with the tiles (S-190), the test now asserts no third-party request and no banner |
| E2E-145 | API | Self-hosted Telugu font subset; low-end Android test | Telugu renders without external font calls |
| E2E-146 | API | Login person-picker for multi-adult SIMs | Shared SIM login selects the adult then PIN |
| E2E-147 | UI | PIN recovery UI using OTP | Recovery resets PIN and revokes sessions |
| E2E-148 | UI | Residence declaration and hamlet search UI (T1) | User picks village/hamlet; tier shows T1 |
| E2E-149 | UI | Attestation and volunteer screens (T2) | Two attestors move a person to T2 in UI |
| E2E-150 | UI | Accept-invite screen: notice, own PIN, decline and report-not-agreed | Invitee sees notice before any data; accept sets PIN |
| E2E-151 | API | Volunteer enrolment: adult sets own PIN and proves phone control; context persisted in table | Volunteer never types a PIN; account stays pending until OTP |
| E2E-152 | API | Issue photo and voice upload wired to /issues/media with GPS | Photo/voice attach end to end; stored through media route |
| E2E-153 | API | WebP and HEIC photo support with EXIF stripping | iPhone HEIC upload accepted and converted |
| E2E-154 | UI | Issue detail page, feed filters by village/mandal/constituency, paginated bulk export | Feed filterable; export is identical for every caller |
| E2E-155 | API | Officer/moderator consoles and audited admin role grants with MFA; unify roles tables | Grant needs admin + second approver; one roles source |
| E2E-156 | API | Verified government officer onboarding (letter and domain check) | Officer role requires verified department email |
| E2E-157 | UI | Moderation lexicon curation workflow, queue UI and false-positive metrics | Moderators manage lexicon versions; metrics visible |
| E2E-158 | API | Erasure completeness for all issue tables and a dump-all-tables test | After delete no table holds the person id |
| E2E-159 | API | Audit log: public redacted view, real external anchor sink, privileged-read calls wired | Anchor mismatch alarms; every privileged read logged |
| E2E-160 | API | Politician reply role, scheme tags and grievance-system adapter | Replies public and scoped; adapter contract test |
| E2E-161 | API | IVR upgrades: recording fetch, full category set, persisted call state, unified lockout | Voice note stored as media; restart keeps call state |
| E2E-162 | API | Media hardening: encryption at rest, GPS rounding, AV scan, retention alignment | Files encrypted; GPS rounded to policy |
| E2E-163 | API | Icon-led categories, trust-tier badges, category parity across web and IVR | Nine categories everywhere; tier badge visible |
| E2E-164 | API | Household: recipient confirms head transfer; dependent caps; re-invite cooldown | Transfer needs recipient accept |
| E2E-165 | API | Counsel-reviewed bilingual notices; grievance officer/DPO appointed; breach and CERT-In procedure | No DRAFT status left; officer contact real |
| E2E-166 | API | Recorded Telugu audio per dialect with linguist review | Audio files exist and pass review |
| E2E-167 | API | Operator, funding and legal-structure decision (design gate) | Decision recorded in DESIGN_2028 section 8.1 |
| E2E-168 | API | Release gate owners, dates and evidence collection; red-team and pilot skew evaluation scheduled | All 18 gate rows have owner and date |
| E2E-189 | API | Email sign-up, sign-in and PIN recovery (S-165): hashed and encrypted storage, no clear address anywhere, email_only flag, throwaway and Gmail-alias handling, limits, key rotation | tests/civic/identity.email.test.ts, tests/civic/providers/rehash.email.test.ts |
| E2E-190 | UI | Email sign-up and sign-in screens in English and Telugu; email-only account not survey-eligible | e2e/civic-email-demo.spec.ts |
| E2E-191 | API | Demo personas (S-166): off by default, never in production, correct roles, no phone, email or PIN | tests/civic/demo.test.ts |
| E2E-192 | UI | Demo sign-in panel: one click as admin, role limits, reuse of the same account | e2e/civic-email-demo.spec.ts |
| E2E-193 | API | Add a phone to an email-only account (S-167): code, flags, one phone, SIM cap | tests/civic/identity.email.test.ts |
| E2E-194 | UI | Add-phone panel shown only to email-only accounts and works end to end | e2e/civic-addphone.spec.ts |
| E2E-195 | API | Role matrix over all demo personas (S-168) | e2e/civic-persona-matrix.spec.ts |
| E2E-196 | Unit | Email notification channel: off by default, opt-in, push-failure fallback, emergency, no links, Telugu body (S-184) | tests/civic/notify/email.channel.test.ts |
| E2E-197 | UI | Email channel switch in notification settings, hidden for phone-only accounts (S-184) | e2e/notify-email.spec.ts |
| E2E-198 | Unit | Broadcast polls: roles, pending per person, completion required, validation, hidden results, no link to accounts, close, limits, wording refusals (S-185) | tests/civic/broadcast.test.ts |
| E2E-199 | UI | Admin writes, pushes, closes a poll on screen; a party-choice poll is refused with the reason (S-185) | e2e/broadcast-poll.spec.ts |
| E2E-200 | UI | Blocking poll dialog: inert app, Escape ignored, completion rules, release on submit, Telugu, axe, release on close, admin routes closed to users (S-185) | e2e/broadcast-poll.spec.ts |
| E2E-201 | UI | Scheduled start: admin schedules and cancels on screen; a poll scheduled seconds ahead appears on an open page by itself; unit rules in tests/civic/broadcast.test.ts (S-186) | e2e/broadcast-poll.spec.ts |
| E2E-202 | UI | Recorded journey, admin and user videos: admin writes and pushes a poll, user blocked then answers and reaches the app, admin sees the response and closes it (S-185, S-186) | e2e/broadcast-poll.journey.spec.ts |
| E2E-203 | UI | Parties page (#/analytics/parties): every party with a seat or 1% of the vote, seats, contested, votes and share per election, from the data only; NOTA not a party; 404 for an unknown state; Telugu names in Telugu; unit rules in tests/api/party-history.test.ts (S-195) | e2e/analytics.spec.ts |
| E2E-204 | UI | Electors page (#/analytics/electors): all constituencies with men, women, third gender, total and women per 1,000 men from the 2024 general-election rolls; totals match the API; sort by share of women; age shown as not available, never estimated; Telugu (S-197) | e2e/analytics.spec.ts |
| E2E-205 | UI | Winner photo on the constituency profile: served from our own server, listed files only (path tricks 404), credit and licence shown, no request to any other host, no photo block for a seat without one (S-198); data checks in tests/pipeline/winner-photos.test.ts | e2e/profiles.spec.ts |
| E2E-206 | UI | Party card on #/analytics/parties shows the party head with a free-licence photo, role, credit and Commons link, from our own server; unknown photo path 404; a party without a photo shows none (S-199); data checks in tests/pipeline/winner-photos.test.ts | e2e/analytics.spec.ts |
| E2E-207 | UI | Photo self-upload on a constituency profile: the form explains review and privacy, refuses without consent, accepts a JPEG, says it is held for review, and the photo is not shown or listed meanwhile; server rules (type by bytes, size, metadata removal, honeypot, approval, pause, takedown) in tests/geo-api/photo-submissions.test.ts and tests/geo-api/photo-gate.test.ts (S-200) | e2e/profiles.spec.ts |
| E2E-208 | UI | Photo review screen in the admin console: the queue needs an admin sign-in; an admin sees who sent the photo, the seat's winner, the private contact and the picture, approves it with a note, the photo then appears in the public photo list, and Stop showing removes it (S-201) | e2e/photo-review.spec.ts |
| E2E-209 | UI | Party cards on the Parties page show the party flag or logo from our own server with a credit on a click; YSRCP's is marked identification-only (S-202) | e2e/analytics.spec.ts |
| E2E-210 | UI | The Parties page can be searched by code or name, ordered by seats, latest vote share or name, and filtered to Assembly or Lok Sabha rows; each card shows its latest figures and a vote-share bar; an empty search shows a message (S-202) | e2e/analytics.spec.ts |
| E2E-211 | UI | The panchayat page shows party totals with a banner saying they are secondary-source figures and not commission data, per-election caveats, the page or reports they were read from, a level filter, ranges where reports disagree (Telangana 2025), AP 2021 phases and turnout, AP 2026 unopposed seats and omitted disputed figures, and Telugu (S-203, S-219, S-220) | e2e/analytics.spec.ts |
| E2E-212 | Unit | The panchayat data format: not loaded while no file exists; unit-level and totals files are accepted; wrong state, missing source licence or quality, bad values, totals without evidence or a caveat, totals above the posts, and voter-level or personal fields are refused (S-203, S-219) | tests/pipeline/panchayat.test.ts |
| E2E-213 | Unit | The committed panchayat files pass the checks, are marked secondary, carry a Wikipedia revision or at least two news outlets, hold no unit-level rows, match the cited figures, show disputed figures as ranges or leave them out, and do not contain AP 2021 parishad, Telangana parishad after 2019 or pre-2014 elections (S-219, S-220) | tests/pipeline/panchayat.test.ts |
| E2E-214 | UI + Unit | On sample data: a red banner says it is invented; districts open to mandals and then to panchayats listed by name; search; the election picker; unmatched and conflicting units are reported in the place-matching line; the cycle table shows both elections, shared units and the changed-unit warning; a state with no unit file says village-level results are not loaded; Telugu directory names; unit tests cover name matching, roll-ups and trends (S-221) | e2e/analytics.spec.ts, tests/pipeline/panchayat-units.test.ts |
| E2E-215 | Unit | Sample data can never ship: no unit file exists in data/reference/panchayat, none there is marked as a sample, the server refuses a sample file unless started with PANCHAYAT_UNITS_DIR, and sample winners are all labelled SAMPLE (S-221) | tests/pipeline/panchayat-units.test.ts |
| E2E-216 | Journey (recorded) | Admin publishes a survey and the resident, volunteer, government officer and journalist demo users each see it pop up, cannot dismiss it, cannot submit until answered, reach the app after submitting and are not asked again; the admin is never blocked, sees 4 answers and closes it (S-223) | e2e/broadcast-poll.allusers.spec.ts |
| E2E-217 | E2E | Civic page tabs: the same six tabs for all five demo users with Report an issue and My reports on separate tabs, keyboard and Telugu, and the top-bar Sign in (right side of the bar, opens Civic) and Log out at desktop and phone width (S-222) | e2e/civic-tabs.spec.ts |
| E2E-218 | E2E | Media tab shell: four sections with honest empty states and no outside links or frames, keyboard and Telugu with review note, 375px with no overflow and no axe violations | S-224 |
| E2E-219 | E2E | Free media player: a chosen audio file does not autoplay, speed and time work, nothing is sent or stored; a non-media file, a bad captions file and an undecodable file each give a clear message; Telugu at 375px passes axe | S-227 |
| E2E-220 | Unit | Player logic: lowest or highest quality source, file kind from type or name, time format, allowed speeds | S-227 |
| E2E-221 | Unit | Video broadcast server: admin-only routes, a second admin must approve, every member sees live items, scheduled start, recall and refuse, safety ticks and wording checks, media address rules and host list, play counts without a person, audit, pending cap | S-230, S-237 |
| E2E-222 | Journey (recorded) | Admin proposes a video and cannot approve it; a second admin approves; the resident, volunteer, officer and journalist demo users see nothing before and a badge and New card after, play it, are not blocked; a recall removes it; members and signed-out visitors cannot reach the admin screen; the form shows the server refusals | S-230, S-237 |
