# Operating conditions: non-commercial use

Decision by the owner, 2026-11-24: the app is operated non-commercially (free, no ads, no paid features, no sale of data). This allows the SHRUG village polygons (Development Data Lab, CC BY-NC-SA 4.0) and keeps the other non-commercial inputs (for example TCPD, `tcpd-nc`) valid. This is a research-level summary, not legal advice; counsel is asked to confirm the open points at the end.

## Conditions that must stay true

1. **Free to every user.** No subscription, paywall, premium tier, paid API or paid report.
2. **No advertising or sponsorship.** No ad networks, no sponsored placements, no paid promotion inside the app or its pages.
3. **No sale or licensing of data.** No selling, renting or licensing of the data, the derived boundary files, aggregates or access to them, and no data consultancy that uses them for a fee.
4. **Attribution wherever the boundaries are shown.** The line "Village boundaries: SHRUG, Development Data Lab, CC BY-NC-SA 4.0, 2011 Census based; for non-commercial use" (Telugu equivalent in the app) appears with every village boundary map, and the licence register (`docs/ATTRIBUTION.md`) lists the source.
5. **Share-alike on derived boundary files.** The simplified polygons under `data/generated/geo/villages-shrug/` and the `village-polygons` API responses are adaptations of the SHRUG polygons. They must be offered under CC BY-NC-SA 4.0 (the files carry `licence`, `nonCommercial` and `shareAlike` fields, and the API sends an `X-Data-Licence` header). Keep them a separate data layer: no code or other dataset is merged into those files.
6. **No commercial operator or customer.** Do not hand the boundary layer to a commercial party or run it for one.
7. **Changes are noted.** The files state that they are simplified and Census 2011 based; do not present them as official or survey-grade boundaries.

## Guardrails in the repository

* `data/reference/licences.json` marks `shrug-cc-by-nc-sa` with `nonCommercial: true` and `shareAlike: true` (and `tcpd-nc` carries the "non-commercial" constraint).
* `COMMERCIAL_USE` (documented in `.env.example`, default `0`). If set to `1`, `npm run pipeline:validate` and the unit test `tests/pipeline/shrug.test.ts` fail while any shipped dataset (manifest entry) relies on a non-commercial or share-alike licence. To go commercial, first remove those datasets or obtain commercial licences (Development Data Lab: info@devdatalab.org; TCPD).
* Add any new NC or SA dataset to the register with those flags so the guard sees it.

## If the operating model changes

Introducing ads, a paid tier, sponsorship or data sales ends the right to use the SHRUG polygons. Remove `data/generated/geo/villages-shrug/`, the manifest entries and the UI block (`VillageBoundaries`), or obtain a commercial licence first. Rerun `npm run pipeline:manifest` and `npm run pipeline:attribution`.

## Open questions for counsel

* Does a non-profit civic operator qualify as "non-commercial" under CC BY-NC-SA 4.0 (including any cost recovery, grants or donations)?
* Share-alike scope: the derived boundary files must be offered under CC BY-NC-SA 4.0; the app code is not affected provided the boundaries stay a separate layer and are not merged into a combined database. Confirm that serving them through the same API next to other layers is a collective work and not an adaptation of the other layers.
