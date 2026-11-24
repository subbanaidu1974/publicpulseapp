# Count-day degraded mode and the OTP queue (S-46, E2E-56)

DESIGN_2028 section 3.8 item 6: write endpoints sit behind queues and rate tokens, the OTP-send budget is capped (billing-DoS defence), and degraded mode is documented. Code: `server/degraded.ts` (state, shedding gate, queue), wired in `server/civic/index.ts`, `server/obs.ts` and `server/civic/identity/routes.ts`.

## When the platform is degraded

One process-wide state, on when ANY holds (it then stays on for `CIVIC_DEGRADED_MIN_HOLD_SECONDS` so it does not flap):

| Reason | Trigger |
|---|---|
| `operator` | `CIVIC_DEGRADED=1` (read live; flip it without a restart) |
| `sms_budget` | the hourly SMS budget refused a send (held `CIVIC_DEGRADED_SMS_HOLD_SECONDS`) |
| `error_rate` | 5xx share over the last 60 s at least `CIVIC_DEGRADED_ERROR_RATE` with 40+ responses (our own 503 sheds do not count) |
| `queue_depth` | the OTP queue holds at least `CIVIC_DEGRADED_QUEUE_DEPTH` sends |

Read it at `GET /api/v1/degraded` (also `GET /api/v1/civic/degraded`) and in `/readyz` under `info.degraded`. `/readyz` `ok` is NOT affected: degraded is a load state, not a failure.
Body: `{degraded, read_only, reasons[], since, retry_after_seconds, banner: {title_en,title_te,body_en,body_te} | null, queue: {depth,max}}`. The UI shows `banner` when it is not null.

## Priority table

| Class | Routes (under /api/v1/civic) | Degraded behaviour |
|---|---|---|
| P0 always up | health, readyz, degraded; public reads (issues feed, list, detail, categories, geo, audit head/entries/verify, survey registry and published results); sign-in and session routes; PIN recovery; issue reporting and officer actions; survey `respond` (anonymous, batched); admin and ops routes; IVR and channel inbound | served; public reads get `stale-while-revalidate=3600, stale-if-error=86400` added to their `Cache-Control` and `X-Degraded: 1` |
| P1 shed | new sign-up OTP requests (`POST /identity/signup/request`); bulk export (`GET /issues/export`, `GET /scope/export`); media upload (`POST /issues/media`) | 503 |
| P2 shed | consultation writes (`/consultations/**` non-GET); household writes (`/households/**` non-GET); notification writes (`/notify/**` non-GET); me-too; survey credential requests (RSA signing is CPU heavy; the credential lives long, so people retry later); survey registry writes (create, panel, open, close) | 503 |

A shed answer is `503`, `Retry-After: <CIVIC_DEGRADED_RETRY_SECONDS>`, `Cache-Control: no-store`, body `{error:"degraded", degraded:true, shed:<rule>, reasons, retry_after_seconds, notice_en, notice_te, banner}`.
Rationale: reads of public data and anything that protects people (reporting, recovery, existing sessions) must survive count day; everything that creates new load or new accounts can wait a few minutes.

## OTP budget, queue and smoothing

`smsBudgetAllow()` (hourly cap, `CIVIC_SMS_HOURLY_BUDGET`) still answers `429` with `degraded:true` when spent, and marks the state `sms_budget`.
Before that budget is hit, sends are smoothed so a flood in the first minutes cannot drain the hour: each slot (`CIVIC_OTP_SLOT_SECONDS`, default 60) lets `max(CIVIC_OTP_MIN_BURST, ceil(budget / slots_per_hour * CIVIC_OTP_SMOOTH_FACTOR))` texts leave at once. The rest wait in a bounded queue (`CIVIC_OTP_QUEUE_MAX`) and leave slot by slot. The request answers `200 {queued:true, expected_delay_s}`.
A request is refused with `503` + `Retry-After` when the queue is full or the estimated wait exceeds `CIVIC_OTP_MAX_WAIT_SECONDS` (default 120, inside the 5 minute code lifetime, so a queued code is delivered while still valid). One budget token is spent per accepted request, including the one refused as full (accepted loss).

## OTP answers: `delivery` and the bilingual capacity notice

Every successful code request (`POST /identity/signup/request`, recovery likewise) reports what really happened to the SMS in `delivery` (`sendSmsReport`, S-164):

| `delivery` | Meaning | HTTP |
|---|---|---|
| `sent` | the provider accepted or delivered the text | 200 `{ok, purpose, delivery:"sent", expires_in_s}` |
| `queued` | the vendor has it and will retry, or it waits in our smoothing queue (`queued:true`, `expected_delay_s`) | 200 |
| `failed` | the send failed or was dropped (dead, budget exhausted at the vendor) | 502 `{delivery:"failed", can_retry:true}`; the stored code is discarded so a resend is allowed at once (still inside the per-phone cap and the SMS budget) |

Clients must show "queued" as "the code is on its way, it may take a minute" and only offer a resend after `expected_delay_s`. A still-valid code is never replaced: a repeat request answers `{already_sent:true}` with the remaining `expires_in_s`.
When the hourly budget is spent (`429`) or the queue is full (`503`, with `Retry-After`) the body carries `degraded:true`, the English `notice` and the bilingual pair `notice_en` / `notice_te` (same wording as the shed gate's, from the OTP routes), so the sign-up UI shows Telugu without a second request. Existing sessions keep working in both cases.

## Load test

`npm run load:otp -- --smoke` expects at most budget 2xx and no 5xx other than the documented 503s (queue full, with Retry-After).
