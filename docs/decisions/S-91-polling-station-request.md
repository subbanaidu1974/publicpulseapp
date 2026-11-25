# S-91 decision note: how to obtain a polling-station list, and a request to send

Status: DRAFT for the owner. Nothing has been sent, no list exists in the repository, and the tooling (schema, legal guard, importer, API route) is built and unchanged. Not legal advice. Re-checked 2026-11-24: `ceoandhra.nic.in` answers but its `robots.txt` disallows all crawlers, and `ceotelangana.nic.in` did not respond. So no automated route exists, and none will be tried.

## 1. What is needed (and what must never be loaded)

One row per station: station number, name, assembly constituency number, optional part number, building or landmark text, optional latitude and longitude, plus where the row came from and its date. Use the header in `data/reference/pollingstations/template.csv` (columns `stationNo,name,acNo,partNo,location,lat,lon`; the importer adds `source` and `asOf` from its command line). Never a voter's name, EPIC number, relative's name, age, gender, house number, personal address, phone or photo. A file with such a column is rejected whole, and electoral-roll PDFs are never read (`data/reference/pollingstations/README.md`).

## 2. Routes, in the order I would try them

| Route | How | Cost and limits |
|---|---|---|
| A. Written request to each Chief Electoral Officer | Send the letter in section 3 on the operating entity's letterhead, asking for the station list as a spreadsheet with permission to reuse it | Free; slow; needs the entity and a signatory (S-152). A reply with reuse terms is what the importer needs |
| B. Right to Information application | Same ask, as a request under the RTI Act to each CEO's public information officer | Small statutory fee and a time limit; the answer may come as a roll-part list or PDF, which we must not ingest unless it carries no voter data |
| C. Partner supply | The university or civil-society host (S-152) obtains or already holds the list and supplies it with its own reuse terms | Depends on the partner; check their terms |
| D. Field survey for the pilot mandals only | Volunteers record, for 2 or 3 pilot mandals, each station's building name and landmark from public signage into the template, with the volunteer's name kept out of the file | Slow and error-prone; for a pilot it can be enough; no photos of people, no house or person details |

Do not use scraped copies on GitHub or data brokers: earlier checks found a 2017 scrape with no licence and aggregate datasets that are not station lists (`docs/data/ELECTORS_AND_STATIONS.md`).

## 3. Letter to send (route A)

> To: The Chief Electoral Officer, Andhra Pradesh / Telangana
>
> Subject: Request for the polling-station list and permission to reuse it
>
> We are [entity name, status], a non-profit building a non-partisan civic information service in Andhra Pradesh and Telangana. We would like to show residents where their polling station is, using the published list of polling stations. We request: (1) the current list of polling stations for [state / the following constituencies: ____] as a spreadsheet, with station number, name, assembly constituency number, part number and the building or landmark; (2) written permission to reuse it in the service with attribution to your office, and any conditions on reuse; (3) the date the list is current to. We do not request any electoral-roll or voter-level data and will not store any. Please tell us the contact for corrections.
>
> [Name, role, official email at the entity's domain, phone] [Date]

## 4. When a list arrives

1. File the reply or terms with the date; check that reuse is allowed and what attribution is required.
2. Confirm the file has no voter-level columns (the importer will refuse it if it does, and nothing is stored).
3. Save as `data/raw/pollingstations/AP-<name>.csv` or `TG-<name>.csv`, then run `npx tsx scripts/import-pollingstations.ts --source "<list name and URL>" --as-of YYYY-MM-DD`, then `npm run pipeline:manifest` and `npm run pipeline:attribution`.
4. Record the licence in `data/reference/licences.json` as the register requires, and have counsel look at any publication of lists derived from rolls.

## 5. Decisions for the owner

* Which route first (suggest A and B together, after the entity has a name).
* Whether to run the field survey (D) for the pilot mandals if the CEO routes are slow.
* Who signs the letter for the entity.

S-91 is closed as "what is built" (owner decision 2026-11-24): tooling, template and this request. Loading real station data remains a future item and needs a list with reuse terms.

Send-ready letters, RTI text and reply log: `docs/decisions/polling-station-request-package/`.
