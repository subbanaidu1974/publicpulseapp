# Operations runbook

Covers backups and key escrow (S-68), restore drills, migration drift and rollback (S-72), and first-response checks (S-67). Breach handling is in `docs/BREACH_RUNBOOK.md`; deployment in `docs/DEPLOYMENT.md`.

## 1. Backups

What: an online, consistent copy of the civic SQLite database (`VACUUM INTO`, safe while serving), encrypted with AES-256-GCM and written as `civic-<UTC timestamp>.db.enc` plus `civic-<timestamp>.manifest.json` (file name, sizes, sha256 of the encrypted file, per-table row counts, audit head). The key never appears in the manifest, logs or script output.

```
npm run backup                 # tsx scripts/backup.ts   (container: node dist/scripts/backup.cjs)
# env: CIVIC_DB, CIVIC_BACKUP_KEY (required in production), CIVIC_BACKUP_DIR (default data/backups), CIVIC_BACKUP_KEEP (default 14)
```

- Schedule it from the host (cron, systemd timer or orchestrator), at least daily and before every deploy. The newest `CIVIC_BACKUP_KEEP` files are kept; older ones and their manifests are rotated away.
- Ship the backup directory off the host to storage in the same India region, with its own access controls. The encrypted files are safe to store there; the key is not.
- Without `CIVIC_BACKUP_KEY` a production run refuses. In non-production a public dev key is used and a warning is printed (no confidentiality; for tests only).
- Generate a key with `openssl rand -hex 32` (64 hex characters; base64 of 32 bytes also works).
- Media files under `CIVIC_MEDIA_DIR` and the anchor file are not inside the database; back those volumes up separately.

## 2. Key escrow

The backup key protects every resident record in every backup. Losing it makes all backups unreadable; leaking it exposes them.

1. Generate the key on a trusted machine, not on the app host. Never paste it into chat, tickets or CI logs.
2. Split custody. Keep the working copy in the organisation's KMS/HSM or secret manager. Keep an offline escrow copy in two sealed envelopes held by two different named custodians (for example the Data Protection Officer and the engineering lead) in separate safes, so no single person can retrieve both.
3. Record in the access register: key id (first 8 hex characters of its sha256, never the key), date, custodians, rotation due date.
4. Rotate at least yearly, and on any suspected exposure or custodian change: generate a new key, take a fresh backup with it, verify it with a restore drill, then update the secret. Keep the old key until the last backup made with it has aged out of the retention window, then destroy it and record the destruction. Do not re-encrypt in place.
5. Break-glass: retrieving an escrow envelope needs both the incident commander and the DPO, is logged in the access register, and is followed by rotation.

## 3. Restore drill (monthly, and after any key or schema change)

```
npm run restore-drill          # tsx scripts/restore-drill.ts [--file data/backups/civic-....db.enc]
```

It decrypts the newest (or the given) backup into a temporary file, checks the manifest sha256, compares per-table row counts with the manifest, then runs `verifyAuditChain` against the restored copy. Exit code 0 means every check passed. Run it in its own process with the SAME `CIVIC_BACKUP_KEY` and the same key provider as the source system (audit digests are keyed, so a different key provider reports the chain as edited). Record date, backup file, result and who ran it in the drill log. A drill that has never passed means you do not have a backup.

Failure meanings: "manifest sha256" = file damaged or tampered with in storage; "authentication failed" = wrong key or modified bytes; "table x: manifest N rows" = incomplete restore; "audit chain" = the data in the backup was edited, or the key provider differs. Treat an audit-chain failure on production data as an incident (BREACH_RUNBOOK).

## 4. Restore for real

1. Stop the app. Keep the damaged `civic.db` (and `-wal`, `-shm`) aside for forensics.
2. Run the drill (`node dist/scripts/restore-drill.cjs`) first, to prove the chosen backup is good.
3. Decrypt to the live path using `restoreBackup({ file, key, dest })` from `server/civic/backup.ts` (it refuses to overwrite an existing file, so move the old file first), or restore the pre-migrate copy (section 5).
4. Start the app and check `/readyz` is 200. Check the audit anchors still match (the verify job alarms otherwise). Record the incident and the data-loss window.

## 5. Migrations: drift and rollback

- Every applied migration stores `sha256(sql)` in the `migrations` table. At startup, if the SQL of an applied migration no longer matches, the server refuses to start with "civic migration drift". Cause: someone edited an already-applied migration. Fix: restore the original text and add a NEW migration for the change. `CIVIC_ALLOW_DRIFT=1` overrides it for an emergency start (it warns, and `/readyz` still reports the drift); remove it afterwards.
- Rows written before checksums existed are stamped on the first start after upgrading.
- Before pending migrations are applied to a non-empty file database, `<db dir>/backups/pre-migrate-<timestamp>.db` is written (newest 5 kept). It is plaintext SQLite, exactly as sensitive as the live file: keep the directory on the encrypted volume with the same permissions. Disable only with `CIVIC_PREMIGRATE_BACKUP=0`.
- Rollback of a bad deploy that ran a migration: stop the app, deploy the previous build, move the live DB aside, copy the latest `pre-migrate-*.db` to the live DB path, start, check `/readyz`. Data written after the migration started is lost; if that matters, restore from the newest encrypted backup instead and replay what you can. Migrations are forward-only; there are no down scripts.

## 6. First-response checks

| Symptom | Look at |
|---|---|
| Site down or 5xx | `/healthz`; container logs (JSON; find the `reqId` from a user report or the `X-Request-Id` response header) |
| `/readyz` 503 | The failing check in the JSON body: `db`, `migrations` (pending or drift), `auditChain` (alarm) |
| `auditChain` alarm | Do not restart to clear it. Open `docs/BREACH_RUNBOOK.md`; compare the DB with the latest anchor and the newest backup |
| Jobs failing | `/metrics`: `pulse_job_last_ok{job="..."} 0`; the admin endpoint `/api/v1/civic/ops/jobs` shows the last error text |
| Startup refuses in production | The message lists each guard that failed (docs/DEPLOYMENT.md section 1) |
