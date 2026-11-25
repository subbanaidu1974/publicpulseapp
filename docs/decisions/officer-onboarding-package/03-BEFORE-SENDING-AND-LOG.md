# Before sending, what to do with replies, and reply log

## Before sending
- [ ] Entity has a name and a named signatory (`docs/decisions/S-152-entity-checklist.md`)
- [ ] Pilot mandals and departments chosen; each office's address and phone taken from its own official website or directory
- [ ] Counsel has approved the notice enclosed with the office letter (gate row 13). Do not send the invitation (02) until the officer notice is approved
- [ ] The mail sender (S-141 note section 4) is set up before officers apply; until then the code-by-email step cannot run in production
- [ ] Two administrators named for the letter check (`docs/OFFICERS.md`, S-141 note section 2)
- [ ] Telugu officer screens and the invitation text reviewed by a native speaker

## What replies change in the repository
* Domains given by an office or the state IT department: add only those, one by one, as a reviewed change to `data/civic/officer-domains.json` with the source and date recorded. If the reply says `gov.in` or `nic.in` are too wide for the pilot, narrow the list.
* Directory phone numbers: store in the admins' private records, not in the repository.
* A refusal or silence: that office's officers are not invited. Do not apply pressure or go around the office.

## Reply log

| Date | Office or department | Letter | Reply summary | Domains or numbers noted (where kept) |
|---|---|---|---|---|
| ____ | | Sent | | |
