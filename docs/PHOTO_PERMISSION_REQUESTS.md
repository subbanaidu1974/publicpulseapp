# Draft requests: permission to use official member portraits

**Status: drafts only. Nothing here has been sent.** Fill the `[PLACEHOLDERS]`, have counsel read each letter, and check the
current contact address on the secretariat's own website before sending. Do not send from this file's wording alone if counsel
changes the licence terms you are willing to accept.

Why we ask: only 28 of 294 assembly winners have a free-licence photo today (S-198). Official portraits would cover nearly every
member, but we have not checked the terms of use of any official site and will not copy a photo until permission is in writing.

What we can promise (true today, change nothing without checking): photos are copied once to our own server and shown only on the
member's constituency page; every photo carries the credit line you specify; we do not alter the image beyond resizing to
320 px wide; we do not use photos in advertising or for any political party; we remove a photo within [N] days of a request.

---

## 1. Telangana Legislature Secretariat

To: The Secretary, Telangana Legislature Secretariat, [ADDRESS / EMAIL FROM THE OFFICIAL WEBSITE]

Subject: Request for permission to display official portraits of Members of the Legislative Assembly

Respectfully,

We run People Pulse ([SITE ADDRESS]), a public information website that shows the election history, electors and census figures
of each Telangana assembly constituency. [ONE SENTENCE ON WHO YOU ARE: ORGANISATION, NON-COMMERCIAL OR NOT.]

We would like to show the official portrait of each sitting Member of the Legislative Assembly on the page of the member's
constituency, with the credit line you prefer (for example "Photo: Telangana Legislature Secretariat").

We ask for the following, in writing:

1. Permission to copy the official member portraits published on [WEBSITE ADDRESS] to our server and display them as described.
2. The credit line, and any conditions, you want shown with them.
3. Whether the portraits may be reused for later assemblies without asking again, or must be requested after each election.
4. A contact for corrections and removals.

We do not use the photos for advertising, for any party or candidate, or for any purpose other than identifying the member on
the constituency page. We will remove any photo promptly on request.

Thank you for your consideration.

[NAME, ROLE, ORGANISATION, ADDRESS, EMAIL]

---

## 2. Andhra Pradesh Legislature Secretariat

To: The Secretary, Andhra Pradesh Legislature Secretariat, [ADDRESS / EMAIL FROM THE OFFICIAL WEBSITE]

Subject: Request for permission to display official portraits of Members of the Legislative Assembly

*(Same text as letter 1, replacing "Telangana" with "Andhra Pradesh" throughout, the website address with the Andhra Pradesh
legislature's, and the example credit line with "Photo: Andhra Pradesh Legislature Secretariat".)*

---

## 3. Lok Sabha Secretariat

To: The Secretary-General, Lok Sabha Secretariat, [ADDRESS / EMAIL FROM sansad.in]

Subject: Request for permission to display official portraits of Members of the Lok Sabha from Andhra Pradesh and Telangana

Respectfully,

We run People Pulse ([SITE ADDRESS]), a public information website that shows election results, electors and census figures for
Andhra Pradesh and Telangana. [ONE SENTENCE ON WHO YOU ARE.]

We would like to show the official portrait of each of the 42 Members of Parliament elected from these two states (25 and 17
constituencies) on the page of the member's parliamentary constituency, with the credit line you prefer.

We ask, in writing, for: (1) permission to copy the portraits published on sansad.in to our server and display them as
described; (2) the credit line and any conditions; (3) whether the portraits may be reused after the next general election
without a new request; and (4) a contact for corrections and removals.

We do not use the photos for advertising, for any party or candidate, or for any purpose other than identifying the member. We
will remove any photo promptly on request.

Thank you for your consideration.

[NAME, ROLE, ORGANISATION, ADDRESS, EMAIL]

---

## Notes before sending

- **Right of Information route:** if no reply comes, counsel may advise whether a request under the Right to Information Act is
  appropriate for the terms of use of the official portraits. We have not taken that advice.
- **Election Commission affidavit photos** are a separate request (the Commission, or the state Chief Electoral Officer). They
  are photos supplied by candidates, so the Commission may not be able to give permission for them. Not drafted.
- **Lok Sabha coverage in our data:** no Lok Sabha winner has a photo yet. Wikidata and Commons matching for them was not completed.
- **If permission arrives:** add the credit line as a licence record in `data/reference/licences.json`, extend
  `data/reference/winner-photos.json` with the new entries, and run `scripts/fetch-winner-photos.ts` (that script currently
  accepts only open licences, so it will need a small change to accept a written-permission entry).
