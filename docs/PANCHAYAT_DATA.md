# Panchayat elections: data format, sources and roadmap (S-203 to S-218)

Status on 2026-11-25: the section shows **party totals only**, read from English Wikipedia (CC BY-SA 4.0, S-219) and, for the newest rounds, from news reports checked against each other (S-220). No State Election Commission data and no unit-level (village or constituency) result is loaded. Nothing on the page is estimated.

### What is loaded (S-219, S-220)

| State | Level | Cycle | What we hold | Source page (revision) |
|---|---|---|---|---|
| TG | Gram panchayat | **Dec 2025** | INC, BRS, BJP and others as **ranges** (no final count found; reports disagree), 12,727 gram panchayats | News reports, 4 outlets (S-220) |
| TG | Gram panchayat | 2019 | Top 3 parties' seats, posts | 2019 Telangana local elections (1387651623) |
| TG | ZPTC, MPTC | 2019 | Top 3 parties' seats, posts | same |
| TG | ZPTC, MPTC | 2014 | Party seats for the Telangana districts of undivided AP | 2014 Andhra Pradesh rural local bodies elections (1344762082) |
| AP | ZPTC, MPTC | **5 Nov 2026** | Party seats where two outlets with final counts agree; unopposed seats; disputed figures left out | News reports, 2 outlets agreeing plus a partial count not used (S-220) |
| AP | Gram panchayat | 2021 | Sarpanch seats by party and phase, phase dates, turnout for phases 1 and 2 | 2021 Andhra Pradesh local elections (1383614314) |
| AP | ZPTC, MPTC | 2014 | Party seats for the AP districts of undivided AP | 2014 page above |

Not loaded: a final Telangana 2025 count, Telangana MPTC and ZPTC after 2019 (none found; status unconfirmed), AP ZPTC and MPTC 2021, any AP gram panchayat after 2021 (none found), any 2013 gram panchayat, and everything at unit level. Known problems inside the source are recorded as caveats on each election and shown on the page.

None of these figures has been checked against the Commissions. Wikipedia figures cite news reports we have not read. News-report figures are numbers only with links; the licence record `news-reports-facts` is marked as needing a counsel decision, and share-alike on a compiled table (Wikipedia) has not been decided either.

## What the section will hold

| Level | Meaning | Party symbols? |
|---|---|---|
| `gp` | Gram panchayat: sarpanch and ward members, village by village | No. Officially non-party |
| `mptc` | Mandal parishad territorial constituencies | Yes |
| `zptc` | Zilla parishad territorial constituencies | Yes |

Target is unit level: one row per panchayat or territorial constituency. Until a commission source is cleared we hold party totals per election instead. We do not request, hold or accept electoral-roll or voter-level data. A file with any field that looks voter-level or personal (voter, EPIC, elector, roll, Aadhaar, phone, mobile, address) is refused by `validatePanchayatFile` in `src/lib/panchayat.ts`.

## File format

One file per state at `data/reference/panchayat/results-<ST>.json`. An election carries either `units` (commission source) or `tallies` (secondary source, which must also carry `evidence` and `caveats`). Unit-level shape:

```json
{
  "state": "TG",
  "source": { "publisher": "", "url": "", "licence": "", "terms": "", "retrieved": "YYYY-MM-DD", "quality": "commission" },
  "elections": [
    { "id": "tg-gp-2025", "level": "gp", "year": 2025, "period": "YYYY-MM", "phases": [{ "date": "YYYY-MM-DD", "turnoutPct": 0 }],
      "units": [ { "lgdCode": "", "name": "", "district": "", "mandal": "", "posts": 8, "contested": 20, "unopposed": false, "turnoutPct": 81.2,
                   "winner": { "name": "", "partyBacked": "" } } ] }
  ]
}
```

`partyBacked` is filled only where the source states it. It is never inferred, and media or party claims are not used.

## Elections targeted ("last few")

Cycles below come from news reports found on 2026-11-25. **They are unverified** until the commission source is read (S-204). Dates and counts are to be taken from the source, not from this table.

| Story | State | Level | Cycle | Status |
|---|---|---|---|---|
| S-205 | TG | Gram panchayat | December 2025 (3 phases) | Blocked on S-204; no secondary source found |
| S-206 | TG | Gram panchayat | January 2019 | Blocked on S-204 |
| S-207 | TG | MPTC, ZPTC | 2019; next round if held | Blocked on S-204 |
| S-208 | AP | Gram panchayat | February 2021 (4 phases) | Blocked on S-204 |
| S-209 | AP | Gram panchayat | 2013 (undivided AP) | Blocked on S-204 |
| S-210 | AP | MPTC, ZPTC | 2021 | Blocked on S-204 |
| S-211 | AP, TG | MPTC, ZPTC | 2014 (undivided AP) | Blocked on S-204 |

Whether AP has held a newer round, and whether Telangana has held its parishad round, is unchecked.

## Roadmap

1. **Foundation (done, S-203, S-219).** Section, data format, checks, API, tests, and party totals from a secondary source.
2. **Source clearance (S-204, needs the owner; permission requests drafted in docs/PANCHAYAT_PERMISSION_REQUESTS.md, unsent).** The commission sites could not be opened by our tools. The owner reads each site's terms and either supplies result files or approves a written request for reuse. We send nothing ourselves. Any open-licence alternative (data.gov.in, a state open-data portal) is checked here.
3. **Pipeline (S-212).** Turn approved files into the JSON above, validate, write manifest, licence and attribution entries. Tested on fixtures, never live sites.
4. **Load the cycles (S-205 to S-211).** Newest first: TG gram panchayat 2025, AP gram panchayat 2021, then parishad rounds, then earlier cycles.
5. **Join to places (S-213).** Match units to LGD codes and Telugu names; report unmatched units, never guess.
6. **Browse (S-214).** State, district, mandal, panchayat, with search by village name.
7. **Compare (S-215, S-216).** Unopposed share, turnout and reserved posts across cycles; sourced backing-party tallies, labelled as backed and not as wins.
8. **Connect (S-217).** Panchayats listed from constituency pages.
9. **Close out (S-218).** Native Telugu review, accessibility, full e2e.

Steps 3 to 9 cannot start before step 2 except the join and browse screens, which can be built on fixture data.

## Rules for this section

- A result is shown only from a source whose terms allow reuse, with its credit.
- Placeholders and fixtures never count as real data and never ship in `data/reference`.
- No scraping of a site whose terms forbid it; request volume stays low; nothing is fetched without the owner's go-ahead.
- Telugu text stays marked machine-drafted until a native speaker reviews it.
