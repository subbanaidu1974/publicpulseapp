# Boundary versions and post-census delimitation readiness (S-92)

The 2008 delimitation is in force for all AP/TG elections to date (AP 175 assembly / 25 Lok Sabha, TG 119 / 17). A new
delimitation is expected only after the first census whose figures are published after 2026; nothing here assumes its date or shape.

## The registry

`data/generated/geo/versions.json` lists boundary sets. Each set has:

| Field | Meaning |
|---|---|
| `id` | `delimitation-YYYY` (a `-suffix` is allowed, e.g. `-test`) |
| `valid_from` / `valid_to` | ISO dates; `valid_from` inclusive, `valid_to` exclusive, `null` = open ended (exactly one live set) |
| `source`, `datesInferred` | The order the set comes from. The 2008 start date (2008-02-19) is inferred, not verified |
| `seats` | Expected assembly and Lok Sabha seat counts per state |
| `files` | kind (`ac`, `pc`, `district`, `mandal`) -> state -> path under `data/generated/geo` |
| `checksums` | sha256 per file (CRLF normalised, same as the manifest) |
| `testOnly` | Fixture sets: never selectable, never installable |

Mandal polygons are LGD administrative units, not delimitation units; they are listed under the set in force when they were built.

## Using versions

- API: `GET /api/v1/geo/:state/(ac|pc|district|mandal).geojson` accepts `?version=<set id>` or `?asOf=YYYY-MM-DD`. With neither, the set
  covering today is served. The response carries `X-Boundary-Version`. Errors: `invalid_version`, `invalid_asof` (400),
  `unknown_version`, `no_set_for_date`, `no_data` (404), `version_mismatch` (400: id and date that point at different sets).
- Lookups: `AcLink` in `pipeline/geo/link.ts` has `withRegistry`, `withDistricts`, `rowIn`, `pcOf`, `districtOf`, `acsOfPc`,
  `acsOfDistrict`, each taking `{version}` or `{asOf}`. Every row belongs to one set (`set`, absent = `delimitation-2008`); a lookup
  reads rows of exactly one set and returns null rather than falling through to another set. The old `byLgd` / `byAcNo` are unchanged.
- Nothing mixes silently: an id and a date that disagree is an error, not a pick; `geo:version:check` rejects rows whose set differs
  from the candidate set.

## Checks

```
npm run geo:version:check                      # validate versions.json: ranges, one open-ended live set, file checksums
npm run geo:version:check -- --write           # rebuild the 2008 entry (and its checksums) from the files on disk
npm run geo:version:check -- --fixture         # dry run of the TEST ONLY 2029 fixture
npm run geo:version:check -- --candidate FILE  # dry run of a real candidate bundle; writes nothing
```

`pipeline:validate` also runs the registry check. If the 2008 polygon files are regenerated, run `--write` so the checksums follow;
a checksum mismatch otherwise fails the gate on purpose (files changed without a new set).

## Procedure for a future delimitation

1. Obtain the order and the official constituency list. Record the order's name and the date it takes effect (`valid_from`), a
   future date if the order applies from a later election.
2. Build the new polygons and the AC -> PC -> district link rows with `set = delimitation-YYYY`, `validFrom = valid_from`,
   `validTo = null`, in a candidate bundle (`{ set, rows }`, see `pipeline/fixtures/geo/delimitation-2029-TEST-ONLY.json`).
   Put polygons under `data/generated/geo/v<YYYY>/` so the 2008 files stay untouched.
3. `npm run geo:version:check -- --candidate bundle.json`. Fix every error (seat counts, numbering 1..N, every AC has a PC and a
   district, no mixed rows, `valid_from` after the previous set starts). Read the warnings, especially "not in the future".
4. Install: add the set to `versions.json` and set the previous set's `valid_to` to the new `valid_from` (the plan lines say how),
   run `geo:version:check -- --write` for checksums, then `pipeline:manifest`, `pipeline:attribution`, `pipeline:validate`.
5. Elections data: results keyed by AC number before and after the change are NOT comparable. Show a set label next to any
   history and use the notional-result tables the Delimitation Commission or ECI publishes, never a silent re-keying.
6. Keep the old set. Historic pages use `?asOf=` or `?version=`.

## The fixture

`pipeline/fixtures/geo/delimitation-2029-TEST-ONLY.json` is a hypothetical set with 6 + 4 invented seats. It exists to exercise the
validator and the version-selection tests. It is marked `testOnly`: the validator reports it as structurally valid but not
installable, the selectors refuse it, and `validateRegistry` flags it if it ever lands in `versions.json`.
