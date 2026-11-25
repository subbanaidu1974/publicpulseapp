# Before sending, reply log and what to do with replies

## Before sending
- [ ] Entity has a name (or the host institution sends it, with the entity described as "forming") and a named signatory (`docs/decisions/S-152-entity-checklist.md`)
- [ ] Addresses taken from each CEO's official contact page; confirm the Telangana site is reachable, since it did not respond on 2026-11-24 and the AP site disallows crawling (we never crawl; this is a human request)
- [ ] Choose the scope: whole state, or only the pilot mandals' assembly constituencies (fewer rows, easier to grant)
- [ ] Decide when to switch to the RTI route (suggest after ____ weeks with no useful reply)
- [ ] No data attached; nothing described as decided

## Reply log

| Date | State | Route | Summary | File kept at |
|---|---|---|---|---|
| ____ | AP | Letter sent | | ____ |
| ____ | TG | Letter sent | | ____ |

## When a list arrives
1. File the reply and terms with the date. Check that reuse is allowed and what attribution is required.
2. Confirm the file has no voter-level columns (the importer refuses it if it does).
3. Save as `data/raw/pollingstations/AP-<name>.csv` or `TG-<name>.csv` (columns as in `data/reference/pollingstations/template.csv`). Run `npx tsx scripts/import-pollingstations.ts --source "<list name and URL>" --as-of YYYY-MM-DD`, then `npm run pipeline:manifest` and `npm run pipeline:attribution`.
4. Record the licence in the data register. Have counsel look at anything derived from electoral rolls.
5. If the reply is a refusal, silence, or a roll PDF: nothing is loaded; roll PDFs are never ingested.
