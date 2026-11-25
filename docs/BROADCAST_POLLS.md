# Broadcast polls (S-185)

An admin pushes a short opinion poll to everyone who is signed in. Until a person answers it, the rest of the app is unusable for them; once they submit, they continue as normal.

## What a person sees
* A modal dialog over the whole app, in English or Telugu by their language setting. The app behind it is `inert` (no clicks, no tab stops, hidden from screen readers). Focus stays inside the dialog and Escape does nothing.
* Every question must be answered. Every question has "Prefer not to say", so a person is never forced to take a stance. Multi-choice questions have a maximum number of picks.
* The submit button is enabled only when all questions are answered. After submitting, the poll never shows again for that account.
* The dialog says the answer is counted but not linked to their name or account, and that this is a self-selected opinion poll, not a representative survey.
* The app checks for a poll at start, on sign-in, on focus and every 30 seconds, so a poll pushed while someone is using the app reaches them within about half a minute. A poll closed by the admin releases them on the next check.
* People who are not signed in are not blocked; they see the poll when they next sign in. Admins are never blocked.

## What an admin does
Civic page, Admin console, link "Broadcast polls" (opens `#/polls-admin`, its own route so the lite civic bundle stays small): title, optional Telugu title and introduction, 1 to 5 questions (choose one, choose several, or a 5-point agree/disagree scale), optional start time (within 30 days; empty means now) and optional automatic close time (after the start, within 30 days of it). A scheduled poll shows as "scheduled", blocks nobody and refuses answers until its start, then goes live by itself; "Cancel poll" removes it before then (S-186). A confirmation tick states how many registered users will be blocked. Up to 3 polls can be open at once. Results show per-option counts only after 10 people answered. "Close poll" releases everyone at once.

API (all under `/api/v1/civic/broadcast`): `POST /admin`, `GET /admin`, `GET /admin/:id/results`, `POST /admin/:id/close` (admin role); `GET /pending`, `POST /:id/answer` (any signed-in account).

## Rules the server enforces
* Wording that asks people to choose or prefer a party or candidate, or says "vote" next to party or candidate words, is refused (use a Pulse Survey, which has the election-window controls). Links and requests for OTP, PIN, password, Aadhaar, bank or card details are refused.
* One answer per account per poll, enforced by a keyed marker. All questions answered, valid options only, "prefer not" not combined with other picks.
* Privacy: the survey store keeps one counter per option and a keyed "this account answered" marker. There is no person id and no per-response row, so an answer cannot be tied to an account. Audit records only that a poll was opened or closed.

## What it is not
It is not a Pulse Survey: no eligibility rules (email-only accounts count), no weighting, no representativeness claim, no published figures. Results are for the admin only.

## Not built, and open questions
* One admin can push a poll alone: no second approver. Say so if you want two-person approval like Pulse Surveys.
* Making an answer compulsory before using the app is a product and legal choice (consent should be freely given). Counsel has not looked at it. The "prefer not to say" option is the safeguard built in.
* No targeting by place or role, no email or SMS nudge, no editing after creation, no repeating polls, start time uses the admin's browser time zone, no published results, admin screen is English only, Telugu text is machine-drafted and unreviewed.
* While a poll is open every signed-in test session is blocked too. Close polls after use and do not leave one open while running the browser suite.

## Recorded test videos
`npm run e2e:poll-videos` runs the admin and user journey (E2E-202) and saves two 1280x720 videos: `test-results/videos/broadcast-poll/admin-pushes-poll.webm` (admin writes and pushes the poll, sees the response, closes it) and `user-answers-poll.webm` (user is blocked, answers, reaches the app, is not asked again). Run poll specs with `--workers=1`: a poll open in one spec blocks signed-in sessions in others. Choose-several questions have a "Maximum choices" field on the admin screen (empty means no limit; 1 up to the number of options is accepted, anything else is refused); the dialog says "Choose up to N" and refuses the extra pick (S-188). A "Minimum choices" field (empty means 1, at most the maximum) makes the dialog say "Choose at least M and up to N" and keeps Submit disabled until enough are picked; "Prefer not to say" always counts as an answer (S-189).

To watch the poll tests run in a visible browser window on your own machine: `npm run e2e:poll-watch` (needs a desktop session; it fails with "spawn UNKNOWN" from a headless shell).
