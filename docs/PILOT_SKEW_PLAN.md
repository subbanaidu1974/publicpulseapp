# Pilot skew evaluation plan - S-153, RELEASE_GATE row 3

Status: DRAFT method and tooling. No pilot has run, so there is no data and no result. The aim of the evaluation is to measure, with numbers instead of assertion, who takes part in the pilot and who does not, so that threat-model item 10 ("the pilot is a signal, not a representative sample", `docs/THREAT_MODEL.md` section 5) is backed by data, and so that every pilot figure carries its caveat.

## 1. What is measured

For 2 to 3 pilot mandals, for each of four stratifications of the people **invited** to take part:

| Dimension (name in the tool) | Strata | Where the count comes from |
|---|---|---|
| `gender` | male, female (and any other category the operator records; that one has no census reference) | The invitation or enrolment record, aggregated by the operator |
| `age_band` | for example 18-29, 30-49, 50-64, 65+ (bands are set by the operator before the pilot and not changed afterwards) | Year of birth or declared band at enrolment, aggregated |
| `phone_ownership` | own phone, shared phone, no phone (reached through a volunteer) | Enrolment context, aggregated |
| `shared_sim` | single-adult SIM, shared SIM (several adults on one number) | Count of adults on the SIM, aggregated |

For each stratum: **invited** (people the pilot tried to reach) and **responded** (people who took part, however the pilot defines it, defined before it starts). Both are counts for the same people and period.

The question is not "how many responded" but "does the mix of responders look like the mix of people we invited, and like the area".

## 2. Individual-level data never enters this tool

`scripts/pilot-skew.ts` accepts aggregate counts only. An operator who holds person-level records aggregates them first, outside this repository, and passes the counts. The tool enforces this rather than trusting it:

- the input has the columns `dimension`, `stratum`, `invited`, `responded` (and optionally `reference_share`) and nothing else; a column or field that looks like a phone, name, id, address, voter or person field, or any other unknown column, makes the whole file refused;
- more than 200 rows, or more than 12 strata in one dimension, is refused (a person-level file is much longer);
- a stratum label that looks like a phone number, email or long identifier is refused;
- counts must be non-negative integers and `responded` cannot exceed `invited`;
- nothing is written to disk and nothing is sent anywhere; the tool reads one file and prints.

This protects the people in the pilot and keeps the tool outside the data-protection scope of the pilot's personal data. Small cells still disclose (a stratum of 3 people in a small village), which is why there is a minimum cell size (section 4).

## 3. Reference marginals: what exists and what does not

| Dimension | Reference available in this repository | Source |
|---|---|---|
| gender | Yes, from Census 2011 for any district or sub-district (mandal) in AP and TG: males and females, all ages | `data/generated/census.json` (districts) and `data/generated/census-subdistricts.json` (mandals), Census of India 2011 District Census Handbooks |
| age band | **No.** The census files in this repository carry total, sex, SC and ST populations only; no age structure | A human may supply shares from a cited source (for example a published age table for the district); give it as `reference_share` or `reference_shares` and cite it in the report |
| phone ownership | **No.** Census 2011 has no phone-ownership variable at mandal level | A human may supply a cited survey figure; otherwise the dimension gets response-rate skew but no index |
| shared SIM | **No** | As above; there may be no credible reference at all |
| Electoral roll | **Not available.** The electoral roll is not in this repository and no roll marginals (sex, age, polling-area) have been obtained. Do not claim roll representativeness | A human must request roll-derived marginals through the proper channel, and counsel decides whether they may be used |

Two limits on the census reference to say out loud in any report: the census sex share covers all ages, children included, so it approximates the adult share and the index for gender is indicative only; and it is 2011 data, more than a decade old. The tool prints both warnings.

Nothing in the tool invents a reference. A dimension with no reference gets the response-rate comparison only and is labelled `no_reference`.

## 4. Method (what the tool computes)

For each dimension:

1. **Response rate** per stratum: `responded / invited`. **Overall rate**: total responded over total invited in that dimension.
2. **Skew ratio** per stratum: its rate divided by the overall rate. 1.0 means the stratum responds exactly as the whole does; 0.5 means half as often. A stratum is flagged `under_responding` or `over_responding` when its ratio is outside the skew band (default 0.8 to 1.25; a screening default chosen for this tool, not a standard).
3. **Respondent share** per stratum (responded over total responded), compared with the **reference share** where one exists.
4. **Representativeness index**: `1 - 0.5 * sum(|respondent share - reference share|)` over the strata that have a reference, with both shares renormalised over those strata. It is 1 when the responders mirror the reference and falls towards 0 as they diverge (it is one minus the total variation distance). The same index computed on the **invited** shares (the **invited-frame index**) separates two causes: a poor invited frame (the pilot did not invite a representative mix) from non-response (the invited mix was fine but some groups did not respond). A dimension is flagged `low_representativeness` below the warning level (default 0.9, again a screening default).
5. **Rate disparity**: highest over lowest response rate among reliable strata.
6. **Minimum cell size** (default 30, matching `MIN_CELL` for public issue metrics): a stratum with fewer than 30 invited or fewer than 30 responded is flagged `below_min_cell`, is left out of the disparity, never gets an `under_responding` or `over_responding` flag, and, when it carries a reference share, makes the index `UNRELIABLE`. Do not report such a stratum as a finding. Combine strata (wider age bands) or report it as "too few to say".

The index is a screening number, not a test of significance: it carries no confidence interval, and with small samples it will move with chance. Report counts next to it.

## 5. Running it

Prepare an aggregate file per mandal. CSV:

```
dimension,stratum,invited,responded
gender,male,1000,400
gender,female,1000,200
age_band,18-29,730,228
```

JSON takes the same rows as `{"area": "...", "strata": [...], "reference_shares": {"age_band": {"18-29": 0.3, ...}}}`.

```
npm run pilot:skew -- --input counts.csv --census subdistrict=Adilabad/Tamsi
npm run pilot:skew -- --input counts.json --census subdistrict=Adilabad/Tamsi,Adilabad/ADILABAD MANDAL --json
npm run pilot:skew -- --input counts.csv --census district=Srikakulam --min-cell 30
```

`--census` takes `district=<name or code>` or `subdistrict=<district>/<mandal>` (names or codes, several separated by commas and summed; prefix `AP:` or `TG:` when a name exists in both states). Omit it to skip the census reference. Exit code 3 means the file was refused as not aggregate; 2 is any other error.

The numbers in `tests/pilot/pilot-skew.test.ts` are **SYNTHETIC**: invented to exercise the arithmetic, and they say nothing about any real area.

## 6. Report (what a human publishes)

The published report for row 3 (RELEASE_GATE) states, per mandal:

1. Pilot period, how people were invited, how "responded" is defined, and the strata definitions fixed in advance.
2. The aggregate counts and the tool output (text and JSON attached).
3. Which references were used for which dimension, with citations, and the limits in section 3, including that electoral-roll marginals were not available.
4. Flagged strata and the cells too small to report.
5. What was done about skew (nothing, wider outreach, weighting is **not** done by this tool) and what the pilot may and may not be used to say.
6. The standing caveat: pilot results are a signal, not a representative sample.

It is published before any pilot result is shown. Attach it, and the counts files, to `docs/gate/03/evidence/`; `npm run gate:status` then shows the row has human evidence. A person still sets owner and date and checks the box.

## 7. Limits

- Aggregation by the operator is trusted: the tool cannot verify that the counts are honest or that `invited` and `responded` describe the same people.
- Strata are single-dimension. There is no cross-tabulation (for example women over 50 on shared SIMs), because cross-tabs create the very small cells this plan avoids.
- Non-response bias inside a stratum (the women who responded may differ from those who did not) is invisible to any of these numbers.
- Weighting and model-based adjustment are out of scope.
