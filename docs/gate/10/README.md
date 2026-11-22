# Gate row 10: Human-recorded Telugu audio for every IVR prompt

Row 10 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. Recorded audio for every prompt id in data/civic/audio-manifest.json, in the coastal, Rayalaseema and Telangana variants.
2. A signed-off manifest where `status` is no longer `placeholder` for any prompt.
3. A listening review by native speakers from each region.

## Acceptance criteria

- Every prompt in the code catalogue has a recording in every variant.
- No manifest entry is `placeholder`.
- The reviewers' sign-off names the dialect each covered.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/channels.test.ts` - manifest covers every prompt and flags placeholders

## Template

Copy this into `docs/gate/10/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Prompts recorded: __ of __ ; variants: coastal __ Rayalaseema __ Telangana __
Reviewers: ____ ; date ____ ; manifest commit ____
```

## Attach

Put the artefacts in `docs/gate/10/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
