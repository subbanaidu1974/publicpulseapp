# People Pulse

An election-trends explorer for Andhra Pradesh and Telangana (assembly and Lok Sabha results, constituency pages, map, forecast projection) and the foundation of a civic participation platform: phone-verified residents, households, issue reporting down to the village, and assisted channels (SMS, missed call, IVR). The product is Telugu-first (English and Telugu throughout).

Pulse surveys are **non-binding opinion polls, never votes**. No page may present them as an election, ballot or result (`npm run lint:copy` enforces the wording). See `docs/DESIGN_2028.md` section 0 for why.

Status: the elections explorer is complete; the civic platform is a Phase 1 pilot build. Progress per story is in `docs/STORY_TRACKER.md`. Nothing election-adjacent may go live before the release gate (`docs/RELEASE_GATE.md`) is signed off.

## Quick start

Requirements: Node.js 22.13 or newer (Node 24 recommended; the civic store uses the built-in `node:sqlite`).

```
npm ci
cp .env.example .env        # optional: every variable has an in-code default for development
npm run dev                 # http://localhost:3000 (Express + Vite middleware, one process)
```

The first run creates the civic SQLite database at `data/civic.db` and applies migrations. In development OTPs are logged to the console by a dev SMS provider; set `CIVIC_EXPOSE_DEV_OTP=1` to have the API echo them (used by the end-to-end tests; ignored in production).

Production-like run of the built bundle:

```
npm run build               # vite bundle + dist/server.cjs + dist/scripts/*.cjs
npm start                   # NODE_ENV=production: refuses to start on dev stand-ins (see Security posture)
SERVE_BUILT=1 node dist/server.cjs   # serve dist/ without Vite on a staging box
```

Container: `docker compose up -d --build` (see `docs/DEPLOYMENT.md`).

## Configuration

All environment variables are documented in `.env.example` with their defaults and a one-line purpose; CI fails (`npm run check:docs`) if the code reads a variable that is not listed there. Groups: server (`PORT`, `NODE_ENV`, `TRUST_PROXY`, `CORS_ORIGINS`, rate limits), civic stores (`CIVIC_DB`, `CIVIC_MEDIA_DIR`, `CIVIC_AUDIT_ANCHOR_FILE`), identity and abuse limits (`CIVIC_*`), channels (`CIVIC_IVR_*`), observability (`LOG_LEVEL`, `METRICS_TOKEN`), backups (`CIVIC_BACKUP_*`), data pipeline sources.

## Data pipeline

Public election, census and boundary data live in `data/generated/` as JSON/GeoJSON with a `provenance` field. Datasets whose provenance is `demo` are fixtures: the UI shows a demo badge and a production start refuses them (override only on staging with `CIVIC_ALLOW_DEMO=1`).

```
npm run pipeline:elections    # TCPD/ECI-derived results
npm run pipeline:census       # Census 2011 (data.gov.in, needs DATA_GOV_IN_API_KEY)
npm run pipeline:boundaries   # DataMeet constituency boundaries
npm run pipeline:validate     # data quality gate (also run in CI)
npm run pipeline:all
```

Method notes: `docs/FORECAST_METHOD.md`. Maps are plain boundary shapes drawn from our own data: no map tiles, no third-party map provider.

## Testing

| Command | What |
|---|---|
| `npm run lint` | TypeScript typecheck (`tsc --noEmit`) |
| `npm run lint:eslint` | ESLint (flat config, typescript-eslint) |
| `npm test` | Vitest: API, pipeline, civic (identity, households, issues, channels, jobs), server security, ops, tooling |
| `npm run test:coverage` | Vitest with coverage thresholds on `server/civic` and `src/lib` |
| `npm run test:e2e` | Playwright, desktop and 375x812 mobile, includes a production-build smoke test |
| `npm run tracker -- --check` | Story gate: tagged tests exist, and (with `--report`) ran and passed without skips |
| `npm run check:docs` | `.env.example` covers every environment variable |
| `npm run ci` | The local approximation of the CI pipeline |

Every test title starts with its scenario tag (`@E2E-xx`, `@UT-xx`); stories in `docs/stories/tracker.json` list the tags that prove them. Details: `docs/TESTING.md`, `docs/E2E_SCENARIOS.md`.

## Project structure

```
server.ts            entry: request ids + health/metrics, API app, Vite (dev) or dist/ (prod)
server/api.ts        read-only public API (elections, census, forecast, geo)
server/security.ts   security headers, CORS, gzip, rate limiter, cache headers, app assembly
server/obs.ts        structured logging with redaction, /healthz, /readyz, /metrics
server/civic/        civic platform: core (DB, migrations, keys, audit chain), identity, households,
                     geo, issues, channels (SMS/IVR), jobs, guards, backup
src/                 React + Tailwind UI (components, i18n, lib, state, api client)
pipeline/ scripts/   data ingestion, validation, tracker, backup, copy lint, secret scan, docs check
data/                generated datasets, civic fixtures (local databases are git-ignored)
tests/ e2e/          Vitest and Playwright suites
docs/                design, threat model, runbooks, release gate, story tracker
```

## Security posture

- Production startup guards (`server/civic/guards.ts`): the process refuses to start in production on dev key or SMS providers, dev OTP echo, dev number-intelligence fixtures or demo data. Real HSM/KMS and DLT SMS adapters are still to be built, so a literal production start refuses by design.
- Phone numbers are HMAC-hashed and field-encrypted; the audit log is hash-chained with external anchoring and a verification job that raises an alarm and fails `/readyz`.
- Headers (CSP, HSTS behind HTTPS, frame and referrer policies), same-origin CORS by default, per-IP rate limits, small body limits, no raw admin or OTP-mail endpoints.
- Logs are structured JSON with request ids; phone, OTP, PIN, token and e-mail values are redacted. `/metrics` is loopback- or token-only.
- Backups are AES-256-GCM encrypted with a manifest and a restore drill; migrations are checksummed.
- Secret scanning (gitleaks plus a local fallback) runs in CI; dependency audit is reported.
- Known gaps and the threat model: `docs/THREAT_MODEL.md`. Breach handling (draft, needs counsel): `docs/BREACH_RUNBOOK.md`. Retention: `docs/RETENTION.md`.

## Documentation

- `docs/DESIGN_2028.md` design of the civic platform; `docs/DESIGN.md` the elections explorer
- `docs/PHASE1_PLAN.md` pilot plan; `docs/GAP_AUDIT.md` what is missing and why
- `docs/DEPLOYMENT.md` hosting, TLS, proxy, container, env checklist
- `docs/RUNBOOK.md` backups, key escrow, restore drill, migration rollback
- `docs/TESTING.md`, `docs/E2E_SCENARIOS.md`, `docs/STORY_TRACKER.md`
- `docs/THREAT_MODEL.md`, `docs/RELEASE_GATE.md`, `docs/BREACH_RUNBOOK.md`, `docs/RETENTION.md`
