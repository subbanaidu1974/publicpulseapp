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

## Operations tests (S-67..S-72, S-77)
- `tests/ops`: logger redaction and request ids, /healthz /readyz /metrics, encrypted backup round trip and tamper detection, restore drill, migration checksums and pre-migrate backup, Dockerfile basics, env-var docs check. Run with `npm run test:ops`.
- `e2e/ops.spec.ts` (E2E-84) builds the production bundle and runs it: production mode must refuse dev stand-ins; the built bundle (`SERVE_BUILT=1`) must serve /healthz, /readyz, the static page and an /api/v1 call.
- Coverage: `npm run test:coverage` enforces thresholds on `server/civic` and `src/lib` (set in `vitest.config.ts`, just below the actuals; ratchet up, never down). ESLint: `npm run lint:eslint`. Env docs: `npm run check:docs`.

## Tracker gate with real results (S-71)
`npm run tracker -- --check --report vitest.json --report playwright.json` additionally requires every tag of a `done` story to have run in the matching report (Playwright for `e2e/`, Vitest for `tests/`) and passed, with no skipped or failed test, and fails when `docs/STORY_TRACKER.md` is not what a fresh render produces. Produce the reports with `npx vitest run --reporter=default --reporter=json --outputFile.json=vitest.json` and `PLAYWRIGHT_JSON_OUTPUT_NAME=playwright.json npx playwright test --reporter=list,html,json`.

## CI
`.github/workflows/ci.yml`: unit tests on Ubuntu and Windows; then on Ubuntu: gitleaks and local secret scan, audit and copy lint (report only), tsc, ESLint, docs check, Vitest with coverage thresholds and a JSON report, data validation, production build, Playwright (JSON report), tracker gate with both reports. Reports and the HTML report are uploaded as artifacts.
