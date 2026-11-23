# Bill consultations

DESIGN_2028 section 3.6 (binding). Stories S-35 (registry, feedback, figures) and S-36 (anti-astroturf, mandatory closing report). Code: `server/civic/consultations/`, mounted at `/api/v1/civic/consultations`. Tests: `tests/civic/consultations/` (`@E2E-44`, `@E2E-45`). Policy: `data/civic/consultation-policy.json`.

**A consultation is a signal, not a referendum.** Every public payload carries `disclaimer_en` / `disclaimer_te`. Copy says "consultation", "feedback", "responses", "figures".

## Storage

Tables are in the **survey store** (migration `consult_001_registry`, listed in `STORE_TABLES.survey`): `consultations`, `consultation_versions`, `consultation_corrections`, `consultation_panel_reviews`, `consultation_audio_reviews`, `consultation_log`, `consultation_feedback`, `consultation_burst`, `consultation_comment_reviews`, `consultation_machine_items`, `consultation_themes`, `consultation_responses`, `consultation_reports`. No new store was added (a fifth store would change the separation contract for no gain).

- Feedback is **attributable to the platform account, not secret**: each row carries a keyed pseudonym per (consultation, person) (`survey-actor` key purpose). No `persons.id` is stored; the person can read and edit their own rows because the key is recomputable. Erasure deletes the rows through the same key (`registerErasureSubjects` / `registerStoreErasureHook`).
- Public records are append-only by trigger: versions, log, panel reviews, reports. Registered content cannot change (`content_frozen`). `status = completed` is refused by a trigger unless a published closing report exists.

## Lifecycle

`draft` (private) -> `in_review` (public from here) -> `approved` (two distinct panel approvals on the content hash) -> `open` (publish) -> `closed` (closes_at job or manual) -> `completed` (only with a published closing report).

Content (hashed, sha256 of canonical JSON): title EN/TE, department, bill reference, official source URL (https on a suffix from the policy, default `gov.in`, `nic.in`), scope, window, affected groups, and clauses (number, original text or reference, EN and TE plain-language summaries, optional audio metadata per affected group). Both summaries are required at submit. The wording checks of the survey panel (banned framing, leading words) run on the title and summaries.

**Panel**: same model as surveys (`admin` or `survey_panel`; never the creator or anyone of the creator's department; two approvals; a rejection with notes returns the draft). `reviewerConflict` from `surveys/panel.ts` is reused.

**Corrections**: after submission a change is `POST /:id/corrections` (reason EN mandatory). It creates a *pending* new version; the public keeps the old one until the same two approvals (`panel/review` with `correction_id`). The new version gets its own sha256; `GET /:id/versions/:n` serves every version; the public log records `correction_proposed` and `corrected` with the reason.

**Audio**: metadata only (`group`, `file_id`, `duration_s` <= 60, `status`). Input status is `placeholder` or `recorded`; `reviewed` is rejected on input. `POST /:id/audio/review` (panel) records a human review of a `recorded` file and only then does the public payload show `reviewed`. A placeholder can never be reviewed.

## Eligibility and feedback

Reads need no login. Feedback reuses the survey eligibility (`surveys/eligibility.ts`): authenticated adult account, not a pending enrolment, account age (`CIVIC_SURVEY_MIN_ACCOUNT_DAYS`), tier T1 or higher, residence inside the consultation scope, number checks.

One row per (person, clause); editable until the consultation closes, last edit wins. Stances: `support`, `support_changes`, `oppose`, `unclear`, `prefer_not`. Comment optional, at most 1500 characters, English or Telugu only. Comments pass the issue moderation module (`assessText`): a held comment is never public; a moderator or admin can release it. A comment is public only if the author set `public_ok` AND it passed moderation, with mandal-level location only when that mandal cell has at least k people, and no name.

## Figures

`GET /:id/figures` reuses the survey publish helpers (`surveys/publish.ts`): fixed partition state > mandal, minimum cell size k (`SURVEY_MIN_CELL`, default 30) with complementary suppression, minority merge, rounding (`SURVEY_ROUND_TO`), no live figures (close + `SURVEY_PUBLISH_DELAY_HOURS`, otherwise `403 not_published`). Participants and tier breakdown are suppressed below k. Weighting does **not** apply: consultations collect no age or gender and no verified reference marginals exist, so figures are unweighted and the payload says so (`weighted.applied: false`).

## Anti-astroturf (S-36 a)

- One person counts once per clause in every aggregate (database unique key). Near-duplicate comments never add to any figure.
- Near-duplicate clustering (`similarity.ts`): normalisation, word 3-gram shingles, 64-function minhash with LSH banding, exact Jaccard verification (`CONSULT_DUP_THRESHOLD`). A cluster of at least `CONSULT_CLUSTER_FLAG_MIN` is flagged. Analysts (`GET /:id/analyst`) see a cluster as ONE item: size, time window, one representative. Public comments from a cluster carry `flag: "near_duplicate"` and `cluster_size`.
- Rate limits per person and per network prefix per consultation (`CONSULT_FEEDBACK_PER_MIN_PERSON`, `CONSULT_FEEDBACK_PER_MIN_NET`); refused requests are counted.
- Burst detector: accepted feedback per consultation per minute; minutes at or above `CONSULT_BURST_PER_MIN` are listed in the closing report.

## Review coverage (S-36 b)

`CommentReviewer` (`reviewer.ts`) is a pluggable interface; the default is a **no-op** that summarises nothing. No external AI service is called anywhere. Coverage numbers are counted from stored rows, never from a reviewer's claim: `comments_total`, `reviewed_by_human` (recorded by `POST /:id/review/comments`, with the reviewer's ROLE, not name), `machine_summarised` (ids the installed reviewer actually returned), `method` text, `human_reviewer_roles`, `machine_methods`. With the no-op the report says "No machine summarisation was used".

