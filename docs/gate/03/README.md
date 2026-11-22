# Gate row 3: Pilot skew report (2-3 mandals)

Row 3 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. A published report for 2-3 pilot mandals: response rate by gender, age band, phone ownership and shared-SIM status, the reference marginals used, the method, and the caveats.
2. The aggregate counts file fed to the tool (aggregate only, no individual rows) and the tool output (text and JSON).
3. A statement of what reference data was NOT available (electoral roll; Census 2011 has no age band or phone ownership at mandal level).

## Acceptance criteria

- The report states that pilot results are a signal, not a representative sample.
- No stratum below the minimum cell size is reported as a finding.
- The report was published before any pilot result was shown.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/pilot/pilot-skew.test.ts#@E2E-168` - the skew tool on SYNTHETIC data
- `scripts/pilot-skew.ts` - the tool
- `docs/PILOT_SKEW_PLAN.md` - method

## Template

Copy this into `docs/gate/03/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Mandals: ____ ; period: ____ ; invited: ____ ; responded: ____
Reference used: census-subdistricts.json (sex) / other: ____
Index by dimension: gender __ age __ phone __ ; flagged strata: ____
Published at: ____ (date, URL)
```

## Attach

Put the artefacts in `docs/gate/03/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
