# Provider adapters: SMS, KMS/HSM, number intelligence (S-63, S-64, S-62)

Status: everything that does NOT depend on a vendor choice is built and tested. The three stories stay **blocked** until a real vendor adapter passes the contract suites below. Nothing here names a vendor or invents a vendor API: the HTTP adapters speak a documented, neutral JSON shape, and a vendor adapter is a thin mapper onto it (or a direct implementation of the small transport/backend interface).

Code: `server/civic/providers/` (contracts, neutral HTTP adapters, helpers), `server/civic/providers/mock/` (reference vendor simulators, tests and local development only, never started by the app). Suites: `tests/civic/providers/contract/*.contract.ts`. Production guards: `server/civic/guards.ts`.

## 1. What is built, per provider

| | SMS (S-63, E2E-78) | KMS/HSM (S-64, E2E-79) | Number intelligence (S-62, E2E-77) |
|---|---|---|---|
| Core hook (unchanged) | `SmsProvider.send(to, text)`, `setSmsProvider` | `KeyProvider` hmac/encrypt/decrypt, `setKeyProvider` | `NumberIntelligence.lookup`, `setNumberIntelligence` |
| v2 contract | `ManagedSmsProvider` (`SmsProviderV2`) over an `SmsTransport` | `KeyProviderV2` / `EnvelopeKeyProvider` over a `KmsBackend` | `NumberIntelligenceV2` / `ManagedNumberIntel` over a `NumberIntelTransport` |
| What the vendor adapter implements | `SmsTransport.submit` (+ optional `verifyReceipt`, `parseReceipt`) | `KmsBackend.wrap`, `unwrap` (+ optional `hmac`) | `NumberIntelTransport.lookup` |
| Neutral HTTP adapter | `HttpSmsProvider` (`CIVIC_SMS_URL`) | `RemoteKmsKeyProvider` (`CIVIC_KMS_URL`) | `HttpNumberIntel` (`CIVIC_NUMINTEL_URL`) |
| Reference simulator | `mock/smsServer.ts` | `mock/kmsServer.ts` | `mock/intelServer.ts` |
| Contract suite | `runSmsProviderContract(name, factory)` | `runKeyProviderContract(name, factory)` | `runNumberIntelContract(name, factory)` |
| Everything vendor-independent | DLT template registry, idempotency, durable ledger, retry/backoff, dead letters, circuit breaker, cost accounting, receipts endpoint, quiet failure policy | per-purpose keys and versions, rotation, dual-read candidates, envelope cache with TTL and zeroization, break-glass, rehash migration | risk classification, TTL cache by phone hash, circuit breaker, failure policy, hashed logging |

`installProvidersFromEnv()` (called by `createCivicRouter`) installs the neutral adapter for each URL that is set, unless something already installed a non-dev provider. A vendor adapter module wins by calling the setter before `createCivicRouter()` runs.

## 2. SMS (S-63)

### Messages and DLT templates

Callers still pass rendered text to `getSms().send(to, text)`. The gateway matches the text against the **template registry** (`SmsTemplateRegistry`), recovers the template id and slot values, and in production **refuses to send** anything that is not an approved template carrying a `dltTemplateId` (`SmsTemplateError`, no vendor call). The built-in templates (`defaultCivicTemplates`) cover every message the civic code sends today (OTP, PIN lockout notice, adult-added notice, issue reference, IVR failure, enrolment activation, household invite). They deliberately carry **no** DLT ids: the operator registers the bodies on the DLT portal and supplies the ids with `CIVIC_SMS_TEMPLATES_FILE` (JSON array of `{id, dltTemplateId, body, language, category, senderId?}`, merged over the defaults by id). `assertProductionSafe` refuses to start while any template lacks an id. Slots are `{{name}}` (max 30 chars) or `{{name:120}}`. Sender id: per template or `CIVIC_SMS_SENDER_ID`.

### Delivery and failure policy (the quiet policy)

