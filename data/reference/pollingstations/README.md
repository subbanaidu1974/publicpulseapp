# Polling-station reference list (S-91)

This folder documents the **only** polling-station data the app accepts: a reference list of stations, never voter-level data.

## What is accepted

One row per polling station:

| Field | Meaning |
|---|---|
| `stationNo` | Station number inside the AC, 1-4 digits and an optional letter (12, 12A) |
| `name` | Station (building) name, up to 120 characters |
| `acNo` | Assembly constituency number (ECI numbering) |
| `partNo` | Roll part number the station serves (optional) |
| `location` | Building or landmark text, up to 200 characters. Never a person's address |
| `lat`, `lon` | Optional; both or neither |
| `source` | Where this row came from (CEO list name / URL) |
| `asOf` | ISO date of the list |

The machine-readable schema is `schema.json`.

## What is refused (legal guard)

Any column or field that is voter-level: elector name, EPIC number, relative / father / husband name, age, gender, house number,
an individual's address, phone, photo, Aadhaar. A CSV with such a column is rejected as a whole (it is an electoral-roll extract);
an EPIC-, phone- or Aadhaar-shaped value in any field rejects the row. Electoral-roll PDFs are never ingested, read or stored
(docs/DESIGN_2028.md, sections 3.4 and 8). Counsel review is needed before any publication of lists derived from rolls.

## How to load a list (operator)

1. Obtain the polling-station list published by the CEO / ECI with the right to reuse it, as a CSV with the columns above.
2. Save it as `data/raw/pollingstations/AP-<anything>.csv` or `TG-<anything>.csv` (this folder is gitignored).
3. `npx tsx scripts/import-pollingstations.ts --source "<list name and URL>" --as-of YYYY-MM-DD`
4. `npm run pipeline:manifest && npm run pipeline:attribution`

The API then serves `GET /api/v1/geo/:state/polling-stations?ac=<acNo>`. No station data ships with the repository; the CEO / ECI
sources were unreachable or blocked when this was built, so the list is empty until an operator supplies one.


## Template and how to ask for a list

`template.csv` is a header-only file with the accepted columns. How to request a list from the Chief Electoral Officers, by letter, RTI or a pilot field survey, is in `docs/decisions/S-91-polling-station-request.md`.
