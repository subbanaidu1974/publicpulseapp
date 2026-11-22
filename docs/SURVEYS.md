# Pulse Surveys

DESIGN_2028 section 3.3. "Pulse Survey" is an opinion survey: not an election and not a forecast. Survey copy never uses the words vote, ballot or result (use "opinion", "responses", "figures"). Every public survey payload carries `disclaimer_en` / `disclaimer_te`.

Other sections of this document (credential and responses, published figures) are written by the modules that own them. This section covers the **registry**.

## Registry (S-28, S-34; server/civic/surveys/registry.ts)

Tables live in the **survey store** (`getStore("survey")`, migration `survey_001_registry`): `surveys`, `survey_questions`, `survey_options`, `survey_versions`, `panel_reviews`, `cancellations`, `survey_registry_log`, `survey_quota_events`. People appear only as keyed pseudonyms (`survey-actor` key purpose); the registry never stores `persons.id`.

### Lifecycle

`draft` (private) -> `in_review` (public from here) -> `approved` -> `open` -> `closed`; `cancelled` from in_review, approved or open. A rejection returns a survey to `draft`.

- **Registered publicly at submission**: wording, scope, audience and close date are public as soon as the survey is submitted to review.
- **Frozen**: once submitted, nothing in the wording can change. `PATCH` answers 409 `wording_frozen`; the database also refuses (triggers). A changed wording needs a new survey. Each registered version is an immutable snapshot (`survey_versions`) whose sha256 over the canonical JSON is the `wording_hash` (`GET /surveys/:id/versions/:n`).
- **Cancellation** needs a public `reason_code` (from `data/civic/survey-policy.json`) and `reason_text`; cancelled surveys stay in the registry and the public log (`GET /surveys/registry/log`). `survey_registry_log`, `cancellations`, `survey_versions` and `panel_reviews` are append-only (triggers).
- The job `closeDueSurveys` (every minute) closes open surveys at `closes_at`; approved or in-review surveys whose window passes unopened are closed as expired.

### Creators and quotas (decision A2)

Creation needs a role: `politician` (the role's `department` carries the party code, e.g. `TDP`; parties from `data/reference/parties.json`), `officer` (government; `department` is mandatory), `journalist` (media), `admin` (platform, or on behalf of `academic` / `civil_society`). Quotas are in `data/civic/survey-policy.json` and are **equal per organisation**: each party gets the same limit under the same rule (default 2 political surveys per rolling 30 days per party); government has no limit for the `bill` class but each needs a department; media and academic get 1 per month. Quota is consumed once, when the survey is first submitted to review. `election_choice` counts as `political`.

### Wording panel (decision A4)

`admin` or `survey_panel` roles review. A survey is approved when **two distinct reviewers approve the current wording hash**. A reviewer cannot be the creator or share the creator's organisation (a `survey_panel` role's `department` carries its nominating organisation: a party code, `civil_society`, `media`, `academic`). One rejection (notes mandatory) returns the survey to draft; approvals on an older wording no longer count. Public panel decisions never show reviewer identities. Machine checks at submission (lists in the policy file): banned framing, leading or loaded words, double-barrelled questions, Telugu text present, and a mandatory "prefer not to say" option on every political question.

### Election-choice surveys (S-34)

Surveys of class `election_choice`, and political surveys that ask for a party or candidate preference, are **off by default and fail closed**. Creation, submission and opening answer `403 election_choice_disabled` unless `CIVIC_ELECTION_CHOICE_SURVEYS=1` **and** `server/window.ts` `windowState(state)` is `open` (blackout and unknown both refuse). While the gate is shut, an existing in-review, approved or open survey of the class is hidden from the registry list (`hidden_reason: "election_window"`, wording withheld on its detail page), cannot be opened or answered, and its figures cannot be published (`figuresPublishable`).

### Routes (all under /api/v1/civic/surveys)