- `submit()` waits at most one attempt (`CIVIC_SMS_TIMEOUT_MS`, default 4000, enforced even if the transport ignores its own timeout), records the message in the `sms_ledger` table (identity store: phone as keyed hash, text encrypted and **dropped as soon as the vendor accepted it**), and resolves. A slow or down vendor never throws to the caller and never blocks a sign-up request: the message is retried with exponential backoff and jitter (`runRetries`, driven by an unref'd 30 s loop, disabled under test and `CIVIC_JOBS=0`), up to `CIVIC_SMS_MAX_ATTEMPTS` (default 5), then dead-lettered (audited as `sms.dead_letter`, no payload in the audit entry; `deadLetters()`, `requeueDeadLetter()`, `purge()`).
- HTTP 4xx other than 429 is permanent: dead-lettered at once, never retried.
- Circuit breaker: 5 consecutive failures open it for 30 s (one half-open probe), and an open circuit does not consume attempts.
- `health()` / `smsDegraded()` / `GET /api/v1/civic/ops/providers` expose `degraded` for the UI notice (`DEGRADED_NOTICE` already exists for the hourly budget). **Honest OTP answer (S-164):** identity does not use the quiet `send()` for the OTP; `sendSmsReport` reads the ledger state of the message and the OTP request answers `delivery`: `sent` (vendor says sent or delivered; also the dev provider and any v1 provider whose `send()` resolved), `queued` (vendor accepted it, or it is pending / retrying: it may be late; the sign-up screen says so) or `failed` (dead letter, vendor-reported failure, budget exhausted, or a v1 `send()` that threw). A failed send answers **502** `{ delivery: "failed", can_retry: true }`, **drops the stored code** (so `already_sent` cannot trap the person for 5 minutes) and is audited as `otp.delivery_failed`; the person can ask again at once, still inside the per-phone cap (3 per 10 minutes) and the global hourly SMS budget (the failed attempt spent one unit). `queued` keeps the code: the vendor will retry and an early re-request answers `already_sent`. The UI treats `degraded` as "may be delayed".
- Idempotency: every send has a key (explicit `idempotencyKey`, else a keyed hash of `to|text|5-minute bucket`). A repeated key returns the first result with `deduped: true`; the key is also passed to the vendor.
- Policy violations (`SmsTemplateError`, `SmsRejectedError` for bad number or empty/oversized text) DO throw: they are bugs or abuse, not outages.

### Cost and budget

Per message: `segments` (GSM-7 160/153 chars, anything else such as Telugu is UCS-2 70/67) times the unit price. The price is the vendor's reported `unit_cost` if any, else `CIVIC_SMS_UNIT_COST`, else **unknown**: cost 0 with `cost_known = 0`, and `costSummary()` reports `unknownCostMessages` so unknown is never silently free. `CIVIC_SMS_DAILY_COST_CAP` holds further sends (`state: "budget_exhausted"`) once known spend over 24 h reaches the cap. The existing per-hour message budget (`smsBudgetAllow`) is unchanged.

### Receipts

`POST /api/v1/civic/channels/sms-receipt`, authenticated with `X-Civic-Timestamp` (ms) + `X-Civic-Signature: sha256=hex(HMAC-SHA256(CIVIC_SMS_RECEIPT_SECRET, "<ts>.<raw body>"))`, 5-minute skew window:

```json
{ "receipts": [ { "message_id": "...", "status": "delivered", "at": "2026-01-01T00:00:00Z", "error_code": "DND" } ] }
```

Statuses map to `queued`, `sent`, `delivered`, `failed` (`normalizeSmsStatus` accepts the usual vendor words: accepted, submitted, DELIVRD, UNDELIV, rejected, expired...). A message never moves backwards, `delivered`/`failed` are terminal, unknown ids are acknowledged and ignored, a bad signature is 401. A vendor that signs differently or posts another body format implements `SmsTransport.verifyReceipt` / `parseReceipt` and keeps the same route.

### Neutral submit shape (what `HttpSmsProvider` posts to `CIVIC_SMS_URL`)

```
POST CIVIC_SMS_URL     X-Civic-Timestamp, X-Civic-Signature (same scheme, secret CIVIC_SMS_SECRET)
{ "version": 1, "idempotency_key": "...", "to": "+91XXXXXXXXXX", "sender_id": "PPULSE", "text": "<rendered>",
  "template": { "id": "otp", "dlt_template_id": "...", "language": "en", "category": "otp" } | null,
  "variables": { "code": "123456" }, "callback_url": "https://.../api/v1/civic/channels/sms-receipt" | null }
-> 200 { "message_id": "...", "status": "queued|sent|delivered|failed", "unit_cost": 0.12?, "currency": "INR"? }
```

### Generic configurable gateway adapter (`GenericHttpSmsProvider`, `server/civic/providers/smsgeneric.ts`)

A `SmsTransport` for typical Indian DLT gateways (one HTTP POST per message, an auth header, destination/text/sender/DLT template id/DLT entity id in the body, delivery receipts posted back). It is **configuration-driven and has not been run against any real gateway**: it is certified only against the invented simulator `mock/genericSmsServer.ts` through `runSmsProviderContract` (`tests/civic/providers/smsgeneric.test.ts`). No vendor is chosen. Request field names, response paths, receipt body and signature scheme **must be confirmed against the chosen vendor's documentation and sandbox** before use; a vendor whose flow does not fit (OAuth tokens, multi-step submit, XML, GET with query strings) needs its own `SmsTransport`.

Installed by `installProvidersFromEnv()` when `CIVIC_SMSGW_URL` is set and `CIVIC_SMS_URL` is not (and nothing else installed a non-dev provider). Env vars (all in `.env.example`): `CIVIC_SMSGW_URL`, `CIVIC_SMSGW_AUTH_HEADER` (default `Authorization`), `CIVIC_SMSGW_AUTH_VALUE` (secret), `CIVIC_SMSGW_ENTITY_ID`, `CIVIC_SMSGW_FORMAT` (`json`|`form`), `CIVIC_SMSGW_REQUEST_FIELDS`, `CIVIC_SMSGW_STATIC_FIELDS`, `CIVIC_SMSGW_RESPONSE_PATHS`, `CIVIC_SMSGW_RECEIPT_PATHS`, `CIVIC_SMSGW_RECEIPT_SECRET` or `CIVIC_SMSGW_RECEIPT_TOKEN` (+ `_SIG_HEADER` / `_TOKEN_HEADER`), `CIVIC_SMSGW_TIMEOUT_MS`; shared with the neutral adapter: `CIVIC_SMS_TEMPLATES_FILE`, `CIVIC_SMS_SENDER_ID`, `CIVIC_SMS_RECEIPT_URL`, `CIVIC_SMS_MAX_ATTEMPTS`, `CIVIC_SMS_UNIT_COST`, `CIVIC_SMS_DAILY_COST_CAP`. The JSON-valued vars take objects; malformed JSON fails at startup. Receipts arrive at the existing `/api/v1/civic/channels/sms-receipt` route and are authenticated by the adapter (HMAC-SHA256 hex over the raw body, or a static token, constant-time compare); with neither configured every receipt is refused. Retries, dead letters, cost accounting, DLT refusal and the quiet policy are inherited. Production guards: `productionProblems()` flags a missing auth value, no receipt secret/token, a non-https URL, and templates without DLT ids. Unknown vendor status words are treated as "accepted, outcome pending" at submit and ignored in receipts, so a mapping error shows as messages that never reach `delivered`, never as false deliveries. Vendor-reported price (`cost` path) is used when present; otherwise `CIVIC_SMS_UNIT_COST`.

## 2b. Mail (officer e-mail ownership proof, S-141)

Contract: `MailProvider { name; send({to, subject, text, idempotencyKey?}) }` in `server/civic/providers/mail.ts`, installed with `setMailProvider`. Rules for every adapter: throw on failure (the officer route reports `email_confirmation: "failed"` and offers a resend), make one bounded attempt, honour the idempotency key, and never log the recipient or the body (it carries a one-time code). `DevMailProvider` keeps the newest 200 messages in memory (`mailOutbox`, `lastMailTo`) and refuses to run in production. `CIVIC_EXPOSE_DEV_MAIL=1` makes `POST /officers/applications` and `.../email/resend` echo `dev_email_code`, only outside production and only for a request addressed to localhost (like `CIVIC_EXPOSE_DEV_OTP`). `productionProblems()` flags the dev mailer and `CIVIC_EXPOSE_DEV_MAIL=1`, so a production server does not start until a real adapter is installed. **No SMTP or vendor API adapter is built**; a real one needs a sending domain and credentials, and must pass the same behaviour the dev mailer shows in `tests/civic/officers.test.ts`.

## 3. KMS/HSM (S-64)

### Why envelope encryption

The core `KeyProvider` is synchronous and on every request path (phone hash, OTP hash, session hash). A KMS is remote and fallible. So the KMS holds only a **KEK** that wraps one random 32-byte **data key per purpose and version**. Wrapped keys live in the `provider_keys` table (identity store; useless without the KEK, back it up with the store). `warm()` unwraps them once at startup into an in-memory cache with a TTL (`CIVIC_KMS_CACHE_TTL_MS`, default 15 min, refreshed in the background at half the TTL); `hmac`/`encrypt`/`decrypt` then run locally. Consequences, by design:

- A KMS outage does not stop traffic until the cache TTL runs out; after that **every operation throws (fail closed)**. There is no fallback to a weaker key.
- Cold start with the KMS down fails: the process never runs half-keyed. While keys are warming, the civic router answers `503 {"error":"keys_warming"}` (`requireKeysReady`); the SMS receipts route sits before that gate.
- Unknown purposes cannot be used (`KNOWN_PURPOSES` lists every purpose the code uses; a test fails if code introduces a new one that is not listed).
- `destroy()` and expiry zeroize cached key buffers.
- Ciphertext is `v2.<version>.<base64url(iv|tag|ct)>` with AAD `purpose|vN`, so a key version is recoverable from the data and purpose confusion is rejected. Legacy `v1.` ciphertext is decryptable only through an explicitly passed `legacy` provider.
- Break-glass and data-key wrapping use an AAD that binds purpose and version: a wrapped key replayed under another purpose fails to unwrap.

### Neutral KMS shape (`RemoteKmsKeyProvider`, `CIVIC_KMS_URL`, secret `CIVIC_KMS_SECRET`)

```
POST {url}/v1/wrap    { "key_id": "<KEK id>", "plaintext_b64": "...", "aad": "..." }   -> { "ciphertext": "<opaque>" }
POST {url}/v1/unwrap  { "ciphertext": "<opaque>", "aad": "..." }                      -> { "plaintext_b64": "..." }
POST {url}/v1/hmac    { "key_id": "...", "data_b64": "..." }                          -> { "mac_hex": "<64 hex>" }   (optional)
```

Signed like the SMS calls; per-call deadline `CIVIC_KMS_TIMEOUT_MS`; circuit breaker (3 failures, 30 s). `/v1/hmac` backs `hmacRemote()`, an **async** path for adopters whose policy forbids ever exporting an HMAC key. It cannot serve the synchronous `KeyProvider.hmac` that identity uses; making identity async for those purposes is a separate piece of work and is not wired.

### Rotation (dual-read, single-write)

`rotate(purpose)` makes a new version the write version; old versions stay readable until `retire(purpose, version)` (refuses the current version, zeroizes the key). `hmacCandidates(purpose, value)` returns the hash under every active version, current first. Rotating `audit` is refused without `force` (it breaks verification of the existing chain). What rotation costs, per purpose (`ROTATION_IMPACT`):

| Purpose | After rotating | Tool |
|---|---|---|
| `phone` (persons.phone_hash + phone_enc) | rehash | `rehashTable(PHONE_REHASH)` |
| `reporter-pseudonym`, `actor-pseudonym`, `issue-link` | re-key issues store + link ledger | `rehashPseudonyms()` |
| `otp`, `rate`, `pinsrc`, `session` | cleared (users re-request a code / sign in again) | `clearEphemeral(purpose)` |
| other encrypt-only purposes | old ciphertext stays readable; re-encrypt lazily or with a table helper | |
| `audit` | do not rotate | |

Procedure for the phone hash:

1. `await provider.rotate("phone")`. New writes already use the new hash.
2. **Dual-read (built, S-161).** Every phone lookup in identity goes through `phoneHashCandidates(e164)`: `personsOnPhone(e164)` (`WHERE phone_hash IN (...)`) for sign-up, login, recovery, SIM linking, enrolment and the IVR/voice-note PIN steps, and the OTP rows (`otps`) are read the same way. Writes always use the CURRENT version. **Lazy rewrite:** when a lookup finds a row under an older hash it rewrites that row to the new hash and re-encrypts `phone_enc` on the spot (audited as the count `phone.rehash_lazy`), so a login or a recovery is itself a migration step; `storeOtp` deletes an old-hash twin when it writes a fresh code. The rotation can therefore be done **online**, no offline window needed.
3. `rehashTable(PHONE_REHASH)` (a **dry run by default**) reports `scanned / alreadyCurrent / stale / fromOldVersion / fromUnknown / encStale / unrecoverable / updated`. `fromUnknown` is a tamper or foreign-key signal. Then `{ dryRun: false }`: decrypts each stored phone, writes the new hash and re-encrypts under the new version, in batches, resumable and idempotent (staleness comes from the data). Rows whose phone was purged (`phone_enc` NULL) cannot be rehashed and are reported as `unrecoverable`.
4. A dry run showing `stale: 0` (and `encStale: 0`) means the old version can be retired. `retire("phone", old)`. After the retire, `phoneHashCandidates` has one entry again and nothing else changes.

**Online procedure, in order** (tested end to end in `tests/civic/hardening/rotation.test.ts`, @E2E-185): (1) `rotate("phone")`; (2) call `clearCache()` on the number-intelligence adapter (its cache is keyed by the phone hash); (3) leave the service running: logins and recoveries migrate their own rows; (4) run `rehashTable(PHONE_REHASH)` dry, then `{ dryRun: false }`; (5) dry run again must report `stale: 0`; look at `unrecoverable` (numbers whose encrypted copy was purged by retention keep their old hash: either accept that those accounts can no longer log in by phone after the retire, or keep the old version until they are gone); (6) `retire("phone", old)`. **Known limits during the window:** a household invite created before the rotation stores the old hash (it lives 72 hours) and may fail the phone check at acceptance: re-issue it; a person-to-person comparison of two stored hashes (attestor and subject sharing a SIM) sees two spellings of one number until both rows are migrated, so run step 4 promptly. Rotating `otp`, `rate`, `pinsrc` or `session` signs people out / resets counters (`clearEphemeral`).

### Break-glass (`BreakGlass`)

An admin requests (with a written reason), **two other admins** approve (the requester never counts, nobody approves twice, the count cannot be configured below two), then one use within 15 minutes: `exportRecoveryBundle` (the data key re-wrapped under `CIVIC_KMS_RECOVERY_KEY_ID`; the clear key never leaves the process) or `useKey` (a transient copy zeroized afterwards). Every request, approval, denial and use is written to the audit chain **before** the action; if the audit write fails the key is not released. Grants live in memory: a restart cancels all open requests. The capability to read a data key (`breakGlassAccess()`) can be taken once per provider, so no other code can obtain it. **Admin API (S-163)**, `server/civic/admin/breakglass.ts` and `admin/routes.ts`, all under `/api/v1/civic/admin`, admin role AND a fresh TOTP code (`x-totp-code`) on every state-changing call:

| Call | Effect |
|---|---|
| `POST /breakglass/requests` `{purpose, version?, reason}` | request; purpose must be a known key purpose, reason at least 10 characters; version defaults to the current one |
| `GET /breakglass/requests` | every request, newest first (privileged read, audited); ids and counts only |
| `POST /breakglass/requests/:id/approve` | an approver other than the requester, each admin once; the second approval makes it usable. The requester's attempt answers 403 `dual_control` and is audited as `keys.breakglass.self_approval_refused` |
| `POST /breakglass/requests/:id/deny` | ends it |
| `POST /breakglass/requests/:id/export` | ONE use within 15 minutes of the request: returns `{bundle}`, the data key wrapped under the recovery KEK (501 without `CIVIC_KMS_RECOVERY_KEY_ID`); a second call is 409 `already_used`, a late one 410 `request_expired` |

Every step is audited as `keys.breakglass.request|approve|deny|export|use|self_approval_refused` (actor, request id, purpose, version; never key material; the written reason is scrubbed like any audit metadata). The public `GET /api/v1/civic/audit/summary` shows only counts: `break_glass: { requests, approvals, denials, uses, self_approval_refusals }` plus the number of entries per action class. Without an envelope key provider (the dev provider has none) every route answers 501 `break_glass_unavailable`. Requests are in memory: a restart cancels them (the audit log stays).

## 4. Number intelligence (S-62)

`lookup(e164)` returns a superset of the existing `{ recently_reissued, voip }`: `lineType` (`mobile_prepaid|mobile_postpaid|voip|landline|unknown`), `recycled`, `portedRecently`, `carrierCircle`, `activationAgeDays` with `activationConfidence` (0..1), `risk` (`low|medium|high|unknown`), `trust` (`normal|reduced`), `source` (`vendor|cache|unknown`). Classification (`classifyNumber`, pure): VoIP or recycled = high; ported recently, landline, or a prepaid line activated under 30 days ago with confidence of at least 0.5 = medium; nothing known = unknown with reduced trust; otherwise low. **How identity uses it (S-162):** `lookupNumber` wraps the adapter so that a throwing adapter is also an unknown verdict. `voip` still blocks sign-up. `numberFlags` turns the report into flags on the account: `recently_reissued` for a recycled number (survey-ineligible until a volunteer confirms the number: the account is T0-restricted rather than asked for a second OTP, which would go to the same phone), `number_ported`, `number_risk_medium|high` and `number_unverified` (vendor failure; never blocks, never penalises). Trust weighting: an elevated risk class (medium or high) gets a stricter per-phone OTP cap (`CIVIC_RISK_CAP_FACTOR`, default 0.67: 3 requests per 10 minutes become 2; 1 disables it) and answers survey eligibility in the *_LOW key class (a separate stratum, like VoIP before). The activation age is not used yet.

**Failure policy (identity then flags the account `number_unverified`):** timeout, error, open circuit or malformed answer yields `{ risk: "unknown", trust: "reduced", voip: false, recently_reissued: false }`. Sign-up is never blocked and the lookup never throws. Unknown results are cached for 30 s only, verdicts for `CIVIC_NUMINTEL_CACHE_TTL_MS` (24 h), keyed by the keyed phone hash (the cache holds no number; call `clearCache()` after rotating `phone`), bounded in size, concurrent lookups of one number make one vendor call.

**Privacy:** the vendor receives the E.164 number and a random request id, nothing else (no person, IP, device, session), over TLS (https enforced in production). It is never logged: log lines carry a 10-character keyed hash. The contract suite asserts the exact request keys.

Neutral shape (`CIVIC_NUMINTEL_URL`, secret `CIVIC_NUMINTEL_SECRET`, signed as above):

```
{ "version": 1, "msisdn": "+91XXXXXXXXXX", "request_id": "<random>" }
-> { "line_type": "...", "recycled": bool, "ported_recently": bool, "carrier_circle": "AP"|null,
     "activation_age_days": number|null, "activation_confidence": 0..1|null }
```

## 4a. AWS KMS adapter (S-64) and generic HTTP number-intelligence adapter (S-62)

**Status, read this first: neither adapter has been run against a real vendor.** Both pass the contract suites against local simulators written from public API documentation (`mock/awsKmsServer.ts`, `mock/vendorIntelServer.ts`). A simulator proves the adapter's own logic (request shapes, SigV4, error mapping, failure policy), not AWS or any vendor's real behaviour (latency, quotas, key policy, undocumented errors). S-62 and S-64 stay **blocked** until the checklist below is done against real endpoints.

### AWS KMS (`server/civic/providers/awskms.ts`)

`AwsKmsKeyProvider` is an `EnvelopeKeyProvider` over `AwsKmsBackend`: KMS `Encrypt` wraps each locally generated 32-byte data key under the KEK with `EncryptionContext {"aad": "civic-key:<purpose>:<version>"}`, `Decrypt` unwraps it at warm-up/refresh (same context or it fails). `generateDataKey` (KMS `GenerateDataKey`) exists on the backend but the envelope provider does not use it. Requests are `POST` JSON (`application/x-amz-json-1.1`, `X-Amz-Target: TrentService.<Op>`) signed with SigV4 implemented on `node:crypto` (no AWS SDK). Hot paths never call KMS (cache + TTL, fail closed), as for every KMS.

Selection: set `CIVIC_AWS_KMS_KEY_ID` (and not `CIVIC_KMS_URL`). `installProvidersFromEnv` installs it only while the dev key provider is still active; the production guard still refuses the dev stand-in and reports missing region, credentials, a non-https endpoint, or both KMS variables set.

| Variable | Meaning |
|---|---|
| `CIVIC_AWS_KMS_KEY_ID` | key id, ARN or alias (the KEK) |
| `CIVIC_AWS_KMS_REGION` (or `AWS_REGION`) | region |
| `CIVIC_AWS_KMS_ENDPOINT` | optional override (VPC/FIPS endpoint); https in production |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | static credentials. No instance-role / SSO / web-identity chain is implemented; a deployment that needs one passes a `credentials` function to `AwsKmsKeyProvider` from its own module and calls `setKeyProvider` |
| `CIVIC_KMS_TIMEOUT_MS`, `CIVIC_KMS_CACHE_TTL_MS` | shared with the neutral KMS |

Errors: `ThrottlingException`/`LimitExceededException` map to HTTP 429 (retryable, counts toward the 3-failure circuit breaker), `KMSInternalException`/`DependencyTimeoutException`/5xx to 5xx (same), `AccessDeniedException`, `DisabledException`, `NotFoundException`, `InvalidCiphertextException` and other 4xx are permanent and do not trip the breaker. Credentials, key material and numbers are never logged.

Minimal IAM policy for the service principal (key policy must also allow the principal):

```json
{ "Version": "2012-10-17", "Statement": [ { "Effect": "Allow", "Action": ["kms:Encrypt", "kms:Decrypt"], "Resource": "arn:aws:kms:<region>:<account>:key/<key-id>",
  "Condition": { "StringEquals": { "kms:EncryptionContext:aad": [] } } } ] }
```

Drop the `Condition` unless you enumerate the exact contexts (`civic-key:<purpose>:<version>` for every purpose and version, including after rotation); `kms:GenerateDataKey` is only needed if you adopt `generateDataKey`. Use a symmetric `ENCRYPT_DECRYPT` key, enable automatic rotation of the KEK (old ciphertext stays decryptable), and give the break-glass recovery KEK (`CIVIC_KMS_RECOVERY_KEY_ID`) a separate key and policy.

**Certifying against real AWS (a human must do this).** In a sandbox account with a throwaway key: put the variables above in the environment, then run a copy of `tests/civic/providers/awskms.test.ts` whose harness uses the real endpoint instead of `startAwsKmsSim()`: no `endpoint` override, real credentials, `kekId` = your key, and `breakKms()` implemented by swapping in a credentials function that returns a wrong secret (outage) and back. Expect 20+ `Encrypt` calls on first warm-up. Also check CloudTrail shows the `aad` encryption context on every Encrypt/Decrypt and that a disabled key and a revoked grant make warm-up fail (never half-keyed). Record the result in the story.

### Generic HTTP number intelligence (`server/civic/providers/numberintelHttp.ts`)

`GenericHttpNumberIntel` = `ManagedNumberIntel` (failure policy, cache, breaker, hashed logs, all unchanged and covered by the contract suite) over `GenericHttpIntelTransport`: one JSON POST over https with an API key header and a configurable mapping. It does not name or favour any vendor.

Selection: `CIVIC_NUMINTEL_URL` plus `CIVIC_NUMINTEL_API_KEY` (instead of `CIVIC_NUMINTEL_SECRET`), optional `CIVIC_NUMINTEL_MAPPING_FILE` pointing at JSON of this shape (all fields optional; defaults reproduce the neutral shape):

```json
{ "numberField": "phone_number", "requestIdField": null, "extraBody": {}, "apiKeyHeader": "x-api-key", "apiKeyPrefix": "",
  "response": { "lineType": "data.carrier.type", "carrierCircle": "data.carrier.circle", "portedRecently": "data.flags.ported", "recycled": "data.flags.recycled",
                "activationAgeDays": "data.activation.days", "activationConfidence": "data.activation.confidence",
                "lineTypeMap": { "PREPAID": "mobile_prepaid", "POSTPAID": "mobile_postpaid", "VOIP": "voip", "FIXED": "landline" } } }
```

Paths are dot paths. Unmapped line types become `unknown`; non-boolean flags become unknown (null); an out-of-range confidence or negative age is dropped rather than trusted. Any HTTP error (401 bad key, 429, 5xx), timeout, non-JSON answer or open circuit yields the contract's failure policy (`risk: "unknown"`, `trust: "reduced"`, sign-up continues). The only personal datum sent is the E.164 number (plus the configured constant fields and optional random request id).

**Vendor-specific mapping must be confirmed against the real vendor's documentation and sandbox before use**, for example for any Indian MNP/number-intelligence provider: the exact field names, what the vendor means by "ported" and "recycled" (a vendor may expose only the current operator/circle, in which case `recycled`/`activationAgeDays` stay null and risk is judged on line type and porting only, so the "recently re-issued" signal may not exist), the line-type vocabulary, authentication scheme (a vendor needing OAuth, request signing or a query-string key needs a small transport rather than this configuration), rate limits, error body format, data-residency and retention terms, and DPDP processor terms (section 6). Then run `numberintelHttp.test.ts` with the simulator replaced by the vendor sandbox.

## 5. How to implement and certify a vendor adapter

1. **Implement the small interface**, not the whole contract:
   - SMS: `class AcmeTransport implements SmsTransport { submit(m, {timeoutMs}) }` mapping `SmsSubmit` (`idempotencyKey, to, text, senderId, template{id,dltTemplateId,language,category}, variables`) to the vendor's API and returning `{ messageId, status, unitCost? }`. Throw `ProviderError(kind, status)` for failures (`retryable` is derived: timeout, network, 5xx, 429). Pass the idempotency key through if the vendor supports one. If the vendor's receipts differ, add `verifyReceipt(raw, headers)` and `parseReceipt(raw)`.
   - KMS: `class AcmeKms implements KmsBackend { wrap, unwrap, hmac? }` against a non-exportable KEK; bind `aad`. Then `new EnvelopeKeyProvider(backend, { kekId, registry: new SqlKeyRegistry() })`. Apply your own timeouts and a `CircuitBreaker`.
   - Number intelligence: `class AcmeIntel implements NumberIntelTransport { lookup({msisdn, requestId}, {timeoutMs}) }` returning `RawNumberFacts` (null for unknown facts). `new ManagedNumberIntel(transport)`.
2. **Install** in a module imported before `createCivicRouter()`: `setSmsProvider(p); setSmsGateway(p)`, `setKeyProvider(p)` (then `await p.warm()` at startup, `requireKeysReady` gates the router; mirror `installProvidersFromEnv`), `setNumberIntelligence(i)`.
3. **Certify.** Write a test file that runs the suite against your adapter and a simulator of the vendor (copy the reference mock and the harness in `tests/civic/providers/{sms,keys,numberintel}.test.ts`):

   ```ts
   runSmsProviderContract("acme-sms", async (opts) => ({ provider: new ManagedSmsProvider(new AcmeTransport(sim.cfg), opts), setMode, received, requests, deliverReceipt, deliverForgedReceipt, setVendorPrice, close }));
   runKeyProviderContract("acme-kms", async ({ cacheTtlMs }) => ({ provider: new EnvelopeKeyProvider(new AcmeKms(sim.cfg), { kekId, registry, cacheTtlMs, now }), restart, breakKms, advance, keyMaterialSeen, close }));
   runNumberIntelContract("acme-intel", async (opts) => ({ intel: new ManagedNumberIntel(new AcmeIntel(sim.cfg), { ...opts, now }), setFacts, setMode, calls, bodies, advance, close }));
   ```

   Each suite's header lists the harness controls. A passing run is the **definition of done** for S-63/S-64/S-62, together with the production checklist in section 6 against a sandbox account. The suites cover: SMS (templates, DLT refusal, idempotency, receipts incl. forged ones, timeout, outage and recovery, dead letters, permanent rejection, cost, daily cap, no PII in logs); KMS (determinism, purpose separation, restart, tamper, fail closed cold/expired/destroyed, rotation and retirement, outage and refresh, no key material in logs); number intelligence (classification, unknown facts, failure policy, cache and negative cache, single-flight, circuit, exact outbound fields, no number in logs).
4. Keep the simulator honest: it must be built from the vendor's documentation or sandbox, not from the adapter.

## 6. Production readiness checklist

**All providers:** endpoints are https; secrets are in the secret store, not the repo; `GET /api/v1/civic/ops/providers` (admin) shows healthy; alerts on `degraded`, open circuits and `sms.dead_letter` audit entries; contract suite green against the final adapter version.

**SMS:** DLT entity, sender id(s) and every template registered; ids in `CIVIC_SMS_TEMPLATES_FILE`; template bodies in the file equal the registered text (a mismatch is refused at send time, by design); delivery-receipt URL registered with the vendor and `CIVIC_SMS_RECEIPT_SECRET` set; unit cost or vendor-reported cost verified against an invoice; `CIVIC_SMS_DAILY_COST_CAP` chosen; dead-letter review owner named; Telugu (UCS-2) rendering checked on real handsets; DND and quiet-hours handling confirmed with counsel and the vendor.

**KMS/HSM:** KEK created non-exportable with an audit trail on the KMS side; separate recovery KEK held under dual control; `CIVIC_KMS_*` set; cold start tested with the KMS down (must fail, never run half-keyed); cache TTL chosen against the KMS's real availability; rotation rehearsed on a restored backup (`rehashTable` dry run then real, `rehashPseudonyms`, retire) and timed; break-glass drill performed with three admins and the audit entries inspected; backups of the identity store include `provider_keys`; CIVIC_DEV_MASTER_KEY removed from the environment.

**Number intelligence:** vendor contract covers storing nothing beyond the request lifetime and using the number only for the lookup; DPDP processor agreement; timeout validated against sign-up latency budget; reduced-trust handling agreed (identity currently ignores `trust`).

## 7. What remains vendor-specific

The transport mapping (auth scheme, endpoints, field names, error taxonomy, rate limits); vendor receipt authentication and body format; DLT registration artefacts and their ids; how the KMS authenticates the caller (mTLS, IAM) and its wrap/unwrap/hmac semantics and limits; the number-intelligence vendor's data coverage and how it defines "recycled" and "activation age"; pricing; sandbox behaviour. And on our side, not vendor-specific but not done: identity adopting `phoneHashCandidates` (online rotation), identity reading `risk`/`trust`, an admin API surface for break-glass, async hmac for non-exportable HMAC keys.

## 8. Threat notes

- **SMS pumping / toll fraud:** the hourly budget, per-phone and per-network OTP caps and the daily cost cap bound spend; templates stop the gateway being used for arbitrary text.
- **Receipt forgery:** HMAC with timestamp window; a forged "delivered" cannot hide a failure because terminal states never move backwards, and unknown ids are ignored.
- **Payload exposure:** the ledger keeps text only while a retry could need it, encrypted, and dead-letter payloads are dropped after 24 h; logs and audit entries never carry numbers, codes or text (scrubbed by `providerLog`, asserted by the suites).
- **KMS dependency:** a compromised KMS credential allows unwrapping data keys; mitigations are KEK policy on the KMS side, request signing, the audited dual-control break-glass, and short cache TTL. A compromised process holds unwrapped keys in memory for the TTL; zeroization limits, not removes, that window.
- **Availability vs safety:** the key provider chooses safety (fail closed); SMS and number intelligence choose availability (quiet failure, reduced trust). That asymmetry is intentional.
- **Clear number to the intelligence vendor** is unavoidable; the contract minimizes what accompanies it and requires TLS.
- **Dev stand-ins:** production refuses the dev key, SMS, number-intelligence and attestation providers, an HTTP witness without `CIVIC_ANCHOR_SECRET`, half-configured provider URLs, non-https provider URLs, and SMS templates without DLT ids (tests in `tests/civic/providers/guards.providers.test.ts`).
