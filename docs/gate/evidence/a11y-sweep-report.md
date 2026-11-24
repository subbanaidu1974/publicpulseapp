# Accessibility sweep (internal self-assessment, not independent)

Spec: `e2e/a11y-sweep.spec.ts` (single file, 28 routes x EN/TE x desktop 1280x800 / mobile 375x812 = 112 tests). Run: `PORT=4950 npx playwright test e2e/a11y-sweep.spec.ts --project=chromium`. axe-core via `@axe-core/playwright`, tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa. Critical and serious violations fail the test; `A11Y_SWEEP_OUT=<file>` writes every violation of any impact.

Routes: all 13 tabs (home, map, analytics, elections, civic, constituencies, survey, methodology, faq, privacy, terms, who, people), `/admin`, `/lite`, and hash routes (map, analytics turnout/compare/history, people party and leaders, surveys, consultations, dashboard, notifications and keys, countday, constituency profile). Anonymous state only; signed-in civic screens are covered by `e2e/civic-a11y.spec.ts`. The consent banner is left visible, as a first-time visitor sees it.

## First run: 124 violation rows, all serious

| Rule | Where | Fix |
|---|---|---|
| target-size (WCAG 2.2 2.5.8) | footer link buttons on every page; analytics link list; people source links | `py-1 min-h-[24px]` on footer buttons (`src/App.tsx`); `inline-block py-1` on analytics links (`AnalyticsRoot.tsx`) and the people source list (`pages.tsx`) |
| scrollable-region-focusable | compare tables, turnout seat table (mobile), "who sees what" table (mobile) | `tabIndex={0} role="region"` with an accessible name (`ComparePage.tsx`, `TurnoutPage.tsx`, `LegalPages.tsx`) |
| color-contrast | Elections page eyebrow label (`text-[9px]` slate-500) | `text-slate-700` (`ElectionsPage.tsx`) |
| label-content-name-mismatch | party chips on `/people` | aria-label is now "code name" and a space follows the code, so visible and accessible names agree (`src/components/people/common.tsx`) |

The people-file edits (`common.tsx`, one link class in `pages.tsx`) were made because they were the only remaining failures; another stream edits those files, so re-check for merge conflicts.

## Final run

112 of 112 pass, zero violations of any impact for those rule tags on those routes, repeated for stability. Regression runs of `e2e/civic-a11y.spec.ts`, `e2e/analytics.spec.ts`, `e2e/people.spec.ts` on chromium and mobile: 46 passed.

The spec retries around dev-server hot reloads (another editor saving a file mid-run destroys the page); that is test robustness, not hidden failures.

## What this does not show

- Automated axe finds only part of WCAG problems. Nothing here tests screen-reader output, Telugu pronunciation, focus order sense, 400 percent zoom reflow, motion, time limits or cognitive load.
- Signed-in flows, error states, modals and map interactions (canvas and tiles) are mostly outside this sweep.
- Only Chromium was run. Gate row 9 still needs a human audit with Telugu screen-reader testing and people with disabilities.
