# Gate row 7: OTP-send budget, per-ASN/device caps and degraded mode load-tested

Row 7 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. Load test results from the target hardware: phase table (requests, codes sent, cap that held, other responses, latency percentiles) for each cap, with the commands and commit used.
2. A review note saying whether the results meet the capacity plan, and what was changed as a result.
3. If a real SMS provider is installed: its own rate and failure behaviour during the test.

## Acceptance criteria

- Every cap held exactly (codes sent never exceeded the cap) and the degraded mode answered with the documented status.
- No unexplained 5xx and no connection errors at the planned peak.
- The report states that the per-ASN cap is an address-prefix proxy unless a trusted edge supplies the ASN, and which of the two was exercised.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `scripts/load/otp-flood.ts` - the OTP flood driver (`npm run load:otp`)
- `tests/load/load.smoke.test.ts#@E2E-90` - smoke run of the flood and count-day drivers
- `docs/PERFORMANCE.md` - measured numbers on a developer machine (localhost, dev stand-ins)
- `docs/CAPACITY.md` - single-process limits

## Template

Copy this into `docs/gate/07/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Hardware: ____ ; commit: ____ ; date: ____
Command lines: ____
Phases: one IP / many /24s / one /24 / one phone, many IPs -> codes sent ____ cap ____
Degraded mode status: ____ ; p99 under budget exhaustion: ____
Reviewer: ____
```

## Attach

Put the artefacts in `docs/gate/07/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
