# Deployment guide

Scope: running People Pulse (one Node process, SQLite for civic data, static bundle) on a single host or container. Stories S-69 (this guide, Dockerfile), S-67 (health/metrics), S-68 (backups), S-72 (migrations). Docker was not available in the authoring environment: the Dockerfile and compose file are covered by static tests (`tests/ops/docker.test.ts`) and the same built bundle is smoke-tested without Docker (`e2e/ops.spec.ts`), but the authors have not run a real `docker build`. Do that first in your pipeline.

## 1. What a production start requires (read this first)

`NODE_ENV=production` (or `CIVIC_ENV=production`) turns on the startup guards in `server/civic/guards.ts` (`assertProductionSafe`). The process **refuses to start** (exit 1, message "civic refuses to start in production: ...") while any of these hold:

| Guard | Fix |
|---|---|
| Dev key provider is the only key source | Install an HSM/KMS `KeyProvider` with `setKeyProvider` (contract in `server/civic/core/index.ts`). `CIVIC_DEV_MASTER_KEY` is not acceptable in production. |
| Dev SMS provider installed | `setSmsProvider` with a DLT-registered sender. |
| Number-intelligence dev fixtures active | `setNumberIntelligence` with a real adapter. |
| `CIVIC_EXPOSE_DEV_OTP=1` | Unset it. |
| Demo data provenance in `data/generated` | Run the real data pipeline (`npm run pipeline:all`), or set `CIVIC_ALLOW_DEMO=1` on a staging box only. |

Also required by the code paths, not by the start-up guard: `CIVIC_BACKUP_KEY` (backups refuse to run in production without it), `CIVIC_IVR_WEBHOOK_SECRET` or `CIVIC_IVR_ALLOWED_IPS` (IVR webhooks answer 401 in production without them), and `TRUST_PROXY` when behind a proxy.

The real adapters do not exist in this repository yet, so **a literal production start currently refuses by design**. `e2e/ops.spec.ts` asserts that ("NODE_ENV=production refuses to start on dev stand-ins"). For a staging environment that is explicitly allowed to use dev stand-ins:

```
NODE_ENV=staging SERVE_BUILT=1 CIVIC_ALLOW_DEMO=1 node dist/server.cjs
```

`SERVE_BUILT=1` serves the `dist/` bundle without Vite. Never expose a staging box that holds real resident data.

## 2. Hosting: India region, TLS

Per `docs/DESIGN_2028.md` section 2, storage is India-region with encryption at rest and in transit. Practical guidance:

- Host in an Indian region (for example Mumbai or Hyderabad on the major clouds, or an Indian provider). Keep the database volume, media, backups and anchor sink in the same region. Cross-border copies of backups need counsel review (DPDP Act, **[VERIFY]**).
- Encrypt the volume at rest (cloud-provider disk encryption) in addition to the app's field-level encryption and the encrypted backups.
- Terminate TLS at a reverse proxy or load balancer (Caddy, nginx, or the cloud LB) with TLS 1.2+ and automatic certificate renewal. Redirect HTTP to HTTPS. The app sets HSTS only when it sees `X-Forwarded-Proto: https`, so the proxy must send that header.
- Put a CDN in front of the static assets and the read-only public API for count day (design target: read-heavy, cache public result pages). `/api/v1` responses already carry `Cache-Control` and `ETag`.
- Do not expose `/metrics` publicly (section 5). Expose `/healthz` and `/readyz` to your load balancer and monitor only.

## 3. Reverse proxy and TRUST_PROXY

Behind a proxy every request appears to come from the proxy's address, which breaks per-IP rate limits and network OTP limits. Set `TRUST_PROXY` to the number of proxy hops you control (usually `1`). Never set `TRUST_PROXY=true` when the app is reachable directly from the internet, because clients could then spoof `X-Forwarded-For`.

Minimal nginx location (adapt):

```
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Request-Id $request_id;   # optional: the app honours a safe inbound id and returns it
  client_max_body_size 4m;                      # the civic media route accepts larger JSON than the 64kb default
}
```

## 4. Container

