# Backend roadmap

Design only; implementation starts when the owner says so. Sizes are relative effort (S about a few days, M about one to two weeks, L about three to six weeks for one developer), not promises. Dates are deliberately absent: they depend on who is assigned and on the owner decisions in S-246 and S-257.

## 1. Where we are (measured 2026-11-26)
| Fact | Value | Why it matters |
|---|---|---|
| Routes | 347 in 17 groups (see ROUTE_INVENTORY.md) | The contract the front end already uses |
| Tables | about 116 in four SQLite stores: identity, issues, survey, audit | The privacy split must survive |
| Database access | `node:sqlite`, synchronous; about 59 files call `prepare`, about 188 call `getDb()` | Moving to MySQL means async code in all of them |
| SQLite-only SQL | about 28 `INSERT OR IGNORE`, 14 `INSERT OR REPLACE`, 15 `ON CONFLICT`, 7 `PRAGMA`, 6 `WITHOUT ROWID`, 8 `AUTOINCREMENT`, 4 `BEGIN IMMEDIATE`, 1 `strftime`; no `RETURNING`, no JSON functions | Small and finite: it can be rewritten by rule |
| Files | citizen photos and consultation audio are AES-GCM encrypted files in `data/civic-media` and `data/photo-submissions`; public photos in `public/`; election data as JSON and GeoJSON in `data/generated` (48 MB) and raw sources in `data/raw` (1.4 GB) | Need an object store; raw data is an archive, not served |
| Deployment | one replica (docs/DEPLOYMENT.md) | The reason for the move |
| Media tab | news, live and reports tables exist; videos are links to files on approved hosts (no upload) | Upload and transcoding are new work |

## 2. The shape of the work
```
B0 Decide and prepare        S-246 decisions        S-247 API contract
                             S-248 async data layer S-249 MySQL migration runner
        |
B1 Move the data to MySQL    S-250 identity  S-251 issues  S-252 survey  S-253 audit
                             S-254 content and ops tables   S-255 public datasets
                             S-256 cutover (one-time copy, verification, rollback)
        |
B2 Images and videos         S-257 provider  S-258 media service  S-259 move old files
(can start after B0)         S-260 video pipeline  S-261 CDN  S-262 lifecycle
        |
B3 API hardening             S-263 authorisation table   S-264 rate limits  S-265 paging, idempotency, errors
                             S-266 jobs and outbox  S-267 observability  S-268 read performance
                             S-269 media admin API v2  S-270 public media API v2
        |
B4 Quality and production    S-271 tests on MySQL  S-272 security  S-273 backup and DR
                             S-274 capacity  S-275 deployment  S-276 runbooks  S-277 readiness review
```

### Order and dependencies
- **S-246 first.** Without a provider, region and budget nothing can be provisioned.
- **S-248 before every port story (S-250 to S-254).** The data layer is what lets one test suite run on both engines while stores are converted one at a time.
- **S-249 before S-250.** Ordered, checksummed migrations and a MySQL in CI must exist before the first table is ported.
- **Port order:** audit (S-253, smallest and most self-contained) as the pilot of the method, then survey (S-252), issues (S-251), identity (S-250, the largest and most connected), then the content and ops tables (S-254).
- **S-256 (cutover) needs S-250 to S-255 and S-271.** It is the only story that touches real data; it is rehearsed on a copy first.
- **Media (B2) is independent of the data port** once S-246 and S-257 are decided. S-258 needs S-248 (it writes metadata rows). S-259 needs S-258 and S-251.
- **S-260 (video upload and transcoding) is optional for the first release.** Links to files on approved hosts keep working; upload is added when the owner wants it.
- **B3 and B4 run alongside B1 and B2** where they do not depend on them; S-277 is the last.

## 3. Phase exit criteria ("done" means all of these)
**B0.** Decision record signed (S-246). OpenAPI contract covers every route in the inventory and a contract test fails when a route changes without the contract (S-247). The same repository test suite passes on the SQLite adapter and on a MySQL started in CI (S-248, S-249).

**B1.** Every table is in MySQL under the right schema, in the same store as today, with a test that fails when a table lands in the wrong one (the existing placement test, extended). No statement joins across schemas. The full vitest and Playwright suites pass against MySQL. A one-time copy from SQLite to MySQL reproduces every row count and a per-table checksum, and a rollback was rehearsed (S-256).

**B2.** No citizen photo, audio file or video is kept on an application server's disk. Every object has a metadata row, a retention date and a purge path; deleting a person or taking down an item removes the object. Uploads are checked (type, size, scan) before they are readable.

**B3.** Every route has an entry in the authorisation table and a test proves a route without one cannot be mounted. List routes that grow (feed, news, videos, reports, audit entries) page by cursor. A write that can be retried (report, vote, upload completion) accepts an idempotency key.

**B4.** Backup restore was timed in a drill and meets the agreed recovery targets. A load test hit the agreed numbers. A least-privilege database user exists per store. A rolling deploy and a rollback were rehearsed. The readiness review (S-277) is signed.

## 4. Risks and how the plan treats them
| Risk | Why | Treatment |
|---|---|---|
| **Sync to async rewrite is large** | about 188 call sites assume a synchronous database | S-248 gives a layer first; convert one store at a time behind the same tests; a lint rule forbids new direct `node:sqlite` use |
| **Privacy split is lost by accident** | MySQL makes cross-schema joins easy | one database user per schema with no grant on the others; the existing test that rejects a cross-store statement is kept and runs on MySQL |
| **Subtle behaviour differences** | `changes` vs MySQL affected rows, transaction isolation, case rules, time formats | DATA_MODEL_MYSQL.md section 3 lists each rule; the shared test suite is the safety net |
| **Audit hash chain needs strict order** | many writers on many servers | one chain head row locked for each append (or a single writer queue); measured in S-253 |
| **Data copy mistakes** | one-time migration of live data | row counts and checksums per table, two rehearsals, a read-only window, a tested rollback |
| **Media cost surprise** | video egress is the large line | caps, alerts and a cost line before upload is opened to anyone (S-261, S-233) |
| **Vendor lock-in** | provider-specific services | S3-compatible API only, plain MySQL features only, containers; the design names no provider-only feature as required |
| **Owner decisions late** | S-246 and S-257 block provisioning | they are the first stories and are listed in README.md |

## 5. What each phase gives the user of the app
- **B0:** nothing visible. It is what makes the rest safe.
- **B1:** the app can run on more than one server and survive a machine loss; response times under load stop depending on one file.
- **B2:** photos and videos are backed up and served quickly; video upload and playback at several qualities if wanted.
- **B3:** long lists load in pages; retries do not double-count; slow or abusive use is limited fairly; the same data is cached where it is public.
- **B4:** an operations team can run it, restore it and explain it.

## 6. What is not in this roadmap
A front-end rewrite; new product features (they use the stable API afterwards); changing consent, retention or privacy rules (counsel's); the operating entity and vendor contracts (S-169 to S-181 are separate and still blocked on the owner).
