# SHRUG village polygons: where they come from and how to refresh them

Status 2026-11-24: the file below was downloaded once into `data/raw/shrug/` (git-ignored) and ingested. This page is the repeatable procedure, for a new SHRUG release or a fresh checkout. The licence is CC BY-NC-SA 4.0 and only valid while the service is non-commercial: read `docs/NONCOMMERCIAL.md` first.

## What to download

| Item | Value |
|---|---|
| Official page | https://www.devdatalab.org/shrug_download/ (section "Open Polygons and Spatial Statistics") |
| Row | "PC11 Village Polygons" (2011 Census town and village geometries), the **SHP** button |
| File | `shrug-pc11-village-poly-shp.zip` (SHRUG v2.2 "Pakora", file dated 2026-08-14) |
| Size | 374,178,800 bytes (about 357 MiB); unpacks to about 960 MB |
| SHA-256 (as downloaded 2026-11-24) | `a72277cb0b09bf560c270305c61e8cef19a945eb9023977f2e291c184e0e4def` |
| Inside | `village_modified.shp/.shx/.dbf/.prj/.cpg`, `README.md`, `open_poly.bib` |
| Features | 649,618 national polygons; 28,207 have Census state id 28 (undivided Andhra Pradesh: AP and TG) |
| Columns | `pc11_s_id`, `pc11_d_id`, `pc11_sd_id`, `pc11_tv_id` (6-digit Census village or town code), `tv_name`, `mdds_og` |
| CRS | WGS 84 (EPSG:4326) |
| Licence shipped | `README.md` in the zip: "Copyright (C) 2026, Development Data Lab ... licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License" |

The GeoPackage variant (`shrug-pc11-village-poly-gpkg.zip`) holds the same data; the pipeline reads the shapefile.

The Harvard Dataverse mirror linked from the SHRUG page (doi:10.7910/DVN/DPESAK) lists 325 SHRUG tables but no polygon files, so the download page is the only source of the polygons.

## Access: what was observed

On 2026-11-24 the download page needed no login, form or checkbox. The button starts a direct download from an Amazon S3 link that the page signs and that expires, so do not save or share the link: click the button yourself each time. The page footnote says that accepting data from Development Data Lab means accepting its disclaimer (no warranty, no liability) and asks you to cite the creators (bibtex in `open_poly.bib`). If the page ever adds a registration or terms step, stop and complete it yourself as the operator; nothing in this repository accepts terms for you.

## Steps for the owner

1. Open https://www.devdatalab.org/shrug_download/ in a browser and find "PC11 Village Polygons". Click **SHP** (the primary button is GPKG).
2. Save `shrug-pc11-village-poly-shp.zip`.
3. Create the folder `data/raw/shrug/` in the project if it does not exist (it is git-ignored).
4. Extract the zip there so `data/raw/shrug/village_modified.shp` and `village_modified.dbf` exist (a subfolder is fine; the script searches for `village*.shp`). Keep the zip in the same folder if you want its checksum recorded in the output.
5. Run, offline:

```
npm run pipeline:shrug
npm run pipeline:manifest
npm run pipeline:attribution
npm run pipeline:validate
```

`pipeline:shrug` never touches the network. It exits with code 2 and a pointer to this page if no shapefile is found.

## What the pipeline does

* Keeps features with Census state id 28, joins them by the 6-digit Census 2011 village code to the LGD villages (`data/generated/geo/lgd-{AP,TG}.json`, column `census`). AP or TG comes from the LGD file that lists the code, so pre-2014 AP districts that are TG now are handled; the Census district id of the polygon must equal the district in `census-units.json` or the polygon is rejected.
* Simplifies with Douglas-Peucker (tolerance scales with village size, 2e-5 to 1.2e-4 degrees) and rounds to 5 decimals.
* Writes `data/generated/geo/villages-shrug/polygons-{AP,TG}.json` (served per mandal by `GET /api/v1/geo/:state/village-polygons?mandal=`) and `coverage.json` (join rate and unmatched list).

## Result of the 2026-11-24 run

* AP: 17,434 polygons for 17,487 LGD villages that carry a Census code (99.70%); 17,957 LGD villages in total.
* TG: 10,549 for 10,637 (99.17%); see `coverage.json` for the totals.
* 28,207 SHRUG features of state 28: 27,987 matched (4 villages split over several polygons were merged), 175 are towns (Census town codes), 45 villages have a Census code that is not an LGD village of AP or TG. No district disagreements.
* Vintage: Census 2011 boundaries. Villages created, merged or renamed since 2011 may differ from the current LGD list; the join is by Census code only.
