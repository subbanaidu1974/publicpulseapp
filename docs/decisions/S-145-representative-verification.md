# S-145 decision note: who verifies elected representatives, and what must be agreed before launch

Status: OWNER CHOSE OPTION A on 2026-11-24 for the pilot (section 1); sections 2 to 5 remain open. Option B may be pursued in parallel. This note otherwise proposes; it does not decide. Not legal advice. The code already enforces "two admins grant the role for one constituency" (`docs/REPRESENTATIVES.md`); what is missing is the human process around that grant.

## 1. Who verifies (DECISION for the owner)

| Option | How it works | Strength | Weakness |
|---|---|---|---|
| A. Two platform admins check a public record | The applicant names the constituency; admin 1 finds the member in the Election Commission result or the state gazette and checks the applicant's official email domain (assembly or parliament) and a callback to the office number printed in the official directory; admin 2 repeats the check independently; then the dual-control grant is made | No outside party needed; every step is audited | Depends on admin care; a callback number must come from an official directory, never from the applicant |
| B. Legislature secretariat confirms | The assembly or parliament secretariat sends a one-line confirmation for each member | Strongest | Needs an agreement with the secretariat; slow; may be refused |
| C. Party confirms | Party office confirms its members | Easy to get | The party is not neutral; a rival could be refused. Not recommended |

Recommendation: A for a pilot, with B pursued in parallel. Never C.

## 2. Checklist for option A (each item recorded in the grant's audit note, no document copies kept)

1. The constituency and the winning member for the latest election match the Election Commission result (compare with `/api/v1/elections` for that seat; a by-election or a death or resignation since then needs the gazette).
2. The applicant writes from an official legislature or parliament email domain; the email-ownership code (as for officers, S-141) is confirmed.
3. A callback to the member's office using a number from the official directory, not from the application.
4. A second admin repeats steps 1 to 3 without seeing the first admin's notes, then approves the grant.
5. The grant names exactly one constituency. A member who loses a seat, resigns or dies has the grant revoked on the day the gazette or the Election Commission records it. Review every grant after each general election and after each by-election.

## 3. Questions for counsel (DECISION, not answered here)

* Defamation duty: the platform shows a representative's text beside a citizen's issue. Who is the publisher for a held, approved or removed reply, and what is the takedown route and response time?
* May a representative reply publicly during a model code of conduct period, and does a scheme tag count as promotion?
* Is it acceptable that replies are labelled by constituency and not by name or party (the current design, so no representative gets more visual weight)?
* Records: how long are audit entries about a grant kept, and who may see them?

## 4. Department agreement (before any real grievance system is connected)

The adapter contract (`server/civic/representatives/grievance.ts`) forwards category, department, village and constituency codes, sanitised public text and scheme tags. It never sends the reporter's identity or exact location. Agree with the owning department, in writing: which tickets it accepts, how it returns a reference and status, its credentials and rate limits, who is the technical contact, and what happens if it is down. Nothing is connected until then; with no adapter the routes answer 501.

## 5. Other human steps still open

* The programme owner approves `data/civic/schemes.json`; a native Telugu reviewer checks the scheme labels and the reply screens.
* One trained moderator pool for the reply queue (a moderator cannot review their own reply).

Nothing in this note was run against a real legislature, department or counsel. S-145 stays in progress until sections 1 to 4 have written answers.
