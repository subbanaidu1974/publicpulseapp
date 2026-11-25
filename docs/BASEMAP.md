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
- The tiles carry no Telugu names at all (see below), so the Telugu names cover towns only, not villages or road names.
- The file must be provisioned on each deployment; there is no automatic download, and no check that it is recent.
- Counsel has not reviewed the attribution wording, the privacy sentence, or how a foreign-compiled dataset depicts India's external
  borders (this app hides the border layer, but road and place data come from the same source). Treat as unverified before go-live.

## Telugu place names (S-192)

The Protomaps tiles name places in about 35 languages but **not Telugu** (checked: no `name:te` on any place). So in the Telugu interface
the tiles' own place labels are switched off and town names are drawn from our own list instead:

- `data/generated/geo/places-AP.json` and `places-TG.json`: towns of at least 30,000 people that have a Telugu label on Wikidata (CC0),
  served at `GET /api/v1/geo/:state/places.json`. Refresh with `npm run pipeline:places-te` (2 requests to query.wikidata.org).
- Never guessed: items with no Telugu label are left out and counted in the file's `note`. Districts, mandals, constituencies and wards that
  Wikidata also lists with a population are filtered out, and so are items whose coordinates fall outside AP and TG.
- Labels are plain text (the site's self-hosted Telugu font), thinned by zoom so the map never fills with names. They ignore clicks.
- In English the tiles' own English labels are used and none of this runs.

Known limits: 183 towns in all, so smaller towns and villages have no label; some entries are localities or mandal-sized populations rather
than municipal towns (for example Jubilee Hills, Tuni); the spelling is whatever Wikidata holds (for example "వరంగల్ నగరం", Warangal city) and
has not been checked by a Telugu reader.

## Telugu village names (S-193)

When zoomed in (about district level and closer) the Telugu interface also labels villages:

- `data/generated/geo/village-labels-AP.json` and `village-labels-TG.json`, served at `GET /api/v1/geo/:state/village-labels.json`.
  Built offline (no download) by `npm run pipeline:village-labels` from the village location points (Wikidata CC0, then OpenStreetMap ODbL for
  the rest) joined to the Telugu names the LGD directory holds. Names are shown exactly as LGD has them (a few carry tags such as "- టి").
- **Coverage** (S-196 raised Andhra Pradesh from 59 to about 15,700): Telangana 4,193 villages (LGD has Telugu names for 11,365 of 11,447, but
  only about 4,200 have a location point). Andhra Pradesh about 15,700: LGD holds Telugu names for just 372 of 17,957 AP villages, so the rest come
  from Wikidata (CC0), matched to the LGD village by Census 2011 code (`data/generated/geo/village-names-te-AP.json`, refreshed with
  `npm run pipeline:village-names-te`, one request to query.wikidata.org). LGD's own name always wins where it has one. Wikidata names have not
  been checked by a Telugu reader, and a few places can carry a label that is a different spelling from the local one.
- Each state's file (Andhra Pradesh about 0.85 MB) is fetched only when the zoomed-in view overlaps that state.
- Labels are placed on a coarse pixel grid so they do not pile up (at most 400 at once), towns first. Locations are approximate place points,
  so a label can sit a little off the real village. English never shows village labels.
