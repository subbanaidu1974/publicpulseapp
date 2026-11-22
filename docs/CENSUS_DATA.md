# Census data: sources, pipeline and manual drop-in (S-84)

Status as of 2026-11-22: the committed `data/generated/census*.json` are **real Census 2011 counts** (not demo) built from the
District Census Handbook village and town directories. Literacy is **not available** from these files (see below).

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
