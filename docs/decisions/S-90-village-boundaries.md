# ADR S-90: village boundaries for AP and TG under an acceptable licence

Status: **PROPOSED. The owner decides** (items marked DECISION). Date: 2026-11-24. Research-level, not legal advice; counsel must confirm anything touching ODbL scope.

## Context

The drill-down map and place profiles want village geometry. The only complete village polygon set found earlier is SHRUG (Development Data Lab), built on 2011 Census polygons and published under CC BY-NC-SA 4.0 (re-read 2026-11-24 at devdatalab.org/shrug: commercial use needs a separate licence from the lab; the page states no separate licence for the polygons, so the same terms are the only terms shown). A public civic app cannot rely on non-commercial and share-alike terms without a decision (docs/ATTRIBUTION.md, `datameet-nc-sa`). **SHRUG data is not used anywhere in this repository.**

## Options

"Checked" = I read or queried it on 2026-11-24 from this build machine. "Recalled" = from memory of the source's published terms, not re-verified here; confirm before relying on it.

| Source | Licence | Geometry | AP / TG coverage | Obstacles | Verdict |
|---|---|---|---|---|---|
| SHRUG village polygons (2011 Census based) | CC BY-NC-SA 4.0 (checked) | polygons, ~all villages | complete | NC and share-alike. Commercial use needs the lab's licence. | Not used. DECISION: seek a written licence from Development Data Lab, or leave it. |
| Wikidata (P5578 census code + P625) | CC0 (stated by Wikimedia; recalled) | points | AP 17,570 items with code and coordinates, TG 794 (checked by query) | Crowd/bot-imported coordinates, mostly from a 2011-era import: precision about 0.01 degree; TG largely unimported. | **Used (points, CC0).** |
| OSM `place=village/hamlet` nodes | ODbL 1.0 (recalled, openstreetmap.org/copyright) | points | Uneven; measured by this ingestion, see below | Share-alike on derived databases; name-only join to LGD (no census code on nodes). Overpass must be used sparingly. | **Used (points, ODbL, gap-fill only, separate file).** |
| OSM village polygons (`boundary=administrative`, admin_level 9/10, or `landuse=residential` places) | ODbL | polygons | Very sparse in India: village boundaries are not an OSM convention here. Not measured at scale (Overpass relation queries are heavy; not run). | Same share-alike. Admin levels 9/10 are not consistently villages. | Not ingested. No usable coverage expected; revisit with a Geofabrik extract if polygons are wanted. |
| DataMeet maps | CC BY 4.0 by default, repo MIT (checked on the repo page) | states, districts, ACs, PCs | no village or subdistrict level listed | Nothing at village level. | Already used for AC/PC/district. No village data. |
| Survey of India / Bhuvan (NRSC) village boundaries | Government terms; restrictive, login/ordering, data-sharing policy (recalled, not read) | polygons | national | Not an open licence; automated download likely disallowed; redistribution unclear. | Not used. DECISION: write to NRSC/SoI for a permission letter if polygons are essential. |
| Census of India (ORGI) village maps / shapefiles | ORGI rights reserved; maps sold, no open licence (recalled; the census catalogue entry already needs a decision, see `census-orgi-2011`) | polygons | national | Not openly released. | Not used. |
| LGD (Local Government Directory) | Government public data (see `lgd-public`) | none (names, codes, hierarchy only) | complete hierarchy | No coordinates or polygons at all. | Used for the code spine only. |
| data.gov.in (GODL-India) | GODL-India (recalled) | any dataset the owner finds; village boundaries not located | unknown | Needs a key; I did not find a village polygon dataset on it. | Open: operator could search with a key. |
| GeoNames | CC BY 4.0 (recalled) | points | populated places, uneven | Names transliterated differently from LGD; no census code; not queried here. | Possible extra gap-fill, not built. |

## What was built (points, not polygons)

* `pipeline/geo/villagepoints.ts`, `scripts/fetch-village-points.ts` (`npm run pipeline:villages`), outputs under `data/generated/geo/`:
  `village-points-wikidata-{AP,TG}.json` (CC0), `village-points-osm-{AP,TG}.json` (ODbL, only villages Wikidata does not cover), `village-points-coverage.json` (honest gaps).
* Join rules: Wikidata by Census 2011 village code (confidence 1.0, unique code, coordinates inside the village's LGD district, duplicates must agree within 2 km). OSM by normalised name inside the mandal polygon (0.90) or district (0.80). Ambiguous, unmatched and out-of-district candidates are never shipped and are counted.
* Points are labelled approximate: a place node or Wikidata coordinate is not a centroid of a surveyed boundary. They are good for "which mandal/AC is this place near" and map markers, not for assigning a household to a village by point-in-polygon.
* Served at `GET /api/v1/geo/:state/village-points` and as `point` on the village place profile.
* Coverage numbers are in `data/generated/geo/village-points-coverage.json` (regenerated by the script) and quoted in the story handover.

## Recommendation

1. **Ship points only**, from Wikidata (CC0) first and OSM (ODbL) as a gap filler. Show the coverage gap in the UI (no marker rather than a guessed marker).
2. **Do not ship village polygons** until the owner picks one of: (a) written licence from Development Data Lab for SHRUG polygons; (b) written permission from NRSC/SoI or ORGI; (c) accept Voronoi/buffer "approximate village areas" derived from points, labelled as such (no licence issue beyond the points'; honesty cost high, not recommended for anything that assigns people to villages).
3. For TG, where Wikidata is thin, the OSM layer is the main source. Where it is still thin, the plan is user-confirmed location at onboarding, not guessed data.

## Obligations and decisions for the owner and counsel

* DECISION: ODbL share-alike scope. The OSM layer is a separate file (`village-points-osm-*.json`) so it can be dropped or offered under ODbL without touching the CC0 layer. Counsel to confirm that serving it through the API next to non-ODbL data is a "collective database" and not a derived one (the API response merges both layers into one list; the per-point `source` field keeps them separable). Attribution "(c) OpenStreetMap contributors" must appear wherever OSM-derived points are shown.
* DECISION: whether to request SHRUG, NRSC/SoI or ORGI permission for polygons.
* Wikidata coordinates are CC0 and need no attribution; the register still lists them.
* Overpass fair use: the script is one-off, per-district bounding boxes, sequential, cached. Do not schedule it in CI. For regular refreshes use a Geofabrik extract instead (owner to approve the download size).

## Measured coverage (final run 2026-11-24; see village-points-coverage.json)

* AP: 15,789 of 17,957 LGD villages (87.9%): 15,556 Wikidata, 233 OSM gap fills. OSM downloaded for all 28 AP districts (the four that failed in the first run, LGD 754, 755, 790, 791, succeeded on resume). OSM/Wikidata median disagreement 0.11 km, p90 3.59 km.
* TG: 4,193 of 11,447 (36.6%): 395 Wikidata, 3,798 OSM. OSM downloaded for 31 of 33 TG districts. LGD districts 690 and 698 are missing: Overpass (overpass-api.de) returned 502 repeatedly; one attempt on a second public mirror (overpass.kumi.systems) got 691 and 720 but timed out on 690 and returned 504 for 698. Stopped there as agreed. TG matching is name-only and 7,119 OSM nodes were unmatched, 314 ambiguous, so coverage stays well below AP.
* The pull ran from a one-off build machine, sequential with 15 s gaps and back-off; do not schedule it. Rerun `npm run pipeline:villages` (cache in data/raw/geo-village) later to fill 690 and 698, or use a Geofabrik extract.
