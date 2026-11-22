# Gate row 12: PWA-lite measured on 2G-class connection and low-end device

Row 12 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. A measurement log from a physical low-end Android phone on a real throttled or genuinely poor network: device model, Android version, network profile, three or more runs, time to first usable form and time to a successful report submission.
2. The repeat of the offline queue check on that device.

## Acceptance criteria

- First usable form under the threshold in docs/PERFORMANCE.md (8 s on the simulated profile) on the real device, or the measured number is stated and the threshold change is justified by a named person.
- The report was submitted from the device, not only loaded.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/load/lite.size.test.ts#@E2E-90` - size budget (150 KB gzip) on the built output
- `tests/civic/channels.size.test.ts#@E2E-55` - civic bundle size guard
- `e2e/lite.spec.ts#@E2E-90` - simulated 2G measurement and offline queue (a laptop, not a device)
- `docs/PERFORMANCE.md` - the simulated-2G numbers

## Template

Copy this into `docs/gate/12/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
Device: ____ ; Android: ____ ; network: ____
Run 1/2/3 first usable (s): ____ / ____ / ____ ; report submitted: yes/no
Offline queue: ____ ; tester: ____ ; date: ____
```

## Attach

Put the artefacts in `docs/gate/12/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
