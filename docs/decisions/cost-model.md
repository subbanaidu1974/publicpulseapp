# Decision memo 2: cost model (S-152) - DRAFT

Status: **A calculator and its assumptions, not a budget.** Every unit price is `null` (UNKNOWN) because I could not verify any published price from a primary vendor source with a URL and date. The scenario volumes are **engineering assumptions** (DESIGN_2028 gives the pilot size, 2-3 mandals, but no user or volume numbers). A total is meaningless while any line is UNKNOWN; the tool says so.

## Files
- `data/reference/cost-assumptions.json`: all inputs. A price counts only when `value`, `sourceUrl` and `verifiedOn` are all set (`effectivePrice` in the script enforces this). Scenarios `pilot` (3 mandals) and `statewide`.
- `scripts/cost-model.ts`: `npx tsx scripts/cost-model.ts [--scenario pilot|statewide|all] [--file other.json] [--json]`.
- `tests/compliance/cost-model.test.ts`: checks no price is invented, unknowns are flagged, caps follow the env vars.

## Cost lines (what the model counts)
SMS OTP, SMS notices, DLT registration, IVR minutes and number rental, missed calls, India-region hosting, storage and egress, KMS keys and requests (or a dedicated HSM, which is an alternative, not an addition), number intelligence lookups, audio recording and linguist review, independent red team, counsel (retainer and one-off).

## Volumes assumed (change them; they are not data)
| Assumption | Pilot | Statewide |
|---|---|---|
| Adults reachable | 150,000 (about 50,000 per mandal, a guess) | 55,000,000 (order of magnitude guess, unverified) |
| Signup rate | 15% | 8% |
| Signed-up users | 22,500 | 4,400,000 |
| OTPs per signup | 1.5 | 1.5 |
| OTP logins per user per month | 0.5 | 0.5 |
| Peak-day share of all signups | 20% | 5% |
| Peak-hour share of the peak day | 25% | 20% |

## What the run shows (quantities only; all prices UNKNOWN)
| Quantity over 12 months | Pilot | Statewide |
|---|---:|---:|
| SMS OTPs | 168,750 | 33,000,000 |
| Notice SMS | 270,000 | 52,800,000 |
| IVR minutes | 67,500 | 13,200,000 |
| Missed calls | 27,000 | 5,280,000 |
| Issue media at month 12 | about 119 GB | about 23,200 GB |
| Number intelligence lookups | 22,500 | 4,400,000 |
| Audio | 13 prompts x 3 dialects = 39 recordings | same |

### OTP caps in the code (the part that does not need prices)
Defaults read like `server/civic/identity/service.ts`: `CIVIC_SMS_HOURLY_BUDGET` 2000 per hour (global), `CIVIC_OTP_NET_LIMIT` 60 per network per 10 minutes.
- **Pilot:** peak hour about 1,688 OTPs, inside the 2000/h budget; hours to clear the peak day about 3.4. But a mandal office, kiosk or mobile NAT network with an assumed 120 signups in 10 minutes (180 OTPs) **exceeds the per-network cap of 60**. Volunteer-led enrolment drives from one network will hit it. Decide whether to raise `CIVIC_OTP_NET_LIMIT` for known enrolment centres or stagger drives.
- **Statewide:** peak hour about 66,000 OTPs against a 2000/h budget: the default budget is far too low for a state-wide launch day; clearing the assumed peak day at the budget rate would take about 165 hours. Either the budget is raised (a billing decision, with a billing-DoS risk, see DESIGN_2028 3.8 item 6), launch is staggered by district, or sign-up queues. The right number depends on the SMS price and on who pays.
These cap findings follow from the assumptions above and would change with real volumes.

## Unknowns that need a human to fill (each needs a source URL and date)
| Unknown | Who can supply it |
|---|---|
| SMS OTP and notice price, DLT fees | SMS aggregator quotes (vendor shortlist memo) |
| IVR per-minute, number rental, missed-call price | IVR aggregator quotes |
| India-region compute, storage, egress | Cloud quote sized from docs/CAPACITY.md |
| KMS key and request prices; dedicated HSM price | Cloud or HSM vendor |
| Number-intelligence price per lookup | Vendor quote |
| Studio, speaker and linguist fees | Local quotes (audio guide) |
| Red team and counsel fees | Quotes from firms |
| Real volumes | Census figures for chosen mandals, outreach plan, SHG enrolment plan |

Indicative prices exist on vendor and third-party marketing pages, for example an SMS OTP range quoted on a vendor blog and MSG91 slab rates on a roundup, but those pages are commercial, may be stale, and are not recorded as verified here.

## How to use after quotes arrive
1. Put each quoted price into `unitPrices` with `value`, `sourceUrl`, `verifiedOn`.
2. Rerun the script; the unknown count drops and a known total appears; the total is a budget only at 0 unknowns.
3. Re-check the cap section with the real OTP price and the funded hourly budget before setting `CIVIC_SMS_HOURLY_BUDGET` (documented in `.env.example`).