## Closing report (S-36 c) is mandatory

The report is built fresh from the data when the panel publishes it and stored as an immutable snapshot with its sha256. Contents: participation (k-suppressed), per-clause stance figures, themes (human-entered or reviewer-provided, with source), anti-astroturf flags, review coverage, and for **every clause a department response**: `response`, or `no_change` with reasons (officer of the owning department only; at least 20 characters). Publishing is refused (`409 closing_report_incomplete`, with `missing`) without a response per clause, without a theme when comments exist, or before figures are publishable. `POST /:id/complete` answers `409 closing_report_required` without a published report (and the database refuses too).

Job `consultations` (every minute, registered via `registerJob` from `hooks.ts`): closes consultations at `closes_at` and flags closing reports overdue (`CONSULT_REPORT_DUE_DAYS`, default 30) once in the public log (`report_overdue`); the registry list and detail carry `closing_report: {status, due_at, overdue}` and `GET /?overdue=1` lists them.

## Routes (all under /api/v1/civic/consultations)

| Route | Who | Notes |
|---|---|---|
| `GET /` | public | `status`, `department`, `q`, `overdue=1`, `limit`, `cursor`; items: id, status, department, titles, bill_ref, source_url, scope, window, version, content_hash, closing_report |
| `GET /mine` | officer, admin | own / department consultations incl. drafts with wording `findings` |
| `GET /:id` | public | detail: `clauses[{n, original_text, original_ref, summary_en, summary_te, audio[{group,file_id,duration_s,status}]}]`, `affected_groups`, `versions`, `panel`, `stances`, `closing_report` |
| `GET /:id/clauses/:n` | public | one clause plus stances |
| `GET /:id/versions/:n` | public | immutable version content and hash |
| `GET /:id/log` | public | change log: `registered panel_decision approved published correction_proposed corrected audio_reviewed closed report_overdue report_published completed`; `after`, `limit` |
| `POST /` | officer (own department), admin (`department` in body) | create draft: `{title_en, title_te, bill_ref, source_url, scope, opens_at, closes_at, affected_groups[], clauses[]}` |
| `PATCH /:id`, `POST /:id/submit` | owner | draft only; submit freezes |
| `POST /:id/panel/review` | admin, survey_panel | `{decision, notes, correction_id?}` |
| `POST /:id/publish`, `/close`, `/complete` | owner | owner = creator, officer of the department, admin |
| `POST /:id/corrections` | owner | `{reason_en, reason_te?, clauses:[{n, summary_en?, summary_te?, original_text?, original_ref?, audio?}]}` |
| `POST /:id/audio/review` | admin, survey_panel | `{clause, group}` |
| `POST /:id/feedback` | auth | `{clause, stance, comment?, public_ok?}` -> `{clause, stance, edited, comment_status: none\|ok\|held, comment_public}`; 201 first time, 200 edit |
| `GET /:id/mine` | auth | own feedback, `eligible`, `ineligible{code,message}`, `editable_until` |
| `GET /:id/figures` | public | after close + delay: `participation`, `clauses[{clause, published, participants, stances[{id,count,share}], other, cells[], suppressed_reason}]`, `weighted`, `method_note` |
| `GET /:id/comments` | public | after close + delay: opted-in, moderated comments; `clause`, `limit`, `offset` |
| `POST /:id/comments/:fid/moderate` | moderator, admin | `{decision: release\|keep_held}` |
| `GET /:id/analyst` | staff | flags, clusters, coverage, suggested sample, themes |
| `POST /:id/review/comments`, `/review/run`, `/themes` | staff | see above |
| `GET /:id/closing-report` | public | published report with `snapshot_hash` (else 404 `report_not_published` with `closing_report` state) |
| `GET /:id/closing-report/preview` | staff | `{snapshot, missing[]}` |
| `POST /:id/closing-report/responses` | officer of the department | `{clause, kind: response\|no_change, text_en, text_te?}` |
| `POST /:id/closing-report/publish` | admin, survey_panel | refuses while `missing` is non-empty |

Error body: `{error, code, ...}`. Staff = admin, officer of the department, moderator, survey_panel.

## Environment

`CONSULT_FEEDBACK_PER_MIN_PERSON`, `CONSULT_FEEDBACK_PER_MIN_NET`, `CONSULT_BURST_PER_MIN`, `CONSULT_DUP_THRESHOLD`, `CONSULT_CLUSTER_FLAG_MIN`, `CONSULT_REPORT_DUE_DAYS` (see `.env.example`); plus the shared `SURVEY_MIN_CELL`, `SURVEY_ROUND_TO`, `SURVEY_PUBLISH_DELAY_HOURS`, `SURVEY_MIN_OPTION_*`, `CIVIC_SURVEY_MIN_ACCOUNT_DAYS`.

## Not done / limits

- UI: src/components/consultations/** (hash routes #/consultations*). The closing report is published by a single panel member (admin or survey_panel, not conflicted), not by two approvals.
- Weighted figures do not apply (no strata collected). Age, gender and region breakdowns beyond mandal are not collected.
- The default `CommentReviewer` does nothing; a real machine reviewer needs a deployment adapter and counsel sign-off.
- Language check on comments is script-based (Latin or Telugu), not semantic.
