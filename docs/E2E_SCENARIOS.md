# E2E Scenarios

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
