# Electors by AC (S-86) and polling-station list (S-91): sourcing log

Checked 2026-11-24 from a Windows dev machine. Counts only; no electoral-roll data is read, stored or ingested.

## S-86 electors by assembly constituency

| Source | Result |
|---|---|
| ECI GE-2024 statistical report, table 15 "Assembly segment wise information of electors" (`https://www.eci.gov.in/eci-backend/public/all_files/GE-2024-statistical-report/15-Assembly-SegmentWise-Information-Electors.pdf`, 280 pages) | Reachable (HTTP 200, no login). `https://eci.gov.in/robots.txt` allows all (`Disallow:` empty). **Ingested**, see below. |
| CEO Andhra Pradesh (`ceoandhra.nic.in`, SSR 2025 electors) | Site is reachable, but `robots.txt` is `User-agent: *` / `Disallow: /`. **Not fetched.** Needs an operator-supplied file or written permission. |
| CEO Telangana (`ceotelangana.nic.in`, also `.gov.in` and `ceotserms2.telangana.gov.in`) | Connection timed out / refused from this network on every attempt (http and https). Search results show it hosts "Electors Summary - SSR-2024 Final Rolls.pdf" under `/epicstatus/`, but it could not be read, so not ingested. |

Ingested: `data/generated/electors-ac.json` (`npx tsx scripts/ingest-electors.ts [--download]`, needs `pdftotext`).
175 AP + 119 TG assembly constituencies with general, NRI and service electors, male/female/third-gender split, total electors and valid votes plus
NOTA polled on EVM. Parser: `pipeline/electors.ts`. Checks: every row's parts add up; AP total 41,401,887 and TG total 33,232,318 equal the totals printed by ECI;
all 175 AP seats equal the TCPD 2024 electors already in `elections.json` (TG differs because TCPD carries the 2023 assembly roll, not the GE-2024 roll).
Limits: this is the roll used for the **2024** general election, not SSR 2025 (S-86 asks for SSR 2025); turnout is not recomputed because the ECI figure
excludes postal ballots; served by `GET /api/v1/electors/:state` and the `electorsRoll` field of `GET /api/v1/constituencies/:state/:acNo`, labelled as the 2024 general-election rolls. Licence: ECI states none (register key `eci-statistical-reports`, needs a human decision).

## S-91 polling-station reference list

Nothing is shipped. Tooling (schema, validator, legal guard, importer `scripts/import-pollingstations.ts`, API route) is unchanged and ready.

| Attempt | Outcome |
|---|---|
| `ceoandhra.nic.in` station lists | `robots.txt` disallows everything; not crawled. |
| `ceotelangana.nic.in` station lists | Unreachable (timeouts) on 2026-11-24. |
| `electoralsearch.eci.gov.in`, `voters.eci.gov.in` | Reachable landing pages, but station and roll lookups sit behind per-query forms and captchas that automated clients must not bypass, and the same services expose elector-level data. Not used. |
| data.gov.in | No polling-station list for AP or TG found; `robots.txt` not reachable from this network. |
| Dataful datasets 14396, 14422, 14753, 14334 | Aggregate electors-per-station counts, not station lists; custom licence, not read in full. Not ingested. |
| GitHub `aaronrudkin/IndianPollingStations` | Name and coordinates scraped from ECI in April 2017 (before AP/TG delimitation changes and rationalisation), no licence declared (`license: null`). Not ingested. |

Operator route stays as in `data/reference/pollingstations/README.md`: obtain the CEO list with reuse rights, drop CSVs into `data/raw/pollingstations/`, run the importer.

## S-86 NOTA and valid votes per AC (checked 2026-11-24)

`eci.gov.in/robots.txt` allows all. Table 15 prints one combined column, valid votes plus NOTA polled on EVM (`votesPolledEvm`); it has no separate NOTA or valid-votes column. ECI's "Detailed Results" tables in the GE-2024 statistical report are per **parliamentary** constituency (candidate wise, NOTA included), not per assembly segment, and the site (a JavaScript app) has no static index of file names; guessed file names returned 404. So an AC-level NOTA and valid-votes split for the GE-2024 rolls is **not added**. Where an assembly election result exists (AP 2024, TG 2023), `elections.json` already carries a NOTA row per AC from the TCPD-derived data. Operator route: Form 20 (per-AC counts) from the CEOs, or the ECI results site, each needing its own terms check.