```
docker build -t people-pulse .
docker run --rm -p 3000:3000 --env-file .env -v pulse-data:/var/lib/pulse people-pulse
# or
cp .env.example .env   # edit
docker compose up -d --build
```

- Multi-stage on `node:24-bookworm-slim` (engines are `>=22.13`; `node:sqlite` needs 22.5+). Production dependencies only; Vite is loaded lazily and only in dev.
- Runs as the non-root `node` user. The healthcheck calls `/healthz`.
- All state is under `/var/lib/pulse` (one volume): the four store files `civic.identity.db`, `civic.issues.db`, `civic.survey.db`, `civic.audit.db` (and WAL files; a pre-split `civic.db` is imported once and kept read-only as a backup; `docs/STORES.md`), `media/`, `anchors/audit-anchors.jsonl`, `backups/`. Back the volume up at the infrastructure level as well, and keep the anchor file somewhere an attacker with the DB cannot rewrite (see `docs/THREAT_MODEL.md`).
- Run one replica. SQLite is single-writer; scaling out needs the Postgres move (E2E-88).
- The image contains `dist/scripts/backup.cjs` and `dist/scripts/restore-drill.cjs`: `docker compose exec app node dist/scripts/backup.cjs`.

## 5. Observability endpoints

| Endpoint | Purpose | Exposure |
|---|---|---|
| `GET /healthz` | Liveness: the process answers. | Load balancer, monitors. |
| `GET /readyz` | Readiness: DB reachable, no pending or drifted migrations, audit chain not alarming, data provenance. 503 when not ready. | Load balancer (use it for traffic), monitors. |
| `GET /metrics` | Prometheus text: request counts and latency by route class, job runs/failures, audit alarm, readiness. | Loopback only, or `Authorization: Bearer $METRICS_TOKEN`. A request carrying `X-Forwarded-For` is never treated as loopback. |

Logs are JSON lines on stdout (one object per line) with `ts`, `level`, `msg`, `reqId`. Phone numbers, OTPs, PINs, tokens and e-mail addresses are redacted before they are written. `LOG_LEVEL` changes verbosity. Alert on: `/readyz` non-200 for more than 2 minutes; `pulse_audit_chain_alarm == 1` (page immediately; see `docs/BREACH_RUNBOOK.md`); `pulse_job_last_ok == 0`; a rising 5xx share of `pulse_http_requests_total`.

## 6. Environment checklist

Every variable the code reads is documented in `.env.example` (enforced in CI by `npm run check:docs`). Before go-live confirm:

- [ ] `NODE_ENV=production`; no `CIVIC_EXPOSE_DEV_OTP`, `CIVIC_DEV_MASTER_KEY`, `CIVIC_ALLOW_DEMO` or `CIVIC_ALLOW_DRIFT`.
- [ ] `TRUST_PROXY` matches the real proxy hop count; HTTPS enforced at the proxy.
- [ ] `CIVIC_DB`, `CIVIC_MEDIA_DIR`, `CIVIC_AUDIT_ANCHOR_FILE`, `CIVIC_BACKUP_DIR` on the persistent volume.
- [ ] `CIVIC_BACKUP_KEY` set, escrowed (docs/RUNBOOK.md), and a restore drill passed this month.
- [ ] `CIVIC_IVR_WEBHOOK_SECRET` and/or `CIVIC_IVR_ALLOWED_IPS` set.
- [ ] `METRICS_TOKEN` set if Prometheus scrapes over the network.
- [ ] `FORECAST_BLACKOUT` ready for the legally required silence period.
- [ ] Real data in `data/generated` (provenance not "demo").
- [ ] Release gate (`docs/RELEASE_GATE.md`) signed off for any election-adjacent survey.

## 7. Upgrades, migrations, rollback

Migrations run at startup. Each applied migration stores a sha256 of its SQL; the server refuses to start if an applied migration's SQL changed (never edit an applied migration, add a new one). When migrations are pending on a non-empty database a copy is written first to `<db dir>/backups/pre-migrate-<timestamp>.db` (newest 5 kept). Rollback procedure: `docs/RUNBOOK.md`.