| Route | Who | Notes |
|---|---|---|
| `GET /` | public | filters `status`, `topic`, `state`, `q`, `include_hidden=1`, `limit` (max 100), `cursor`; same payload for every caller |
| `GET /registry/log` | public | `after=<seq>`, `kind=`, `limit`; kinds `registered resubmitted panel_decision returned approved opened closed cancelled` |
| `GET /:id`, `GET /:id/versions/:n` | public | detail with frozen wording, versions, panel decisions, cancellation |
| `GET /mine`, `GET /quota?topic_class=` | creator roles | own surveys including drafts (with wording findings); quota state |
| `POST /` | creator roles | create draft |
| `PATCH /:id` | creator | draft only |
| `POST /:id/submit`, `/open` | creator | |
| `POST /:id/panel/review` | admin, survey_panel | `{decision: "approve"\|"reject", notes}` |
| `POST /:id/cancel` | creator or admin | `{reason_code, reason_text}` |
| `POST /:id/close` | creator or admin | |

Environment: `CIVIC_ELECTION_CHOICE_SURVEYS` (default off). Tests: `tests/civic/surveys/registry.test.ts` (`@E2E-37`, `@E2E-43`).

## Publishing rules and weights (S-32, S-33; server/civic/surveys/{publish,weights,quality,budget,results}.ts)

Figures exist as ONE immutable snapshot per survey, built after the survey closes plus a delay and stored in the survey store (`survey_results`: snapshot, method note, sha256, code version; SQL triggers block update and delete). The public routes only read it. Nothing is computed per request, so differently sliced queries cannot be differenced to recover a hidden cell; the query budget only limits scraping.

| Rule | Implementation | Default |
|---|---|---|
| Fixed partition | `partitionLevels(scope, finest)`: levels from the survey scope down to the finest level chosen at creation (state, district, mandal, village). Responses carry mandal only, so village is used only if a response carries one. Missing places form an "Unassigned" cell, so a parent always equals the sum of its children | one level below scope |
| Minimum cell size k | cells with n < k are hidden and rolled up into the parent total (`hidden_children` counts them, names are never published) | `SURVEY_MIN_CELL=30` |
| Complementary suppression | per parent: hidden children must be at least two cells totalling at least k, else the smallest published sibling is hidden too; a hidden cell hides its subtree. Property-tested on 3000 random trees (`derivabilityProblems`) | |
| Minority option | option with count < 5 or share < 2% in a cell goes to "other"; "other" never equals one identifiable option | `SURVEY_MIN_OPTION_COUNT=5`, `SURVEY_MIN_OPTION_SHARE=0.02` |
| Rounding | counts rounded to a multiple of 5; unweighted shares come from the rounded counts, one decimal | `SURVEY_ROUND_TO=5` |
| No live counts | built only when `status=closed` (or open past its close time) and `now >= close + delay`, optionally at a fixed daily window hour (IST); `403 not_published` otherwise (also for unknown ids) | `SURVEY_PUBLISH_DELAY_HOURS=24`, `SURVEY_PUBLISH_WINDOW_HOUR_IST` |
| Query budget | per survey per UTC day: per caller (hashed IP, plus hashed person id when authenticated) and global; `429 budget_exceeded` with `Retry-After`; stores hashes only | `SURVEY_RESULTS_PER_CALLER_DAY=120`, `SURVEY_RESULTS_GLOBAL_DAY=50000` |
| Channel strata | `app` and `assisted` (platform-linkable) are separate strata, each with its own suppression and weights, never merged; a stratum under k is `published:false` with no n; assisted samples of political topics are not published | |
| Election windows | political topics (`election_choice`, `political`, `party`, `candidate`) are not built when `surveysAllowed(state)` is false (blackout or unknown) and are not served if a window starts later (403) | fail closed |
| Wording | payload carries `disclaimer_en/te` ("Opinion survey, not an election and not a forecast."); the builder throws if its own copy contains vote, ballot or result (the key is `figures`) | |

Routes (public, identical for every caller, `ETag` = snapshot hash, `Cache-Control: public, max-age=300`):

* `GET /:id/results` the snapshot; `?by=geo|age_band|gender|tier` returns that single breakdown. Any second dimension (`by=a,b`, repeated `by`, `by[]`, `dimensions`) is `400 cross_tab_not_allowed`; an unknown name is `400 unknown_dimension`. Also `403 not_published`, `429 budget_exceeded`.
* `GET /:id/results/method` quality components, weights used and skipped with reasons, trimming and residual gaps, suppression statistics as counts (never the hidden cells), policy values.

