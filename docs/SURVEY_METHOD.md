# How Pulse Survey figures are made

This is the public method note for Pulse Surveys (linked as /methodology#surveys). The code is in `server/civic/surveys/` and is published with the platform.

## What these figures are

A Pulse Survey is an opinion survey. It is not an election and it is not a forecast. The people who answer are verified people who chose to take part. That is not a random sample, so a classical "margin of error" does not apply and we do not print one. Instead every survey shows:

* the number of responses (rounded to the nearest 5);
* the effective sample size, which is smaller than the number of responses when weighting is used;
* the weighted and the unweighted figures side by side, always together;
* a verified-quality score from 0 to 100 with its parts visible;
* a coverage warning: people without phones, with little internet access or less interest are under-represented.

## When figures appear

Never while a survey is open and never in part. Figures are published once, after the survey closes and a delay (24 hours by default). After that they do not change. Surveys about parties or candidates are not published while an election window is running or when the window is unknown.

## How we protect small groups

* Figures are shown only for a fixed set of areas chosen when the survey is created (for example district and mandal).
* An area with fewer than 30 responses is not shown; its responses are counted in the larger area above it.
* If hiding one area would let you work it out by subtraction, we also hide the smallest neighbouring area.
* An answer chosen by very few people in an area (fewer than 5 people or under 2 percent) is grouped under "other" for that area.
* Counts are rounded to the nearest 5.
* You can break figures down by one thing at a time (area, age group, gender or verification level). Combinations are not available.
* App responses and assisted responses (given by phone or with a volunteer, where the platform could link the answer to the person) are shown as separate groups and are never added together.

## How weighting works

Weighting adjusts the answers so that the groups in the sample match the groups in the population, using the published reference figures that exist. The method is raking (iterative proportional fitting). No single response counts for more than 5 times the average weight. The reference figures, with their source, date and status, are in `data/reference/survey-marginals.json`.

Reference figures available today:

* Sex share of the Census 2011 population, by state and by 2011 district. This is the share of all ages, not only adults, so it is an approximation for an adult sample.

Not available today, and therefore not used:

* Age group by gender (the Census 2011 files we hold have no age fields, and the electoral-roll age and gender file is not yet available to us).
* Phone ownership.

When a reference figure is missing, the survey is weighted only on what exists, and the method page for that survey lists what was and was not used. If nothing is available, the weighted and unweighted figures are the same and the page says so. A reference figure marked as a placeholder is never used.

Effective sample size is `(sum of weights)^2 / sum of (weight^2)`. The design effect is the number of responses divided by that value.

## Verified-quality score

A score from 0 to 100, a weighted average of the parts that could be computed:

| Part | Weight | What it measures |
|---|---|---|
| Verified share | 0.35 | share of responses from people at the highest verification level (T2) |
| Low-risk share | 0.20 | share of responses without a high phone-number risk flag |
| Coverage | 0.25 | share of the reference population that sits in groups with at least 10 responses |
| Skew | 0.20 | one minus the largest gap between the sample and the reference group shares |

A part that cannot be computed (for example coverage when there are no reference figures) is marked unavailable and the others are scaled up; the score is then labelled partial.

## Version

Every payload carries the method version and code version (for example `pulse-survey-method/1.0.0+<build>`) and the hash of the published snapshot.
