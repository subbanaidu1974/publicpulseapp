# Email accounts for people with no phone (S-165, S-167)

Status: built and tested against the dev mail provider only. A real mail vendor (S-141 section 4, `docs/PROVIDERS.md` 2b) is needed before any real email can leave. The Telugu text on the screens is machine-drafted and needs a native reviewer.

## What it is

A resident with no phone number can sign up and sign in with an email address, a code sent to that address and a personal PIN. After that the account behaves like any other: same PIN rules, lockout, sessions, consent notice and erasure.

| Step | Route (under `/api/v1/civic/identity`) |
|---|---|
| Ask for a code | `POST /signup/email/request { email }` |
| Create the account | `POST /signup/email/verify { email, otp, pin, consent_version }` |
| Sign in | `POST /login/email { email, pin }` |
| Forgot PIN | `POST /pin/recover/email/request`, then `POST /pin/recover/email { email, otp, new_pin }` |
| Add a phone later (S-167) | `POST /signup/request { phone }`, then `POST /phone/add { phone, otp }` (signed in) |

## What an email account cannot do, and why

An address is far cheaper to create in bulk than a SIM, and one person, one voice is the point of the survey design. So an email-only account carries the flag `email_only`:

* It can report and follow issues, like any resident.
* It is **not survey-eligible**, however old it is. The flag clears only when the account adds a phone number (S-167), after which the normal 14-day waiting period and number checks apply (a VoIP number is refused; a recently re-issued number keeps the account ineligible).
* It cannot link a SIM or add household members (those need a phone).
* It does not receive SMS-based features (notifications, IVR).

## Abuse limits

* Gmail dots and `+tags` are folded before hashing, so `a.b+x@gmail.com` is the same account as `ab@gmail.com`. A short list of throwaway-mail domains is refused; add more with `CIVIC_EMAIL_BLOCKED_DOMAINS` (comma list).
* Code requests are limited per address (3 per 10 minutes), per IP, per device and per network, and overall by `CIVIC_EMAIL_HOURLY_BUDGET` (default 2000 an hour).
* A code lasts 5 minutes, works once, and burns after 5 wrong tries. A failed mail send drops the code so a retry works at once.
* The code request answers the same whether or not the address already has an account (no enumeration). An address that already has an account is told so in the email and gets no usable code.
* Sign-in uses the same per-source and per-address ceilings and 30-minute lockout as phone sign-in.

## What is stored

The address is stored as a keyed hash (`email_hash`) and an encrypted copy (`email_enc`), both under the existing contact-identifier key ("phone" purpose, value `email:<address>`), so key rotation covers it (`EMAIL_REHASH` in `server/civic/providers/rehash.ts`). The clear address appears in no table, log or audit row; erasing the account clears both columns.

## Not done

* No real mail vendor, SPF, DKIM or DMARC set-up; no deliverability check against real inboxes.
* No counsel review of the email text or of holding an address as a contact identifier (add to `COUNSEL_PACK.md` questions on contact data).
* Telugu text unreviewed.
* Email-based notifications and issue-update emails for email-only accounts are a later story.