Job: `publishDueSurveys` (registered through `registerJob` in `server/civic/jobs.ts`, every 15 minutes) builds snapshots for closed surveys past the delay. Residual risk, stated plainly: the option counts of the aggregate of hidden siblings can still be small (the minority rule applies to published cells only), and the snapshot is deterministic, so it carries rounding but no noise.

Weights, the quality score and the public wording are in docs/SURVEY_METHOD.md. Tests: `tests/civic/surveys/{publish,weights,quality,results}.test.ts` (`@E2E-41`, `@E2E-42`).

## Credential, single shot and responses (S-29, S-30, S-31; server/civic/surveys/{credential,eligibility,blind,responses,assisted,source}.ts, src/lib/blind.ts)

Routes (mounted under `/api/v1/civic/surveys`):

| Route | Auth | Purpose |
|---|---|---|
| `GET /:id/credential/key?class=T1\|T2\|T1_LOW\|T2_LOW` | none | the survey's RSA public key (JWK `n`,`e`), one key per class; `alg: RSABSSA-SHA384-PSS-Randomized` |
| `GET /:id/credential/eligibility` | bearer | `{eligible, key_class, tier, quality, mandal}` or `{eligible:false, code, message, eligible_from?}` |
| `POST /:id/credential/request` `{blinded, nonce, key_class}` | bearer | eligibility + has_responded + blind signature; `{blind_signature, replayed, note}` |
| `POST /:id/respond` `{token, prefix, signature, answers, strata}` | none, no cookies | redeem; 201 `{ok:true}` (no id, no receipt) |

Errors are `{error: code, message}`: `survey_not_found` 404, `survey_not_open` 409, `pending_enrolment`/`account_too_new`/`tier_too_low`/`residence_missing`/`outside_scope`/`number_recycled` 403, `already_responded` 409, `key_class_mismatch` 409, `nonce_reuse` 409, `invalid_*` 400, respond: `invalid_credential` 401/400, `token_spent` 409, `invalid_response` 422, `slow_down` 429.

### Eligibility (all server-side)
Authenticated person; an account is an adult (minor dependents have no account); not a pending enrolment; account age at least `CIVIC_SURVEY_MIN_ACCOUNT_DAYS` (default 14, from `persons.created_at`); tier T1 or T2 with a declared residence village inside the survey scope (state, then the union of listed district / mandal / village / constituency / ac_no units, using the boundary version valid on the day); number intelligence: `recently_reissued` (recycled) is excluded, `voip` is admitted at reduced trust under its own key class (`*_LOW`) so published figures can show it as a separate quality stratum.

### Single shot and the failure mode
`has_responded(person, survey)` (identity store) is inserted in the same identity transaction that produces the blind signature: a credential is issued at most once, and a second request is 409 `already_responded`, never a re-issue. There is no re-issue route by design.

**Failure mode, stated to users:** if the credential is issued but the answer is never submitted (app closed, connection lost for good), the person has used their one shot ("if you lose connection after receiving your token, you may not be able to answer"). To soften the common case (the HTTP response was lost), the SAME request (same `nonce`, same `blinded`) repeated within `CIVIC_SURVEY_IDEM_MINUTES` (10) returns the SAME blind signature (`replayed:true`). The signature is stored encrypted (purpose `survey-credential`) in `cred_idem` (identity store) keyed by a hash of the nonce, and deleted after the window (lazily on each issuance, by the `surveyResponseFlush` job, and on account deletion). A different `blinded` under the same nonce is 409 `nonce_reuse`.

**Linkability trade-off (threat note):** during those 10 minutes the identity store holds (person, survey, encrypted blind signature of a value the server cannot unblind). The server already sees the blinded value at issuance, so this adds no way to link the final token; but it widens what an identity-store reader holds for ten minutes. The has_responded row, which persists, is unchanged. We accept it because losing a shot to a flaky 2G connection is the likelier harm.

