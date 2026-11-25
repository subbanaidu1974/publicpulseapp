# Self-hosted map background (S-191)

The maps draw an OpenStreetMap background (roads, water, place names) **behind** the boundary shapes. The data comes from one file on
this site's own server, so no map provider is ever contacted (see S-190). If the file is not installed, the maps are plain boundary
shapes and nothing breaks.

## How it works

- `server/basemap.ts` serves exactly one file, `GET /basemap/ap-tg.pmtiles`, with HTTP Range support (a PMTiles reader fetches only the
  tiles it needs). There is no path parameter, so no other file can be reached. Missing file: `404 {"error":"basemap_not_installed"}`.
- `src/components/maps/basemap.ts` checks the file exists (one HEAD request), then loads `protomaps-leaflet` **on demand** and adds the layer.
  Pages without a map never download the library. Any failure leaves the plain shapes.
- The country/state border layer from the tiles is removed on purpose: the only borders shown are this app's own boundary shapes.
  Only place names are kept as labels.
- The map credits "© OpenStreetMap contributors" (ODbL) in the corner. Licence record: `data/reference/licences.json` entry `odbl`.

## Installing the file

The file is about 15 MB and is **not in git** (`data/basemap/*.pmtiles` is ignored). Every deployment has to provision it.

```powershell
# one-off: the pmtiles CLI from https://github.com/protomaps/go-pmtiles/releases
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles data/basemap/ap-tg.pmtiles --bbox=76.5,12.5,85.0,19.95 --maxzoom=10
```

Use a recent daily build date for `YYYYMMDD`. To keep the file elsewhere, set `BASEMAP_FILE` (see `.env.example`).
Refresh it every few months; OpenStreetMap changes continuously.

## What is not done

- Detail stops at zoom 10 (districts and major roads). Streets and buildings are not included; zooming further magnifies zoom 10.
- Place names are Latin script only, even with the Telugu interface (the tile data has few Telugu names).
- The file must be provisioned on each deployment; there is no automatic download, and no check that it is recent.
- Counsel has not reviewed the attribution wording, the privacy sentence, or how a foreign-compiled dataset depicts India's external
  borders (this app hides the border layer, but road and place data come from the same source). Treat as unverified before go-live.
