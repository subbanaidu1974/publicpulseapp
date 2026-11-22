# Testing

| What | Command |
|---|---|
| Typecheck | `npm run lint` |
| Unit + API + pipeline (Vitest) | `npm test` (subsets: `npm run test:pipeline`, `npm run test:api`) |
| Data quality gate | `npm run pipeline:validate` |
| Story tracker (regenerate `docs/STORY_TRACKER.md`) | `npm run tracker` |
| Tracker CI gate (fails if a `done` story references a tag no spec contains) | `npm run tracker -- --check` |
| E2E (Playwright, Chromium desktop + mobile 375x812) | `npm run test:e2e` |
| Everything | `npm run ci` |

## E2E
- One-time: `npx playwright install chromium`.
- Playwright starts `npm run dev` itself (port from `PORT`, default 3000) and reuses a running server.
- List specs without running: `npx playwright test --list`. Single scenario: `npx playwright test -g "@E2E-11"`. Debug UI: `npx playwright test --ui`. Report: `npx playwright show-report`.
- Every test title starts with its scenario tag (`@E2E-xx`, see `docs/E2E_SCENARIOS.md`). Vitest suites carry `UT-...` tags in `describe` titles.
- Specs locate UI only through `data-testid` values (state-switcher, nav-elections, elections-*, tally-row-<PARTY>, alliance-*, constituency-*, map-*, lang-toggle, error-banner, retry-button, survey-*, demo-badge, admin-data-status).
- E2E-19 admin-login test runs only when `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` (and optionally `E2E_ADMIN_OTP`) are set; the non-admin-blocked test always runs.
- E2E-21 (axe) fails on critical violations only.
- E2E-22 mocks `/api/v1/**` with HTTP 500 via `page.route`.

## Story tracker
`docs/stories/tracker.json` is the source of truth. A story may be `done` only when every id in `tests[]` appears as `@E2E-xx` / `@UT-xx` in a file under `e2e/` or `tests/`. `npm run tracker` regenerates `docs/STORY_TRACKER.md` with status counts and percent complete.

## CI
`.github/workflows/ci.yml`: install, tsc, vitest, data validation, tracker check, Playwright; the HTML report is uploaded as an artifact.
