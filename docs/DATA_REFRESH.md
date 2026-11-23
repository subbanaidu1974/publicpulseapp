# Data refresh and freshness (S-76)

## What exists

| Piece | Where | Notes |
|---|---|---|
| Manual staged refresh | `npm run refresh:data` (`scripts/refresh-data.ts`, `pipeline/refresh/stage.ts`) | The supported way to refresh. Never runs by itself. |
| Freshness report | `GET /api/v1/data-freshness` (`server/refresh.ts`, `server/freshness.ts`) | Per dataset: `asOf`, `ageDays`, `thresholdDays`, `status` = `fresh`, `stale` or `unknown`, plus an `alert` summary. Read from `data/generated/manifest.json`. |
| Freshness job | `dataFreshness`, every 6 h, in the civic job scheduler | Recomputes the alert flag, logs a `data freshness alert` warning when anything is stale or the manifest is missing. |
| Readiness info | `GET /readyz` -> `info.dataFreshness` | `{raised, staleCount, unknownCount, stale[], checkedAt}`. Informational: it never turns readiness red. |
| Scheduled refresh (off) | job `dataRefresh`, only when `REFRESH_ENABLED=1` | Default is 0. No network fetch is ever scheduled by default. |
| Forecast cache | `server/api.ts` | The snapshot signature covers `elections.json` and `manifest.json`; a swapped set clears the cache and reloads datasets. |

## The staged refresh, step by step

1. Copy `data/generated` to `data/refresh/staging`.
2. Run each step as a child process with `PIPELINE_OUT_DIR=data/refresh/staging` (default steps `lgd,boundaries,names-te`).
3. Rebuild the manifest in staging and verify it (checksums, licence keys, every file listed).
4. Guards: refuse to swap when real data would become demo (`elections`, `census*`), when a dataset disappears, or when a dataset flips from real to demo.
5. Run the data quality gate (`scripts/validate-data.ts <staging>`).
6. If no dataset checksum changed: stop, live set kept.
7. Otherwise swap with two renames: live -> `data/refresh/previous`, staging -> live. If the second rename fails the first is undone.
8. Write `data/refresh/last-report.json` (steps, changed, added, removed, errors, rolled back).

A failed run leaves `data/generated` exactly as it was. `npm run refresh:data -- --rollback` swaps the kept previous set back
(the replaced set becomes the new previous). After a swap run `npm run pipeline:attribution` and commit the changed data
files deliberately; `data/refresh/` is gitignored.

Steps: `lgd`, `boundaries`, `names-te`, `census`, `elections` (see `REFRESH_STEPS`). `elections` only runs when `TCPD_CSV_URL`
is set, so the demo fixture fallback can never be staged by accident (and the demo guard would stop it anyway).
Mandal polygons (`npm run pipeline:mandals`) and polling-station imports are separate, deliberate runs.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `REFRESH_ENABLED` | 0 | 1 registers the in-server `dataRefresh` job |
| `REFRESH_INTERVAL_HOURS` | 24 | Period of that job |
| `REFRESH_STEPS` | `lgd,boundaries,names-te` | Steps to run |
| `DATA_FRESHNESS_THRESHOLDS` | empty | `id=days` overrides, comma separated |

## Default staleness thresholds (days)

elections 2000 (about one election cycle plus slack); census datasets 7300 (Census 2011 stays the latest until Census 2027 results
exist); boundaries, AC links, LS segments 3650 (change only with a delimitation); mandal polygons 1095; LGD, Telugu names and
build reports 365; parties and alliances 730; anything else 365.

## Known limits

- Nine geo datasets (AC/PC/district polygons, crosswalk, names-te, boundaries report) have no `asOf` in the manifest, so they
  report `unknown`. Fix at the generators (write a top-level `asOf`), not here.
- The freshness job is only as current as the manifest. Run `npm run pipeline:manifest` after any manual data change.
- The refresh cannot validate upstream correctness, only structure, checksums and the demo/real guard. Review the report diff.
