# S-141 decision note: officer onboarding, what the owner and admins must decide

Status: DRAFT for the owner, admins and counsel. It proposes; it does not decide. Not legal advice. Nothing here was checked with any government body. The software side is built (`docs/OFFICERS.md`, mail adapter `server/civic/providers/mailgeneric.ts`, simulator-verified only).

## 1. The domain allow-list (`data/civic/officer-domains.json`)

Today it holds `gov.in`, `nic.in`, `ap.gov.in`, `telangana.gov.in`. A match is the domain itself or a subdomain on a label boundary.

| Observation | Why it matters | Proposal for the owner |
|---|---|---|
| `gov.in` and `nic.in` cover every state and central body, not only AP and TG | An officer of another state could pass the domain check; the admins' letter check is then the only barrier for that case | For a pilot in AP and TG, keep `ap.gov.in` and `telangana.gov.in`; keep `gov.in` and `nic.in` only if the admins accept that the letter check must also confirm the posting is in AP or TG |
| Some state staff use `nic.in` mailboxes, and some bodies use other government domains | A genuine officer may be refused | Do not guess domains. Before launch, an admin collects the real addresses used by the pilot departments' offices (from their official websites or a phone call) and adds only those, as a reviewed change |
| A subdomain of an allowed domain passes | Correct for departments, but every subdomain under it is trusted | Confirm with the domain owner (state IT department) that only government bodies get subdomains |

An email at an allowed domain proves only that the applicant controls a government-looking mailbox. It does not prove their posting. That is what the letter check is for.

## 2. Letter checklist for the first admin (template, to be agreed)

The admin ticks the box only if all of these hold. The software records the tick, not the reasoning.

1. The letter names the applicant exactly as in the application.
2. It states a post and department that match the application.
3. It carries an office seal or an official letterhead and a reference number and date.
4. The signing authority and office are named, and the posting is in AP or TG.
5. The admin confirmed the posting by a call to the office number from the department's official directory (never a number on the letter), or by an official posting list. Record the date and which source in the application note.
6. Anything doubtful: reject with a reason. Rejecting needs no second person.

The second admin repeats checks 1 to 4 on the same letter independently before approving. Per-department examples of a genuine posting order must be added by the admins who know them.

## 3. PDF letters (DECISION)

| Option | For | Against |
|---|---|---|
| A. Photo or scan as JPEG or PNG only (today) | Already safe: size cap, safety scan, metadata stripping | Officers may only have a PDF; they can photograph or screenshot it |
| B. Accept PDF | Convenient | Needs a PDF scanner, active-content removal and metadata stripping first (not built) |

Recommendation: A for the pilot; revisit B only if officers report real trouble.

## 4. Mail sender (before production)

Production refuses to start while only the dev mailer is installed. Needed: a mail vendor, a sender address on a domain you control with SPF, DKIM and DMARC set up, the vendor's field names confirmed against `CIVIC_MAIL_*` settings, and one real sandbox send. Until then the code-by-email step cannot run in production.

## 5. Legal and retention (for counsel)

What is stored about officials: name and work email (encrypted), the email domain (clear), the letter (180 days by default, purged on erasure). Counsel to confirm the purpose, notice wording, retention and who may read the letter. See `docs/RETENTION.md`.

## 6. Telugu review

The officer screens and the allow-list body names have machine-drafted Telugu. A native speaker must review them.

S-141 stays in progress until sections 1 to 6 have written answers and a real mail send has been done.
