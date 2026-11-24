# Internal red-team self-assessment (not independent)

This is the builders testing their own controls with automated tests. It is not the independent red-team and penetration test that gate row 2 requires, it is not a review of the threat model (row 1), and it approves nothing. No owner, reviewer or date is recorded here; those are human decisions.

Date run: 2026-11-24. New suite: `tests/civic/hardening/redteam.test.ts` (26 tests, tag `@E2E-RT`). It runs the real civic router inside `buildApiApp` (the production edge assembly) with a development and a production-mode app, and drives it over HTTP.

## 1. Attacks attempted, by class

| Attack class | What was tried | Where | Result |
|---|---|---|---|
| OTP replay | Re-use a consumed sign-up code to create or take over an account | `redteam.test.ts` "OTP: replay..." | Refused; one person row only |
| OTP cross-purpose | Recovery code at `/signup/verify`; sign-up code at `/pin/recover`; code for phone A used for phone B | same | Refused; victim PIN unchanged |
| OTP guessing | 12 wrong codes then the right one | same | Right code no longer works (no 10^6 brute force) |
| Phone-format tricks | Spaces, leading 0, trailing digit, NUL byte, full-width digit, hyphens | same | All 400, no second identity or allowance |
| Rate-limit bypass | Rotating `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `X-Client-IP`; rotating `X-Device-Id`, `X-Asn`, `X-Edge-Verified` | "rate-limit bypass" | Per-phone and per-IP caps still bite; export limit keyed to the socket address |
| IDOR on issues | Another resident reads, appeals, rebuts, transitions, moderates, escalates someone's held report | "IDOR on issues and media" | 4xx for each, never 500; report stays held |
| IDOR on media | Another resident or anonymous caller reads a private upload; traversal-shaped ids; attaching someone else's upload to own report | same | 404 / 401 / 4xx |
| IDOR on consultations | Other resident reads own `mine`; citizen hits held comments, analyst, review, panel, publish, close, patch, corrections, complete; other department's officer edits | "IDOR and role gates on consultations" | Only 401/403/404/409/400/422; no feedback of one person visible to another |
| Surveys role/session gates | Citizen and anonymous on registry create, `mine`, `quota`, panel review, credential routes | same | 403 / 401 |
| Role escalation | Role and tier via headers (`x-user-role`, `x-admin`...), query, body fields on `/me`, `/residence`, `/pin/change`; admin, moderation, ops, break-glass routes as a citizen; self-grant of a role without MFA | "role escalation" | No role or tier change; all gated routes refuse |
| CSRF | Cookie-only authentication, urlencoded cross-site form post | "CSRF, CORS, CSP and cookies" | Treated as anonymous; no `Set-Cookie` anywhere (bearer header design) |
| CORS | Foreign origin, `null` origin, lookalike suffix origin, preflight; allow-listed origin | same | No allow header for foreign origins; exact echo for the allow-listed one; credentials never allowed |
| CSP and headers | Production app headers | same | `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, no `unsafe-eval`, no inline script allowance, nosniff, no powered-by |
| Error leakage | Malformed JSON, oversized body, bad percent-encoding | same | **Bug found and fixed (see section 3)** |
| SSRF | Recording URL allow-list: http, IP literals (v4, v6, decimal, hex), metadata address, userinfo, port, suffix and prefix lookalikes, other schemes, long URLs, protocol-relative, empty; redirects | "SSRF in the recording fetcher" | All refused unless exactly on the configured host list; fetcher uses `redirect: "manual"` |
| Path traversal | Static layout (`express.static` over a dist-like tree) with `..`, encoded, double-encoded, backslash and NUL variants; API id parameters shaped like paths or SQL | "path traversal" | Nothing outside root served; no 5xx |
| Personal data in responses and logs | See `secrets-pii-scan-report.md` | "personal data in API responses" | No stored phone, hash, ciphertext, salt or person id of others |
| Blind-signature token reuse | Replay, cross-survey redemption, forged and altered credentials, key-class mismatch, nonce reuse | existing `tests/civic/surveys/credential.test.ts` and `blind.test.ts` (pointer test in the new suite) | Refused (existing tests) |

Not attacked in this pass: DNS rebinding against an allow-listed recording host (the allow-list is host-name based; an allow-listed host resolving to a private address would pass), real telephony and SMS providers, HSM or KMS, timing side channels, request smuggling through a real proxy or CDN, denial of service beyond the existing rate-limit tests, and anything needing a browser (XSS in rendered user content is only indirectly covered by the CSP assertion and the lite/e2e suites).

## 2. Threat model traceability (T-xx control to automated proof)

The full table with code line references is `docs/THREAT_MODEL.md` section 4A and is machine-checked by `tests/gate/traceability.test.ts`. This table lists the controls and the strongest automated test that exercises each as an attack; "gap" means no automated attack test exists.

