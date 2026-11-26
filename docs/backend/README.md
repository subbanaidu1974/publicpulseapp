# Backend plan: MySQL, object storage and a stable API

Status: **design only. Nothing here is implemented, and nothing will be started until the owner says "start the backend".** Written 2026-11-26.

## Why this plan exists
The app already has a working server (Express and TypeScript, about 347 routes, about 116 tables). It runs on four **SQLite** files and keeps photos as encrypted files on local disk. That is right for a single-machine pilot and wrong for production: SQLite is single-writer, the server cannot run as more than one copy, and files on one disk cannot be backed up, replicated or served at scale. The owner has asked for MySQL for data and a proper home for images and videos. This plan turns that into stories that can be picked up one by one.

## What is in this folder
| File | What it answers |
|---|---|
| [BACKEND_ROADMAP.md](BACKEND_ROADMAP.md) | What gets built, in what order, what blocks what, what "done" means for each phase, and the risks |
| [API_DESIGN.md](API_DESIGN.md) | The API rules (versions, errors, paging, auth, caching), which screen calls which endpoint, and the new endpoints needed |
| [ROUTE_INVENTORY.md](ROUTE_INVENTORY.md) | Every route that exists today, generated from the code (the baseline that must keep working) |
| [DATA_MODEL_MYSQL.md](DATA_MODEL_MYSQL.md) | How the four SQLite stores become MySQL schemas, type and SQL rules, key tables as DDL, backups, security |
| [MEDIA_STORAGE.md](MEDIA_STORAGE.md) | Where images and videos live, the options compared, the recommendation, the metadata tables and the upload flow |
| [openapi.yaml](openapi.yaml) | A machine-readable contract for the shared rules and the new media endpoints (the rest is generated from the inventory in story S-247) |

Stories S-246 to S-277 in `docs/stories/tracker.json` (epic **Backend**, waves B0 to B4) carry the work.

## The decisions in one page
Each is a **proposal for the owner to accept or change**; the first two are already the owner's.

1. **Database: MySQL 8.4 LTS (InnoDB, utf8mb4).** Owner's choice. This replaces the earlier note in `docs/DESIGN_2028.md` that named PostgreSQL and PostGIS; the trade-offs are written down in DATA_MODEL_MYSQL.md section 9.
2. **Images and videos do not go in MySQL.** They go in S3-compatible object storage; MySQL keeps only a row per object (key, size, hash, state, retention). Reasons are in MEDIA_STORAGE.md.
3. **Keep the four-store privacy split.** Identity, issues, survey and audit stay separate (separate MySQL schemas, separate database users, no cross-schema statement). The split is a privacy control, not a performance choice, and it must survive the move.
4. **Keep Node, TypeScript and Express.** The work is changing what is under the routes, not rewriting them. No new framework.
5. **Move to an async data layer first.** `node:sqlite` is synchronous and MySQL is not; about 188 call sites change. A thin layer that can talk to both engines lets the same test suite run on SQLite (fast, local) and MySQL (real) while the code is converted store by store.
6. **Keep the API shape stable.** Existing routes keep working (the front end is already built on them). New rules (cursor paging, idempotency keys, a published contract) apply to new and touched routes.
7. **Public election data stays as versioned files** (served from object storage through a CDN); only query-heavy history is loaded into MySQL. Measured in S-256 before deciding more.
8. **Hosting: managed MySQL in an Indian region.** Provider is open (owner decision, S-246). The design does not depend on one provider.

## What the owner needs to decide before the first story starts
See story S-246 (decision record) and S-257 (object storage provider). In short: the cloud provider and region, managed or self-run MySQL, a monthly budget ceiling, whether a Redis cache is acceptable (otherwise rate limiting stays in MySQL), and whether video upload (not just links) is wanted in the first release.

## What is not planned
Rewriting the front end; changing the privacy design; moving to microservices; GraphQL; a different language or framework; storing images or videos as database blobs; building our own video player or CDN.
