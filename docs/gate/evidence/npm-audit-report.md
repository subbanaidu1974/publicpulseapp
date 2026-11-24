# npm audit triage (internal self-assessment, not independent)

Run on 2026-11-24 against `package-lock.json` in this worktree. This is the builders' own triage. It does not satisfy any release-gate row and nobody has signed it.

## Before

`npm audit` and `npm audit --omit=dev` both reported 10 vulnerabilities (1 critical, 7 high, 2 moderate).

| Package | Severity | Kind | Advisory topic |
|---|---|---|---|
| proxy-addr (via express) | critical | runtime, transitive | IP spoofing via IPv4-mapped IPv6 trust subnet |
| nodemailer | high | direct, runtime | 14 advisories: address parser DoS, recipient-domain bypasses, SMTP issues |
| vite | high | direct, dev/build | launch-editor and dev-server file serving advisories |
| postcss, source-map-js, nanoid, browserslist, baseline-browser-mapping | high/moderate | build-time, transitive | DoS and source-map path advisories |
| body-parser, qs, express | high/moderate | runtime, transitive | qs array-limit, isBuffer and stringify DoS |

## Actions

1. `npm audit fix` (no `--force`): semver-compatible bumps only (vite 6.4.3 to 6.4.6, postcss 8.5.15 to 8.5.33, source-map-js, nanoid, browserslist, proxy-addr, body-parser 1.20.5 to 1.20.9, express 4.22.2 to 4.22.3, qs 6.15.x to 6.16.2). No major bumps.
2. nodemailer: no import anywhere in `server/`, `src/`, `scripts/`, `pipeline/`; the only mention is the negative assertion in `tests/server/security.test.ts` (no mail code in `server.ts`). It was an unused direct dependency whose fix was a semver-major (10.x). Removed `nodemailer` and `@types/nodemailer` with `npm uninstall` instead of upgrading.
3. A second `npm audit fix` picked up express 4.22.3 / qs 6.16.2 once nodemailer was gone.

## After

`npm audit`: found 0 vulnerabilities. `npm audit --omit=dev`: found 0 vulnerabilities.

Checks after the changes: full `npx vitest run` passed (113 files, 1110 tests) before the new red-team file was added; `npm run build` succeeds; the Playwright a11y sweep and `e2e/civic-a11y.spec.ts`, `e2e/analytics.spec.ts`, `e2e/people.spec.ts` pass on the new tree.

## Remaining issues

None reported by audit. Caveats:

- `npm audit` only knows advisories published by the day it ran; run `npm audit --omit=dev --audit-level=high` in CI on a schedule.
- The lockfile changed in a worktree shared with other work in progress. Review `git diff package-lock.json` before committing. `bun.lock` was not regenerated (the repo ships both; if bun is used for production installs, run `bun install` to refresh it).
- npm warns that `esbuild` has an install script not covered by `allowScripts`; not a vulnerability, noted for a supply-chain review.
