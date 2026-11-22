# Forecast method: `uniform-swing-damped-v1`

Route: `GET /api/v1/elections/:state/forecast` (AP, TG). Code: `src/lib/forecast.ts`.

This is a **model projection from past results**. It is not a poll, not a vote and not a prediction of any outcome. The response always carries the disclaimer: "Model projection from past results. Not a poll, not a prediction of any outcome."

## Blackout (fail closed)

If `FORECAST_BLACKOUT=1` the route returns HTTP 200 with `blackout: true` and **no** `seats`, `alliances` or `backtest`. The flag is read on every request and the blackout response is never cached. It is meant to be set from the published ECI/SEC calendar (DESIGN_2028.md §3).

## Inputs

Only `data/generated/elections.json` (TCPD + ECI): assemblies AP 2014/2019/2024, TG 2014/2018/2023; Lok Sabha 2019/2024 for both. Lok Sabha segments are not mapped to assembly seats, so LS data is used at state level only.

## Blocs

Parties are grouped into fixed blocs per state (`BLOCS` in the code, merged with `ALLIANCES` in `states.ts` when present):

- AP: `NDA (TDP+JSP+BJP)`, `YSRCP`, `INC`
- TG: `BRS` (incl. TRS), `INC`, `BJP`, `AIMIM`

Every other party/independent is pooled as `Others`. In a seat, `Others` competes with its single largest candidate's share (never pooled, so many small candidates cannot beat a real contender). Limits: blocs are fixed with hindsight (e.g. TDP, JSP and BJP did not ally in 2019, and BJP/TDP are placed in the same bloc for 2014); TDP in Telangana, CPI/CPM and YSRCP in Telangana fall in `Others`; a party that did not exist earlier has zero share in earlier years, so its "shift" is its whole current share (this inflates the trend for e.g. JSP, BRS-to-BJP style jumps). Constituencies are matched by `acNo` (2008 delimitation applies to all years used); seats missing in an earlier year are excluded from noise estimation only.

## Formula

For bloc `b`, with state vote share `S` (sum of bloc votes / all votes):

- `A_b = S_b(last assembly) - S_b(previous assembly)`
- `L_b = S_b(latest Lok Sabha, year >= last assembly year) - S_b(last assembly)`
- `delta_b = 0.5 * (0.5 * A_b + 0.5 * L_b)` (damping 0.5; equal blend). If only one of A/L exists, the blend is that one; if neither, `delta_b = 0` (pure persistence).
- Seat projection: `p_{s,b} = max(0, share_{s,b}(last) + delta_b)`; `Others` = largest single other candidate's share, no trend. Leader and runner-up are the top two; `marginPct` is their gap in percentage points of the vote.

Note the LS term mixes a real trend with a systematic Lok-Sabha-vs-assembly difference; the model does not separate them.

## Uncertainty

- `sigma` (seat noise): sample std dev of `(seat share change) - (state share change)` for every seat/bloc pair (bloc >= 10% in either year, seat contested in both) over all consecutive assembly pairs up to the base year.
- `tau` (state-level shock): root mean square of historic state-level bloc share changes over the same consecutive pairs. The damped trend only carries half of the shift, so the full historic size of state moves is used as its uncertainty.
- If there are fewer than 30 seat samples or no consecutive pair, fixed fallback values (sigma 6, tau 4 percentage points) are used and flagged `uncertaintySource: "fallback-prior"`.
- Seat win probability: `Phi(margin / sqrt(2 sigma^2 + 2 tau^2))`. Classes: `safe` >= 0.95, `lean` 0.75 to <0.95, `toss-up` < 0.75.
- Monte Carlo: 2000 runs, seeded `mulberry32` (seed hashed from state and base year), so output is deterministic. Each run draws one state shock `N(0, tau)` per bloc and independent seat noise `N(0, sigma)` per bloc with projected share >= 10%; each seat goes to the highest value. Reported per alliance: median, 10th and 90th percentile seats, and probability of a majority (> half of modelled seats).

Ties on votes are broken by recorded position then candidate name; uncontested seats are treated as 100% for the sole candidate's bloc and are skipped when estimating noise.

## Back-test (real data, nothing tuned)

The same method is run from earlier data only (assemblies <= base year; LS only if held in [base year, target year)), then compared with the actual result. "Hit rate" is the share of seats where the projected leader bloc equals the actual winner's bloc. "Persistence" is the naive baseline that last winner holds. Seat error = projected leader count minus actual, per bloc.

| Run | Trend inputs | Hit rate | Persistence | Brier | Mean abs seat error | Seat error (projected - actual) |
|---|---|---|---|---|---|---|
| AP 2014 -> 2019 | none (pure persistence) | 48.6% | 49.1% | 0.338* | 42.5 | NDA +83, YSRCP -85, Others +2 |
| AP 2019 -> 2024 | A (2014->19), L (LS 2019) | 38.3% | 20.0% | 0.433 | 54.0 | NDA -108, YSRCP +108 |
| TG 2018 -> 2023 | A (2014->18), L (LS 2019) | 46.2% | 46.2% | 0.320 | 20.8 | BRS +50, INC -46, BJP -6, Others +2 |
| TG 2014 -> 2018 (extra) | none | 55.5% | 55.5% | 0.293* | 10.0 | BRS -25, INC +2, BJP +4, Others +19 |

\* fallback noise values used, so not data-derived.

Reading: the model is poor at predicting wave elections. It missed the 2019 YSRCP and 2024 NDA landslides in AP by about 85 to 108 seats, and the 2023 Congress gain in TG by about 46 seats. In TG 2018 -> 2023 it did no better than "last winner holds"; in AP 2019 -> 2024 it beat persistence on hit rate (38% vs 20%) but still projected the wrong side to win. The probabilities are over-confident for such swings (high Brier scores). Only three real test elections exist, and the back-test blocs use hindsight. Treat the output as a description of what a mechanical extrapolation of the last results looks like, not as an expectation of 2028/29.

The live numbers (including the current back-test) are always returned in the response under `backtest`.

## Other limitations

- No candidate effects, incumbency, anti-incumbency, delimitation changes, new parties, alliances formed after the last election, turnout, caste/regional structure or by-elections.
- Uniform swing applies the same shift to every seat; real swings are not uniform (the estimated `sigma` is large, especially in TG where AIMIM and BJP are concentrated regionally).
- The 2024 AP assembly and LS were held together, so the LS term mostly adds nothing there; in TG it adds a large BJP uplift (LS 2024 vs assembly 2023).
- Results are cached in memory per state for the process lifetime; restart after refreshing the data.