### Blind signatures (S-30): NEEDS INDEPENDENT CRYPTOGRAPHIC REVIEW
RFC 9474 RSABSSA-SHA384-PSS-Randomized with `node:crypto` + BigInt on the server and WebCrypto SHA-384 + BigInt in `src/lib/blind.ts` (no new dependency; no vetted pure-JS RFC 9474 library was in `node_modules`). RSA-2048 minimum, one key per (survey, key class), private part encrypted with the civic key provider (purpose `survey-credential`, rotation impact `encrypt-only`). The signer re-blinds before exponentiating so it never applies `d` to a caller-chosen value; verification uses node's OpenSSL RSA-PSS. Test vectors with a fixed (throwaway, published on purpose) key are in `tests/civic/surveys/blind.vectors.json`; the browser client and the server are checked against each other and against the vectors. Review checklist: (1) the hand-written EMSA-PSS encoding, (2) the non-constant-time BigInt modPow (mitigated by re-blinding, not eliminated), (3) the key-class design (the class, hence tier and quality, is visible at issuance and in the response), (4) the spent-token design (hash of prefix and token per survey).

Client flow: `GET eligibility`, `GET key?class=`, `blind()`, `POST request`, `finalize()` (verifies the unblinded signature before use), then `POST respond` with no `Authorization` header and no cookies, ideally after a delay. Keep the token in memory only.

### Response rows (what the store can and cannot say)
`survey_response`: random UUID primary key assigned at flush, `WITHOUT ROWID`, no timestamp column of any kind, no person id, no token, no signature; `answers`, `age_band` (18-24/25-34/35-44/45-59/60+), `gender` (M/F/O/NS), `tier` and `quality` (server-verified through the key class; a client-supplied tier must match), `mandal` (must be a mandal inside the survey scope, or `NA`). Answers must match the frozen question set exactly or the response is 422 and the credential is NOT spent. `spent_token` holds only `sha256(prefix||token)` per survey. The respond route stores and logs no header, cookie or IP (an in-memory per-network-prefix limiter exists, never persisted); the identity store keeps `has_responded.ts` at day granularity.

**Batching:** a response is journalled (encrypted, random key) in the same survey-store transaction that spends its token, then moved to `survey_response` in a SHUFFLED batch (crypto shuffle) when `CIVIC_SURVEY_FLUSH_ITEMS` (25) are waiting or after a random 0.5x to 1.5x of `CIVIC_SURVEY_FLUSH_MS` (60 s), and every 30 s by the `surveyResponseFlush` job, which also recovers the journal after a crash (nothing is lost). Residual: SQLite page layout and the WAL can leak coarse write order to someone holding the raw files; a database operator with file access is outside the secrecy guarantee, as the threat model says.

**Tables:** survey store `survey_signing_key`, `spent_token`, `survey_response`, `survey_response_assisted`, `response_journal`; identity store `has_responded`, `cred_idem`. For the results side, `responseCounts(surveyId)` returns `{app, assisted}`; the two tables are never merged.

### Assisted channels (S-31)
Voice/IVR cannot blind on the device, so the server stands in and CAN link person and answer. These responses are `channel='assisted'`, `platform_linkable=1`, in `survey_response_assisted` (a separate stratum), with strata `age_band: NA`, `gender: NS`, and tier, quality and mandal from the profile. Only `issue_service` and `bill` topics: anything else is 403 `channel_not_allowed`, checked before eligibility. Same eligibility, same one shot (`has_responded`). IVR menu option 3 asks for the personal PIN (always, even with `CIVIC_IVR_PIN_ALWAYS=0`), plays `survey_notice` ("the platform can link your answer to your account, counted apart from app answers; once, final"), then asks one question per turn by keypad (single-choice up to 9 options, or a 1 to 5 scale; multi-select surveys are not offered by phone). Call state is `svy:<surveyId>:<keys so far>` in the call row (short TTL, never a PIN). New prompts `survey_notice`, `survey_q`, `survey_none`, `survey_already` are placeholders in the audio manifest and scripts (statuses untouched).

Tests: `tests/civic/surveys/{blind,eligibility,credential,responses,assisted}.test.ts` (`@E2E-38`, `@E2E-39`, `@E2E-40`).
