# History store (local SQLite)

A queryable, versioned **projection** of the election, people and geography data. The JSON under `data/generated/**` and `data/reference/**` stays authoritative and in git; the database is rebuilt from it and adds what flat files cannot: results joined to the boundary version in force, office-holder validity intervals, and an append-only log of every dataset change.

It is separate from the four civic stores (docs/STORES.md) and holds **public data only**: no citizen, household, issue, survey or session data, and nothing that identifies a user. People appearing in it are public office holders, election candidates and by-election winners, with the same fields the public pages already show.

## Commands

```
npm run history:build            # create or update data/history.db from the JSON (idempotent)
npm run history:build -- --reset # delete the file first: discards revision history and office-holder intervals
```

File: `HISTORY_DB` (default `data/history.db`, git-ignored, with `-wal`/`-shm` side files). `HISTORY_AUTO_RECORD` controls the refresh hook (below).

## Schema (version 1)

| Table | Kind | Contents |
|---|---|---|
| `dataset_revisions` | append-only (triggers refuse UPDATE/DELETE) | one row per changed dataset per run: `dataset`, `path`, `sha256`, `bytes`, `row_count`, `source`, `licence`, `provenance`, `as_of`, `trigger` (`build`/`refresh`), `created_at`, `previous_revision_id`, `diff_summary` (JSON: rows before/after, delta, previous checksum) |
| `manual_corrections` | append-only | who/when/why a source value was corrected: `actor`, `table_name`, `record_key`, `field`, `old_value`, `new_value`, `reason`, `source_url`. Written with `recordCorrection()`; the fix itself is made in the JSON (authoritative) |
| `office_holders` | accumulating (never wiped by a rebuild) | `slot_id` (e.g. `AP-cm`), state, role, person, party, constituency, `start_date`, `end_date`, `current`, confidence, sources, first/last revision. When a slot's person or start changes, the previous holder is closed at the new start date; a slot that disappears becomes `current = 0` with an unknown end |
| `elections` | projection | `AP-2019-assembly` style id, state, year, type, `boundary_version`, comparability (pre-bifurcation rows are tagged), seat and row counts |
| `constituencies` | projection | state, type, `ac_no`, `boundary_version`, name |
| `results` | projection | per candidate: votes, position, `share_pct` of valid votes, `is_nota`, `margin` (winner only, over the runner-up, NOTA excluded), valid votes, electors, `party_code` (resolved through `parties.json` aliases) |
| `parties`, `party_alliances` | projection | registry and per-election alliance records (kind, confidence, sources) from `parties.json` and `alliances.json` |
| `by_elections`, `party_switches` | projection | cited records from `data/reference/history/*.json` |
| `history_meta` | | `schema_version`, `projected_at` |

Datasets tracked for revisions: every entry of `data/generated/manifest.json` plus `people-office-holders`, `history-byelections` and `history-party-switches`. A revision is written only when the file's SHA-256 differs from the dataset's latest revision, so repeated builds add nothing. Boundary version per election comes from `data/generated/geo/versions.json` by election year (docs/BOUNDARY_VERSIONS.md); a future delimitation set is picked up automatically.

## Refresh hook

After a successful, swapped data refresh (`npm run refresh:data`, and the `dataRefresh` job when `REFRESH_ENABLED=1`) the store records the new revisions, but **only if the database already exists** (or `HISTORY_AUTO_RECORD=1`; `0` disables). The hook catches every error and logs a warning, so it can never fail a refresh.

## API (read-only, `/api/v1`)

| Route | Notes |
|---|---|
| `GET /history/datasets` | latest revision per dataset |
| `GET /history/revisions?dataset=&limit=` | newest first, limit 1-200 (default 50) |
| `GET /history/elections?state=&type=` | elections held with boundary version |
| `GET /history/constituency/:state/:acNo?type=assembly\|ls` | results across elections for the seat, with boundary version; ordered by year then finishing position |
| `GET /history/office-holders?asOf=YYYY-MM-DD&state=&role=` | who held what on a date (default today); an open end means current when last read |
| `GET /history/party/:id/seats-over-time?state=&type=` | seats won, contested and votes per election for a party code, chronological |

Neutral by design: chronological or finishing-position order only, no rankings, scores or labels. Responses carry `Cache-Control: public, max-age=300`, go through the shared `/api/v1` rate limiter, and errors are JSON `{ error, code }` (400 for bad input, 404 unknown seat/party, 503 `history_unavailable` when the file has not been built). The connection is opened read-only per request, so a rebuild never blocks readers for long.

## Backup and rebuild

The file is reproducible except for `dataset_revisions`, `office_holders` intervals and `manual_corrections`, which hold history that the JSON no longer contains. Back those up; the projection tables can always be regenerated. The civic backup tooling (`scripts/backup.ts`, encrypted, four stores) does not include this file. For a consistent copy of a live database use `sqlite3 data/history.db "VACUUM INTO 'data/backups/history.db'"` (or copy the `.db` with its `-wal`); `data/backups/` is git-ignored. To restore, put the file back at `HISTORY_DB` and run `npm run history:build`, which re-projects from the JSON and appends any revisions made since.

## Limits

- Election dates are not in `elections.json`; boundary versions are matched by year.
- Office-holder records carry no end dates in the source; intervals are only known from the moment two successive builds saw a change, so earlier terms are not backfilled.
- Revision `diff_summary` is row counts and checksums, not a per-row diff.
- Not exposed in the UI yet; API only.
