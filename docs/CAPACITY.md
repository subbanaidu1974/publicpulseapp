# Capacity and the path to Postgres/PostGIS (S-73, E2E-88)

Numbers below were measured on a developer machine (Intel Core Ultra 9 275HX, 24 logical CPUs, Node 26, node:sqlite, in-memory DB,
NODE_ENV=test). Treat them as a ceiling for one process on fast hardware; a small VM is typically 3 to 6 times slower. Re-measure on the
target box before sizing (the bench is a 30-line script around `hashPinAsync`, `audit`, `rateAllow`, `createSession`).

## What limits a single process

| Operation | Measured | Notes |
|---|---|---|
| scrypt (N=16384, r=8, p=1), one hash | 29 ms CPU | cost per login, sign-up, recovery, PIN change, activation |
| async scrypt, 1 at a time | 33 hashes/s | |
| async scrypt, 4 in flight (default threadpool) | 105 hashes/s | 8 in flight gives the same: the libuv pool has 4 threads |
| audit append (hash chain, one transaction each) | ~42,000 /s | in memory; a file DB in WAL mode is typically 2k to 8k /s with `synchronous=NORMAL` |
| rate-limit check + insert | ~68,000 /s | |
| session create | ~73,000 /s | |

So **PIN hashing is the bottleneck**: about 100 logins/s per process on this CPU, roughly 6M logins per day if perfectly spread, which is
far more than the expected peak (morning sign-in bursts). Sync scrypt would block the event loop for 29 ms per login (every other request
waits); the async version moves that to the threadpool. `tests/civic/identity.hardening.test.ts` proves the loop stays responsive while 20
hashes run.

Tuning knobs:

- `CIVIC_SCRYPT_CONCURRENCY` (default 4): hashes allowed in flight. Keep it at or below `UV_THREADPOOL_SIZE` (default 4) so file and DNS
  work sharing that pool is not starved. On a bigger box set `UV_THREADPOOL_SIZE=8` and the concurrency to 6.
- Stored format is unchanged (hex salt + hex scrypt, N=16384 r=8 p=1), so sync and async hashes interoperate.
- Abuse limits protect the pool: per-source login limit (`CIVIC_LOGIN_SOURCE_LIMIT`, 10 per 15 min), per-phone ceiling
  (`CIVIC_LOGIN_PHONE_CEILING`, 100 per 15 min, new sources only), per-IP limit, and the shared SMS budget (`CIVIC_SMS_HOURLY_BUDGET`).

## Scaling beyond one process

1. **Vertical first.** One process with the async pool does ~100 logins/s; the rest of the API (reads) is cheap. Raise `UV_THREADPOOL_SIZE`.
2. **Horizontal blockers in the current design** (all SQLite-local state):
   - the database files themselves (the four stores derived from `CIVIC_DB`, `docs/STORES.md`), each written by one process only;
   - rate limits (`rate_events`), OTP rows, lockout counters and sessions live in that DB, so two app instances would each see their own;
   - the audit chain assumes a single writer (`seq` is read-then-insert inside one transaction).
3. **Postgres/PostGIS migration path.**
   1. Keep the `DatabaseSync` surface behind `getDb()`; introduce a thin async data layer with the same SQL (`?` becomes `$n`). The schema is
      portable: the only SQLite-specific bits are `INSERT OR REPLACE/IGNORE` (use `ON CONFLICT`), `json_extract/json_each` (use `jsonb`),
      `randomblob/hex` and `PRAGMA`s in migrations. The migration runner already records ids and checksums (`migrations` table).
   2. Move PostGIS-shaped data (villages, constituencies, `residence_unit`) to `geometry` columns and replace the in-process geo lookups
      with `ST_Contains`; indexes: GiST on boundaries, btree on `phone_hash`, `(key, ts)` on rate events.
   3. Rate limits, OTPs, lockouts: move to Redis (or Postgres with `UNLOGGED` tables) with the same keys; `rateAllow`, `consumeOtp` and
      `loginSourceAllow` are the only call sites.
   4. Audit chain: serialise appends with `pg_advisory_xact_lock(<audit>)` (or a single writer service) and keep the HTTP witness anchor
      (`CIVIC_ANCHOR_URL`), which already lives outside the database.
   5. Sessions: keep keyed token hashes; add an index on `person_id`; they are already per-row and need no sticky routing once stored in Postgres.
   6. Cut-over: dual-write behind a flag, backfill with `VACUUM INTO` snapshots (`backupDbTo`), verify with `verifyAuditChain()` on both sides,
      then switch reads.
4. **When to move**: sustained > 60 logins/s, > 2,000 audit writes/s, DB file > ~20 GB, or the need for a second app instance for availability.