| Control | Proof |
|---|---|
| T-01 phone stored hashed and encrypted | `tests/civic/identity.test.ts`; DB-value leakage sweep in `redteam.test.ts` |
| T-02 number intelligence | `tests/civic/hardening/numberintel.risk.test.ts`, `tests/civic/providers/*` |
| T-03 age gate | `tests/civic/identity.test.ts`, `tests/civic/surveys/eligibility.test.ts` |
| T-04 OTP caps | `tests/civic/identity.hardening.test.ts`; `redteam.test.ts` (header-rotation bypass, format tricks) |
| T-05, T-06 network cap, spoofed hints | `identity.hardening.test.ts` (@E2E-75); `redteam.test.ts` bypass tests; load test `npm run load:otp`. PARTIAL by design (address-prefix proxy) |
| T-07 attestation | `identity.hardening.test.ts` (DEV-ONLY) |
| T-08 five adults per SIM | `tests/civic/hardening/recheck.test.ts` |
| T-09 SMS budget | `tests/civic/hardening/sms.delivery.test.ts`, `scripts/load/otp-flood.ts` |
| T-10 to T-12 missed-call, webhook, IVR PIN | `tests/civic/channels*.test.ts` (forged, replayed, stale, altered webhook calls covered) |
| T-13, T-14 lockout, PIN hashing | `identity.test.ts`, `identity.hardening.test.ts` |
| T-15 sessions | `identity.hardening.test.ts`; cookie-only and logout in `redteam.test.ts` |
| T-16, T-17 me-too and dedupe | `tests/civic/issues.test.ts` |
| T-18 minimum cell size | `issues.test.ts`, `tests/civic/surveys/results.test.ts` |
| T-19 naming individuals held | `issues.moderation.test.ts`, `moderation.curation.test.ts`; IDOR on held reports in `redteam.test.ts` |
| T-20, T-21 key provider and rotation | `providers/keys.test.ts`, `hardening/rotation.test.ts`, `breakglass.api.test.ts` |
| T-22 production guards | `tests/civic/guards.test.ts` |
| T-23, T-24 separate stores, pseudonyms | `tests/civic/stores.test.ts` |
| T-25 to T-31 audit chain, anchors, jobs, scrubber | `core.test.ts`, `audit.public.test.ts`, `jobs.test.ts`, `hardening/auditscrub.test.ts`; audit rows scanned in `redteam.test.ts` |
| T-32, T-33 erasure, retention | `identity.test.ts`, `issues.erasure.test.ts` |
| T-34, T-35 admin MFA, dual control, roles | `tests/civic/admin.test.ts`, `core.test.ts`; escalation attempts in `redteam.test.ts` |
| T-36 backups | `tests/ops/backup.test.ts` |
| T-37, T-38 consent notices, invites | `tests/civic/households.test.ts`, `hardening/household-rotation.test.ts` |
| T-39 volunteer enrolment | `identity.hardening.test.ts` (@E2E-151), `hardening/recheck.test.ts` |
| T-40 recording URLs, opaque keys | `channels.ivr.test.ts`; allow-list attack list in `redteam.test.ts` |
| T-41 service worker caching | `channels.size.test.ts` |
| T-42 IVR content | `channels.test.ts` |
| T-43 edge headers, CORS, limits | `tests/server/security.test.ts`, `body.limits.test.ts`; `redteam.test.ts` (CORS, CSP, error bodies) |
| T-44 dev OTP guard | `guards.test.ts` |
| T-45 secret scanning | `tests/tooling/secrets.test.ts`; `scripts/scan-pii.ts` added |
| T-46 sender security, T-47, T-48, T-49, T-51 | NOT BUILT: gap (no control to test) |
| T-50 breach runbook | Documents only: gap |
| T-52 load tests | `tests/load/load.smoke.test.ts`; run recorded in `capacity-run-report.md` |

Residual risks R-01 to R-19 are about organisation, custody, legal and representativeness; none can be proven by an automated attack test. R-04 and R-05 (prefix proxy for ASN, SMS-budget exhaustion) are demonstrated, not closed, by the load test and the bypass tests: a single actor can spend the hourly SMS budget and degrade sign-up by design.

## 3. Bugs found and fixed

1. Information disclosure on malformed or oversized request bodies. A request with invalid JSON reached express' default error handler, which (outside `NODE_ENV=production`) returned an HTML page with the stack trace and absolute server file paths. In production the default handler hides the stack, so the exposure depended on a correctly set `NODE_ENV`; still, the API should never depend on that. Fixed in `server/security.ts` (`buildApiApp`): a terminal error handler answers JSON `{error: "bad_json" | "payload_too_large" | "bad_request" | "internal_error"}` with the original status, and logs only the message of 5xx errors. Test: "error responses do not leak stack traces or file paths" (failed before the fix, passes after).

No other real vulnerabilities were found by these tests. Several first-draft assertions failed because of the test (client URL normalisation of `..`, a backslash URL whose host really is the allow-listed host, wrong table column names); they were corrected and are not findings.

## 4. What remains for humans

- Commission the independent red-team and penetration test (`docs/RED_TEAM_SCOPE.md`); this document must not be attached as a substitute.
- A human reviewer of the threat model against the build (row 1), with name and commit hash.
- Decide on DNS-rebinding protection for recording fetches (resolve and check the address, or fetch through a pinned egress proxy).
- Run the new suite in CI (`npx vitest run tests/civic/hardening/redteam.test.ts`) and re-run it on every release candidate.
