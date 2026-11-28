# MySQL data model and migration design

Design only. Source of truth for what exists today: `STORE_TABLES` in `server/civic/core/stores.ts` and the `registerMigration` calls next to each module. This document says how each part maps to MySQL and gives DDL for the tables that change shape (media) plus patterns for the rest, which are ported one for one.

## 1. Engine and layout
- **MySQL 8.4 LTS**, InnoDB, `utf8mb4` with collation `utf8mb4_0900_ai_ci` (correct ordering and comparison for Telugu and English; accent- and case-insensitive for search columns, binary collation `utf8mb4_0900_bin` for tokens and hashes).
- **Managed service in an Indian region** (provider open, S-246). Multi-AZ primary with automatic failover, one read replica for public read traffic (S-268).
- **Four schemas, four database users**, matching today's four stores:

| Schema | Tables (today's placement, unchanged) | User and grants |
|---|---|---|
| `pp_identity` | persons, sessions, consents, roles, otps, rate_events, attestations, enrolments, households (`hh_*`), admin MFA, officer tables, people requests, photo_submissions, sms_ledger, provider_keys, `notify_*`, issue_links, erasure_outbox, and the content tables that are registered to the default store today (`mhub_*`, `vcast_*`, `jobs`) | `pp_identity_app`: all DML on `pp_identity.*` only |
| `pp_issues` | issue, issue_me_too, issue_event, issue_media, moderation tables, geography (`admin_unit`, `hamlet`, `village_constituency`), ivr_call, rep_reply, grievance_link, assisted tables | `pp_issues_app`: DML on `pp_issues.*` only |
| `pp_survey` | surveys, questions, options, versions, responses, spent_token, credential keys, broadcast polls (`bpoll_*`), consultations (`consultation_*`) | `pp_survey_app`: DML on `pp_survey.*` only |
| `pp_audit` | audit_log, audit_anchors | `pp_audit_app`: `INSERT, SELECT` only (no `UPDATE`, no `DELETE`); a separate read-only user for the verifier |

- **No grant crosses a schema.** That makes "no statement joins two stores" a property of the database, not only of a test. The existing placement test (`assertStorePlacement`) is kept and runs against MySQL.
- **Stronger separation (recommended for production):** `pp_audit` and `pp_identity` on separate instances. The code already treats them as separate connections, so this is configuration (S-272).
- Content tables (`mhub_*`, `vcast_*`) are in identity today only because they were registered to the default store. First port keeps them there (no redesign during a migration); a later optional story can give them a `pp_content` schema. Media object metadata (section 5) is new and is placed in `pp_content`.

## 2. Data access in code (S-248)
```ts
interface Db {
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastId?: string | number }>;
  tx<T>(fn: (tx: Db) => Promise<T>, opts?: { retries?: number }): Promise<T>;   // BEGIN ... COMMIT, retries on deadlock (1213) and lock timeout (1205)
}
getStore("identity" | "issues" | "survey" | "audit"): Db
```
- Two adapters: `mysql2/promise` pools (production, CI) and `node:sqlite` wrapped in promises (fast local and unit tests). Same SQL text must run on both, so queries use only the subset in section 3, or a small per-engine fragment helper (`upsert`, `now`).
- A lint rule forbids importing `node:sqlite` outside the adapter. Direct `prepare()` calls are converted store by store.
- Pool per store: size from config; `connectionLimit` default 10 per instance; queue limit and a timeout so overload becomes a 503, not a hang.

## 3. SQL and behaviour rules (SQLite to MySQL)
| SQLite today | MySQL | Notes |
|---|---|---|
| `TEXT PRIMARY KEY` (UUID strings) | `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin` | same app-generated ids, no code change; a compact `BINARY(16)` form is a measured later option (S-274) |
| `INTEGER PRIMARY KEY` (`audit_log.seq`) | `BIGINT UNSIGNED AUTO_INCREMENT` or a managed counter | audit uses a chain head row (section 6) |
| ISO time strings in `TEXT` (`'2026-11-26T10:00:00.000Z'`) | `VARCHAR(24)` holding the same 24-character ISO UTC string (**changed during S-248**) | MySQL rejects a trailing `Z` in `DATETIME` (error 1292), and a string that sorts and compares identically on both engines removes a whole class of conversion bugs. Fixed-width UTC ISO strings order correctly. The DDL below that says `DATETIME(3)` is superseded by this rule; use `VARCHAR(24)` for application timestamps. `strftime` (1 use) becomes `DATE_FORMAT` on a cast |
| `TEXT` JSON blobs | `JSON` where queried, else `TEXT`/`MEDIUMTEXT` | keep the app's JSON.parse; no JSON functions are used today |
| booleans as `INTEGER` 0/1 | `TINYINT(1)` | unchanged |
| `INSERT OR IGNORE` (28) | `INSERT ... ON DUPLICATE KEY UPDATE <pk>=<pk>` | not `INSERT IGNORE`, which also hides unrelated errors |
| `INSERT OR REPLACE` (14) | `INSERT ... ON DUPLICATE KEY UPDATE` listing columns | not `REPLACE INTO` (it deletes and reinserts and fires cascades) |
| `ON CONFLICT (...) DO UPDATE` (15) | `ON DUPLICATE KEY UPDATE`; the conflict target must be a unique key | `excluded.col` becomes `VALUES(col)` or an alias |
| `.changes` (58 uses) | `affectedRows` | MySQL counts only changed rows unless the connection sets `CLIENT_FOUND_ROWS`; **set `foundRows: true`** so `UPDATE ... SET x = same` still reports 1, as SQLite does |
| `lastInsertRowid` (2) | `insertId` | |
| `BEGIN IMMEDIATE` (4) and write-once rules that relied on a single writer | `START TRANSACTION` plus `SELECT ... FOR UPDATE` on the row or a guard row | review each of the 41 transaction sites; default isolation `REPEATABLE READ`; add a deadlock retry in `tx` |
| `PRAGMA` (7), `WITHOUT ROWID` (6) | removed | clustered primary key already behaves like `WITHOUT ROWID` |
| `AUTOINCREMENT` (8) | `AUTO_INCREMENT` | |
| `CHECK (col IN (...))` | same; enforced from MySQL 8.0.16 | keep every CHECK |
| Partial or expression indexes | not available; use a generated column plus an index, or a plain index | list is built during S-250 |
| `LIKE` (12) | same; collation decides case | use the binary collation for tokens |
| Case sensitivity of table names | lower snake case everywhere | already the rule |
| `NULL` ordering | MySQL puts NULL first on ASC | add `ORDER BY col IS NULL, col` where the order matters |
| Text length | `VARCHAR(n)` for indexed text, `TEXT` otherwise | choose n from the existing validators |
| Row size limits and index key length | `utf8mb4` indexes up to 3072 bytes per key | long indexed text uses a hash column |

Behaviour the shared suite must prove on both engines: uniqueness (one report per person per item), counters that never go negative, the hash chain, retention deletes, rate-limit windows, the "different admin" rules, and every privacy minimum.

## 4. Migrations (S-249)
- Keep today's model: ordered ids, a `migrations` table per schema with a checksum, drift detection, and `migrate()` at start. Port the runner to `Db`.
- **Expand then contract:** a migration that adds is deployed first; code switches; a later migration removes. No migration both renames and drops.
- Online schema change for large tables (`ALGORITHM=INPLACE, LOCK=NONE` where supported; otherwise a copy tool); a migration that would lock a hot table fails review.
- Every migration runs in CI on an empty MySQL and on a copy with representative data.
- The migration tool never runs from the web process on more than one instance at once: one deploy job applies them under `GET_LOCK('pp_migrate', 60)`.

## 5. Media tables (new; schema `pp_content`)
Files are not stored in MySQL (MEDIA_STORAGE.md). These rows describe the objects.

```sql
CREATE TABLE media_object (
  id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose       ENUM('issue_photo','consultation_audio','video','video_poster','source_logo','public_photo') NOT NULL,
  visibility    ENUM('private','public') NOT NULL,
  bucket        VARCHAR(63)  CHARACTER SET ascii NOT NULL,
  object_key    VARCHAR(512) CHARACTER SET ascii NOT NULL,
  content_type  VARCHAR(100) CHARACTER SET ascii NOT NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL,
  sha256        CHAR(64) CHARACTER SET ascii NOT NULL,
  encryption    ENUM('none','sse','app_aes_gcm') NOT NULL DEFAULT 'none',
  owner_ref     CHAR(64) CHARACTER SET ascii NULL,          -- keyed pseudonym of the uploader, never a person id (issue and consultation media)
  state         ENUM('pending','uploaded','scanning','ready','rejected','deleted') NOT NULL DEFAULT 'pending',
  scan_result   VARCHAR(40) NULL,
  retention_until DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL,
  ready_at      DATETIME(3) NULL,
  deleted_at    DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_key (bucket, object_key),
  KEY ix_media_state (state, created_at),
  KEY ix_media_retention (retention_until),
  KEY ix_media_owner (owner_ref, purpose)
) ENGINE=InnoDB;

CREATE TABLE media_variant (            -- thumbnails, resized images
  media_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  variant    VARCHAR(20) CHARACTER SET ascii NOT NULL,       -- 'thumb','w640','w1280'
  object_key VARCHAR(512) CHARACTER SET ascii NOT NULL,
  width INT UNSIGNED NULL, height INT UNSIGNED NULL, size_bytes BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (media_id, variant),
  CONSTRAINT fk_variant_media FOREIGN KEY (media_id) REFERENCES media_object(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE video_asset (              -- one per uploaded video; ties to the existing vcast_videos row
  media_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,      -- the original upload
  duration_ms   INT UNSIGNED NULL,
  poster_media_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  transcode_state ENUM('queued','running','ready','failed') NOT NULL DEFAULT 'queued',
  transcode_error VARCHAR(200) NULL,
  hls_manifest_key VARCHAR(512) CHARACTER SET ascii NULL,
  captions_media_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (media_id),
  CONSTRAINT fk_video_media FOREIGN KEY (media_id) REFERENCES media_object(id)
) ENGINE=InnoDB;

CREATE TABLE video_rendition (
  media_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(10) CHARACTER SET ascii NOT NULL,            -- '360p','720p'
  bitrate_kbps INT UNSIGNED NOT NULL, width INT UNSIGNED NOT NULL, height INT UNSIGNED NOT NULL,
  playlist_key VARCHAR(512) CHARACTER SET ascii NOT NULL,
  PRIMARY KEY (media_id, label),
  CONSTRAINT fk_rend_video FOREIGN KEY (media_id) REFERENCES video_asset(media_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE upload_session (           -- presigned upload in progress
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  media_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose VARCHAR(30) CHARACTER SET ascii NOT NULL,
  expected_size BIGINT UNSIGNED NOT NULL, expected_sha256 CHAR(64) CHARACTER SET ascii NOT NULL,
  multipart_id VARCHAR(200) CHARACTER SET ascii NULL,
  expires_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii NULL,
  PRIMARY KEY (id), KEY ix_upload_expiry (expires_at),
  UNIQUE KEY uq_upload_idem (idempotency_key)
) ENGINE=InnoDB;
```
Existing tables that point at local files (`issue_media`, `photo_submissions`, `consultation_audio_files`) gain a `media_id` column in the expand step and drop their file path in the contract step (S-259). Foreign keys do **not** cross schemas (the owning schema stores `media_id` as a plain reference, checked by the media service), preserving the rule that stores do not join.

## 6. Audit chain (S-253)
`audit_log` keeps its columns (seq, ts, actor, action, object, meta, digests, redacted flag, prev_hash, hash).
```sql
CREATE TABLE audit_log (
  seq BIGINT UNSIGNED NOT NULL,
  ts DATETIME(3) NOT NULL,
  actor VARCHAR(200) NOT NULL, action VARCHAR(120) NOT NULL, object VARCHAR(200) NOT NULL, meta MEDIUMTEXT NOT NULL,
  actor_d CHAR(64) NOT NULL, object_d CHAR(64) NOT NULL, meta_d CHAR(64) NOT NULL,
  redacted TINYINT(1) NOT NULL DEFAULT 0,
  prev_hash CHAR(64) NOT NULL, hash CHAR(64) NOT NULL,
  PRIMARY KEY (seq), UNIQUE KEY uq_audit_hash (hash)
) ENGINE=InnoDB;
CREATE TABLE audit_head (id TINYINT NOT NULL PRIMARY KEY, seq BIGINT UNSIGNED NOT NULL, hash CHAR(64) NOT NULL);
```
Append = in one transaction: `SELECT ... FROM audit_head WHERE id=1 FOR UPDATE`, compute the next hash, `INSERT` the row, `UPDATE` the head. This serialises appends (correct for a chain). Expected throughput is far above audit volume; measured in S-253. The application user can `INSERT` into `audit_log` but cannot `UPDATE` or `DELETE`; only the `redacted` flag path (existing erasure behaviour) uses a separate narrow procedure or a controlled account (decided in S-253 against the current redaction design).

## 7. Representative ports (others follow the same rules)
```sql
-- pp_identity
CREATE TABLE persons (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  tier VARCHAR(8) NOT NULL DEFAULT 'T0', role VARCHAR(30) NOT NULL DEFAULT 'resident',
  phone_hash CHAR(64) CHARACTER SET ascii NULL, phone_enc TEXT NULL,
  pin_salt VARCHAR(64) NULL, pin_hash VARCHAR(128) NULL, label VARCHAR(120) NULL,
  failed_pins INT NOT NULL DEFAULT 0, locked_until DATETIME(3) NULL,
  flags JSON NOT NULL, residence_enc TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_persons_phone_hash (phone_hash)
) ENGINE=InnoDB;
CREATE TABLE sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  person_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL,
  KEY ix_sessions_person (person_id), KEY ix_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
) ENGINE=InnoDB;
```
(Column lists are completed from the live `CREATE TABLE` when each store is ported; the real DDL is generated from the existing migrations by the port script of S-250 so nothing is retyped by hand.)

Ordinary conversion for the rest: take each `registerMigration` SQL, apply section 3, add the indexes the existing queries need (found by running the suite with the slow-query log on), and keep names.

## 8. Operations
- **Backups:** automated daily snapshots plus point-in-time recovery (binary logs), per schema restorable independently where the service allows or per instance; targets set in S-273 (proposal: recovery point within 5 minutes, recovery time within 1 hour). Restore is drilled, not assumed.
- **Encryption:** at rest (provider key) and in transit (TLS required for every connection). The existing application-level encryption of phone numbers, residence and keyed pseudonyms **stays**; the database never sees plain values.
- **Secrets and keys:** database passwords and the key provider material come from a secret manager, rotated; never from `.env` in production (S-272).
- **Retention jobs:** deletion by retention date (existing jobs) run as batched deletes with a limit and a sleep, so they never lock a table.
- **Growth:** `rate_events`, `otps`, `audit_log` and `notify_block_log` are the high-volume tables. `rate_events` and `otps` are short-lived (cleaned by job; partition by day if size demands, S-274). `audit_log` is append-only and may be partitioned by range on `seq` later; it is never rewritten.
- **Monitoring:** connections, replication lag, slow query log, lock waits, deadlocks, disk, and per-schema query timing in the metrics (S-267).

## 9. MySQL versus the earlier PostgreSQL note
`docs/DESIGN_2028.md` named PostgreSQL and PostGIS. The owner has chosen MySQL, so this plan uses it. What the app does **not** use today makes the switch cheap: no JSON operators, no partial indexes, no `RETURNING`, no server-side spatial queries (point-in-polygon and distance run in code on GeoJSON). What would have favoured PostgreSQL later, and how it is handled here:
| Possible later need | In MySQL |
|---|---|
| Spatial queries on boundaries | MySQL 8 has spatial types and functions (SRID 4326), good enough; or keep GeoJSON in code |
| Partial and expression indexes | generated columns plus indexes |
| `RETURNING` | a read after write inside the transaction |
| Row-level security | not available; the per-schema users and the API's own scoping replace it |
| Rich JSON queries | `JSON` columns and functions exist; use sparingly |
None of these blocks the plan; if one becomes important the data layer (S-248) is the place that limits the cost of changing.

## 10. What this document does not decide
Provider, instance sizes, exact recovery targets (proposals above), whether `pp_audit` and `pp_identity` get separate instances on day one, and the optional `pp_content` split. These are in S-246, S-272, S-273 and S-274.


## Identity store schema (S-250, built 2026-11-27)
The MySQL schema of the identity store (49 tables) is **generated**, not hand-written: `npm run backend:schema` migrates a fresh SQLite identity store, reads its DDL and translates it (`server/data/schema/translate.ts`) into `server/data/schema/identity.mysql.sql`. `tests/backend/identitySchema.test.ts` fails when that file is stale, and (with MYSQL_TEST_URL) compares the real MySQL tables, columns, nullability, keys and indexes with SQLite.

Rules the translator applies, and why:
- **Collation `utf8mb4_bin` on every table and text column.** SQLite compares text exactly; MySQL 8 defaults to a case- and accent-insensitive collation, which would make ids, hashes and codes that differ only by case collide. The tests check this.
- Text in any key becomes `VARCHAR(190)` (index limit); other text becomes `MEDIUMTEXT`; `INTEGER` becomes `BIGINT`; `AUTOINCREMENT` becomes `AUTO_INCREMENT`. Timestamps that are indexed are `VARCHAR(190)` and the others `MEDIUMTEXT`, all holding the same ISO strings as SQLite (the `VARCHAR(24)` rule above applies to new tables).
- The two partial unique indexes (`WHERE col IS NOT NULL`) become plain unique indexes, because MySQL allows many NULLs in a unique column. Any other partial index, foreign key, trigger or view stops the translation instead of being silently changed.
- CHECK constraints are kept. Text defaults are written as expressions (MySQL requires it for TEXT types).
- **Reserved words:** the column `rate_events.key` is a MySQL reserved word. The DDL quotes every identifier; SQL in code that runs on MySQL must write it with backticks, for example `` `key` ``, when that table is ported.
- A key longer than 190 characters is refused by MySQL; the copy tool reports the table and keeps nothing from it.

This is one baseline for a database that is not live yet. After the cutover (S-256) it is never regenerated: changes become new migrations after it.

**Copying and checking data:** `server/data/copy.ts` (`copyTables`, `verifyTables`) copies rows in batches inside one transaction per table, refuses a target table that already has rows, and compares row counts and an order-independent content digest per table. It is the building block for the cutover (S-256); it does not lock the source.

### How identity code is being ported (S-250)
The legacy code is synchronous and the store is shared by about 32 files, so it moves **module by module**, not all at once:
1. `server/civic/core/asyncBridge.ts` gives an async `Db` over the **same** SQLite connection the legacy code uses (`identityDb()`), so a half-converted store still has one connection and one transaction state. It is SQLite only; the app cannot run identity on MySQL until every module below is converted.
2. Each module gets a repository in `server/data/repos/` that takes a `Db` and uses only portable SQL. Its tests run on SQLite always and on MySQL when `MYSQL_TEST_URL` is set.
3. Callers become async (Express 4 needs `asyncRoute` from `server/data/http.ts` so a rejected promise reaches the error handler instead of hanging the request). Inside a transaction do not await network, disk or timers.
4. The module drops out of `tests/backend/legacy-sync-db-files.json` (the ratchet), so progress is visible and cannot go backwards.

Converted so far: photo submissions (`server/photo-submissions.ts`, 4 routes plus the 2 helpers the public photo routes in `server/geo-api.ts` use) officer applications (`server/civic/officers/index.ts`: all `officer_application` SQL plus the two `role_requests` statements it uses; submit, confirm, resend, list, withdraw, verify and reject are async) government notifications (`server/civic/notify`: all of the service, delivery, routes and the e2e seed hooks are async over `server/data/repos/notify.ts`; the only statement left on the synchronous handle is the account-erasure hook in `notify/schema.ts`, for the same reason as officers) video broadcasts (`server/civic/videocast`: every `vcast_videos` and `vcast_windows` statement is in `server/data/repos/videocast.ts`; the media hub's report takedown awaits the recall) the media hub (`server/civic/mediahub`: sources, news, live channels, clicks, reports, the development preview and the demo news, all in `server/data/repos/mediahub.ts`; the migrations that seed candidate sources stay where they are) and people requests and takedowns (`server/people-api.ts`: the request form, the admin list, resolve and takedown routes, and the takedown check that every people page and photo route makes on each read; `photoGate()` is now async). Two statements in the officers file stay on the synchronous handle on purpose: the account-erasure hook (erasure hooks run inside the caller's synchronous identity transaction, so they move with the core) and a read of the issues store's `admin_unit` count (another store). Rule found on the way: `Db.upsert(..., "none")` cannot tell a new row from a duplicate on MySQL (a no-op update still counts as a hit under found-rows), so code that needs "was it new" does a plain INSERT and treats the `unique` error as a duplicate, as the media hub store does. Next candidates, smallest first: households, admin, then the core (persons, sessions, rate limiter, consents, and the erasure framework), which is used by almost everything and goes last.

Correction: the first version of the generated schema (46 tables) missed three tables registered by modules outside `server/civic` (photo and people tables). The generator now loads those modules, and `identitySchema.test.ts` fails when a table the store registry lists is missing from the schema (`hh_pin` is the one listed table that a later migration drops).
