# Secrets and PII scan (internal self-assessment, not independent)

Date: 2026-11-24. Tooling added: `scripts/scan-pii.ts` (`npm run scan:pii`, `-- --json`), plus the existing `scripts/check-secrets.ts` (`npm run scan:secrets`). No external tool (gitleaks, trufflehog) was installed or run; CI is said to run gitleaks, which was not verified here. This is regex triage, not an audit.

## Method

`git ls-files` (tracked files only) scanned for: private-key blocks, AWS, GitHub, Slack, Stripe and Google keys, JWTs, credentialed URLs, long literals assigned to secret-like names, Indian mobile numbers, Aadhaar-shaped and PAN-shaped numbers, e-mail addresses, log statements naming a personal field, and tracked files that should not exist (env files, databases, key material, backups).

## Results

- `npm run scan:secrets`: 0 findings.
- `npm run scan:pii`: 0 high, 5 medium, about 245 info.
  - Medium, triaged as benign: `scripts/check-secrets.ts` and `scripts/countday-verify.ts` (log lines mention a word such as "secret-scan" or a `--pin` flag, no value), `scripts/load/otp-flood.ts:75` and `server/civic/identity/service.ts:144-145` (fixed dev-fixture phone numbers labelled as stubs).
  - Info: test fixtures with fake numbers (about 235), documentation e-mails (CERT-In contact, `.env.example` placeholder), the scanner's own test fixture for a private-key header.
- Tracked sensitive files: only `.env.example`. No database, key or backup file is tracked now.
- Git history: pattern searches (`git log --all -G`) for private keys, AWS keys, GitHub and Slack tokens outside tests and docs found nothing. History does contain two removed files `data/backups/pre-migrate-*.db` (untracked in commit 1313615). They were opened read-only: `persons` 0 rows, `sessions` 0, `otps` 0 (the survey backup has none of those tables). No personal data. If the repository is ever published, a history rewrite is still advisable for hygiene.
- Logs: the new test "server logs and audit rows carry no phone, PIN or OTP" in `tests/civic/hardening/redteam.test.ts` captures stdout and stderr across sign-up, a failed login and a recovery request and asserts the phone number, its tail digits and the session token never appear, and the same for every `audit_log` row.

## API response leakage check

Automated: `tests/civic/hardening/redteam.test.ts`, "no response ... contains the stored phone, hashes, ciphertext, salts or session hashes". It creates two residents, a report, a me-too and consultation feedback, reads the real `phone_hash`, `phone_enc`, `pin_hash`, `pin_salt`, `residence_enc` and session `token_hash` from the database, fetches about 25 GET endpoints anonymously, as another resident and as the owner, and asserts none of those values (nor the clear phone) appears, and that no response to anyone else carries the owner's person id. It also asserts the sweep reached more than 15 real 200 responses. Admin, moderation and staff views are covered by role-gate tests, not by this leakage sweep.

## Limits

Regexes miss secrets without a recognisable shape and anything outside tracked files (the deployed environment, CI settings, the host). Free-text audit metadata (threat model risk R-08) is protected only by the scrubber and was exercised by the flows above, not exhaustively.
