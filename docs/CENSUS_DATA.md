# Census data: sources, pipeline and manual drop-in (S-84)

Status as of 2026-11-24: the committed `data/generated/census*.json` are **real Census 2011 counts** (not demo) built from the
District Census Handbook village and town directories, with **literacy merged from the Primary Census Abstract (PCA)** (section below).

## What is reachable (checked 2026-11-22)

| Source | Result |
|---|---|
| data.gov.in API | Needs `DATA_GOV_IN_API_KEY` and `DATA_GOV_IN_RESOURCE_ID`; none supplied, so not used. `scripts/fetch-census.ts` still supports it (district PCA CSV columns). Licence would be GODL-India. |
| Census Digital Library (`censusindia.gov.in/nada/index.php/catalog/`) | Catalogue is public. **District Census Handbook entries (checked: catalog/120 Hyderabad, 123 Visakhapatnam) download without login (HTTP 200, no sign-in)**; each links the state-wide `DH_2011_DCHB_Village_Release_2800.xlsx` (resource 144 on catalog/123, ~54 MB, 27,800 villages) and `DH_2011_DCHB_Town_Release_2800.xlsx` (resource 145, 355 towns). Microdata ("get-microdata") says "Data Access Not Available". The handbook PDF (and its inset-tables zip) carries the PCA tables with literacy and workers but was not parsed; no machine-readable state PCA file was found without login. The server stalls near the end of the 54 MB file: use the retrying downloader below. |
| Dataful dataset 182 (CD-block PCA, Andhra Pradesh) | Page is public and shows CSV/XLSX/Parquet download buttons (2.68M rows, CD-block PCA by category, 2011), but the licence is "Custom license" and whether the download is free or needs a sign-in was **not confirmed** (a guessed direct URL returned 404). **Not ingested.** Read the terms first. |
| GitHub mirrors | A repository search for Census 2011 PCA village data for Andhra Pradesh returned nothing usable. |

Licence of the Census Digital Library files: only "Rights: ORGI" is stated, no open licence. This is a human decision recorded in
`data/reference/licences.json` (key `census-orgi-2011`) and `docs/ATTRIBUTION.md`.

## Ingest the DCHB directories

```
npm run pipeline:census:dchb -- --download     # fetch both xlsx into data/raw/census/dchb/ (gitignored), then ingest
npm run pipeline:census:dchb                   # re-ingest from the files already in data/raw/census/dchb/
npm run pipeline:manifest && npm run pipeline:validate
```

Outputs (all keyed by **Census 2011 codes**, so LGD census codes join directly):

* `census.json` districts: 13 AP + 10 TG (2011 districts, codes 532 to 541 = Telangana, 542 to 554 = Andhra Pradesh).
* `census-subdistricts.json` sub-districts (mandal/taluk), 5-digit code; `00000` = towns spread over more than one sub-district.
* `census-units.json` villages (kind V, 6-digit code) and towns (kind T): households, population, males, females, SC, ST.

Verification: state totals equal the published Census 2011 populations (AP 49,386,799; TG 35,193,978).

Limits to state in the UI: counts are 2011 and use 2011 district boundaries (AP 13 and TG 10 districts, not today's 28 and 33);
no literacy, workers or age fields; uninhabited villages have population 0. A crosswalk from 2011 districts and sub-districts to
the LGD units belongs with the LGD ingest.

## Manual drop-in (what to supply if you have a better file)

Put CSV files in `data/raw/census/` (or set `CENSUS_RAW_DIR`) and run `npm run pipeline:census`. Order of precedence: data.gov.in
API, drop-in CSVs, the existing non-demo `census.json` (kept), and only then the demo fixture.

1. **District PCA CSV** (header must contain `State`): `State,District,TOT_P,TOT_M,TOT_F,P_SC,P_ST,P_LIT` (state code 28 = AP, 36 = TG).
   This is the only route that carries literacy. Provenance becomes `manual-csv`.
2. **Village/town unit CSV**: `kind,district_code,district,subdistrict_code,subdistrict,code,name,households,population,males,females,sc,st`
   (kind `V` or `T`; district codes 532 to 554). Rolled up into districts and sub-districts; provenance `manual-csv`.

## What is needed from you for full PCA (literacy, workers)

One of: a `DATA_GOV_IN_API_KEY` plus the resource id of the Census 2011 PCA dataset; or a PCA CSV/xlsx (district and sub-district
level, state codes 28) dropped into `data/raw/census/`; or your approval after reading the Dataful dataset 182 terms (and a sign-in if required).

## Literacy from the Primary Census Abstract (added 2026-11-24)

Source: Census Digital Library, "PCA TV: Primary census abstract at town, village and ward level, Andhra Pradesh - District X - 2011",
catalog 6723 to 6745 (23 workbooks `DDW_PCA2801_2011_MDDS with UI.xlsx` ... `DDW_PCA2823_...`, download id = catalog id + 3077). Downloads
return HTTP 200 with no login; the pages state no licence beyond the site footer (c) ORGI Digital Library, so the `census-orgi-2011` register entry
(needs a human decision) still applies. The state/district file (catalog 6191) agrees with the district rows.

```
npm run pipeline:census:dchb -- --download           # base counts (rewrites the three census files without literacy)
npx tsx scripts/ingest-pca-literacy.ts --download    # then merge literacy (idempotent)
npm run pipeline:manifest && npm run pipeline:attribution && npm run pipeline:validate
```

Result: all 23 districts (`literate`, `pop0to6`, `literateMales`, `literateFemales`, `literacyPct`); 1,101 of 1,118 sub-districts; 28,095 of 28,155 village/town units
(`literate`, `pop0to6` appended to `census-units.json` columns). `literacyPct` is the official rate, literates over population aged 7 and over, not literates over total population.
Left without literacy, never estimated: 60 towns whose PCA population differs from the DCHB figure (towns with outgrowths, e.g. Ramagundam, Karimnagar, GHMC part) and the 17
sub-districts that depend on them, including the "00000" multi-sub-district towns bucket.
The place-profile route (`server/geo-api.ts`) now serves literacy (`literate`, `pop0to6`, `literacyPct`) for district, mandal and village profiles; units without PCA literacy keep `literacyPct: null` with a `literacyNote` reason (never estimated).

## Constituency literacy and town rows (added 2026-11-24, S-84 follow-up)

* **Town rows.** `server/geo-api.ts` now also reads the kind-T rows of `census-units.json`. An LGD village whose category is urban and whose Census 2011 code is a town code (111 across AP and TG, for example Dasnapur (CT)) shows the town's population, SC/ST, sex ratio and literacy on its place profile (`census.kind` is `town`). Towns without PCA literacy (the 60 towns with a population mismatch) keep `literacyPct: null` and the not-available note. Rural aggregates are unchanged because villages and towns are held in separate maps.
* **Constituency literacy.** `GET /api/v1/constituencies/:state/:acNo` adds `census.literacy`: literates over (population minus age 0 to 6) summed over the whole village units linked to the AC plus the town rows reachable through the AC's LGD villages and urban bodies (each census code counted once). It is always labelled `approximate: true`: census units do not follow constituency boundaries, an urban body listed under more than one AC is counted in full in each (`splitUnits`, 13 bodies are listed under more than one AC), wards and census towns with no LGD link are not mapped, and units without PCA literacy are left out of the rate (`literacyCoveragePct` states how much of the mapped population carries literacy). Nothing is estimated or apportioned. Constituencies with no mapped unit show not available.
* Gap: only 120 of the 355 census towns link to an LGD urban body by census code, so urban constituencies (for example Hyderabad) are mostly not available.
