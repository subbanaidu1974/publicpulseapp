# API design

Design only. The baseline is the 347 routes in [ROUTE_INVENTORY.md](ROUTE_INVENTORY.md); this document says which rules apply to them, how the screens use them, and what must be added.

## 1. Principles
1. **Stable first.** The front end is built on today's routes. Existing paths, methods and response fields do not change in `/api/v1`. A breaking change means `/api/v2` for that route group only, with `v1` kept for an announced period.
2. **Additive changes only inside a version:** new optional fields, new routes, new query parameters.
3. **Privacy rules are part of the contract.** A route that returns counts hides small ones (the existing minimum cell rules); a route that returns a person-linked record needs the caller to be that person or hold a scoped role; no route returns another person's identifier. The contract test checks the documented response shape, and the privacy tests stay as they are.
4. **One error shape**, one auth scheme, one way to page, one way to retry. See section 3.

## 2. Surfaces
| Surface | Mount | Audience | Auth |
|---|---|---|---|
| Public data | `/api/v1/...` (elections, constituencies, geo, people, history, analytics, count day) | anyone, including the lite page | none; cached |
| Civic | `/api/v1/civic/...` | signed-in members, volunteers, officers, admins | bearer session token, roles |
| Operations | `/healthz`, `/readyz`, `/metrics`, `/api/v1/degraded` | load balancer, monitoring | network-restricted |
| Webhooks | `/api/v1/civic/channels/sms-receipt` and any added provider callbacks | providers | HMAC signature, no session |
| Dev only | `/api/v1/civic/demo`, `/api/v1/civic/e2e` | developers, tests | refused in production |

## 3. Conventions (target; existing routes are brought in line when touched, story S-265)
**Versioning.** Path prefix `/api/v1`. Response header `X-API-Version`. Deprecations carry `Deprecation` and `Sunset` headers.

**Authentication.** `Authorization: Bearer <session token>`; tokens are opaque, server-side sessions (existing). Admin actions additionally need a fresh second factor (existing). No credentials in query strings.

**Authorisation.** Every route declares one of `public`, `member`, `role:<name>[+scope]`, `admin`, `admin+mfa`, `webhook`. The declaration is data (a table in code, exported into the contract), and a test fails if a mounted route has none (S-263).

**Errors.** One JSON shape, already used by most routes:
```json
{ "error": "same_person", "code": "same_person", "message": "a different admin must switch a source on", "request_id": "..." }
```
HTTP status: 400 invalid input, 401 not signed in, 403 not allowed, 404 not found (also used to hide existence), 409 conflict or rule violation, 413 too large, 422 only when input is well-formed but semantically refused, 429 rate limited with `Retry-After`, 5xx server. `request_id` matches the log line.

**Paging.** Lists that can grow use cursors, not offsets: `GET /x?limit=50&cursor=<opaque>` returns `{ items, next_cursor }` (`next_cursor` is `null` at the end). `limit` default 50, maximum 200. Order is fixed and documented per route. Small fixed lists (categories, parties) stay unpaged.

**Idempotency.** Writes a client may retry (report an issue, "me too", submit a survey answer, report a media item, finish an upload) accept `Idempotency-Key` (a UUID, kept 24 hours). The same key and body returns the first result; a different body with the same key is 422. Existing one-per-person rules (for example one report per person per item) stay and remain the real guard.

**Caching.** Public GETs set `ETag` and `Cache-Control` (versioned snapshots `immutable`, listings `max-age` with `stale-while-revalidate`). Civic GETs are `no-store`. `If-None-Match` is honoured.

**Rate limits.** Per-IP and per-session buckets, returned in `RateLimit-*` headers; stricter on sign-in, codes and uploads (existing limits are kept; story S-264 moves the counters to a shared store).

**Time and ids.** Times are ISO 8601 UTC with `Z`. Ids are opaque strings (UUID today); clients never parse them.

**Language.** `Accept-Language: te|en` or `?lang=`; text fields come with `_en` and `_te` pairs as today.

**Files.** Never sent through JSON. Uploads use the two-step flow in section 6; downloads are by CDN URL (public) or by an authorised API stream (private).

## 4. Screen to API map (current UI)
| Screen or tab | What it shows | Main routes (see the inventory for the full list) | Notes for the backend |
|---|---|---|---|
| Home, Elections, Analytics | results, summaries, swing, marginal seats, forecast, turnout, compare, parties | `GET /elections`, `/elections/:state/summary`, `/swing`, `/marginal`, `/forecast`, `/turnout`, `/analytics/*`, `/history/*` | pure reads; cache hard; data version in the ETag |
| Map | constituency, district, mandal boundaries, village points, polling stations | `GET /geo/:state/*.geojson`, `/geo/:state/search`, `/village-points`, `/polling-stations`, basemap | large static files: CDN, `immutable`, gzip or brotli |
| Constituencies | profile, members, contestants, party history | `GET /constituencies/:state/:acNo`, `/members/*`, `/contestants`, `/history/constituency/*` | reads |
| People and parties | parties, office holders, takedown and correction requests | `GET /parties`, `/office-holders`, `POST /people/requests` | request routes are rate limited and audited |
| Civic: sign up and sign in | phone or email code, PIN, sessions, residence, households, volunteer enrolment | `/civic/identity/*`, `/civic/households/*` | identity store; strict limits; no enumeration |
| Civic: report an issue, my reports | feed, categories, create, me too, confirm, appeal, media upload | `/civic/issues/*`, `POST /civic/issues/media` | issues store only holds pseudonyms; media goes to object storage (S-258) |
| Civic: surveys | registry, credential, respond, results | `/civic/surveys/*`, `/civic/broadcast/*` | survey store; no person id with an answer |
| Civic: consultations | list, read, comment, results | `/civic/consultations/*` | content; audio files in object storage |
| Civic: officer and representative screens | applications, replies, moderation | `/civic/officers/*`, `/civic/representatives/*`, `/civic/issues/moderation/*` | role scoped |
| Civic: admin consoles | publish a survey, send a notification, approve a video, media sources and reports, audit, break-glass | `/civic/broadcast/*`, `/civic/notify/*`, `/civic/videocast/admin/*`, `/civic/media/admin/*`, `/civic/admin/*` | two-person rules and MFA; every action audited |
| Media: News | headlines from approved sources | `GET /civic/media/news` | v2 pages by cursor and carries an ETag (S-270) |
| Media: Watch | own videos, YouTube news videos, library | `GET /civic/videocast`, `GET /civic/media/news` | v2 adds `GET /media/videos` with renditions (S-270) |
| Media: Live | channels, health | `GET /civic/media/live` | unchanged |
| Media: From us | approved broadcast videos, corrections | `GET /civic/videocast` | unchanged |
| Pulse surveys | published figures, method | `/civic/surveys/*/results` | counts hidden under the minimum |
| Methodology, FAQ, Privacy, Terms | static text | `GET /data-status`, `/data-freshness` | |

## 5. Gaps found by walking the UI (new or changed work)
| # | Gap | Change | Story |
|---|---|---|---|
| 1 | Videos can only be a link to a file on an approved host | add upload and transcoding (see MEDIA_STORAGE.md) with `POST /media/uploads`, `POST /media/uploads/:id/complete` | S-258, S-260, S-269 |
| 2 | Citizen photos and consultation audio are files on one disk | store in object storage with a metadata row | S-258, S-259 |
| 3 | News and video lists return everything | cursor paging and `ETag` | S-270 |
| 4 | No published API contract | OpenAPI from the inventory, contract tests | S-247 |
| 5 | Mixed error and paging styles in older routes | bring in line when a route is touched | S-265 |
| 6 | Rate limit and session state live in one SQLite file | shared store | S-264 |
| 7 | Background work (feed reading, retention purge, notification sending) assumes one process | locks and an outbox for several servers | S-266 |
| 8 | Public JSON is served by the app | CDN in front, versioned URLs | S-268, S-261 |
| 9 | No `/readyz` that checks the database and the object store | add checks | S-267 |
| 10 | Admin lists (reports, audit entries, sources) are unpaged | cursor paging | S-265 |

## 6. New endpoints for media (summary; full shapes in `openapi.yaml`)
Uploads are two steps so large files never pass through the app server:

1. `POST /api/v1/civic/media/uploads` with `{ purpose, filename, content_type, size_bytes, sha256 }` returns `{ upload_id, method, url, headers, expires_at }` (a short-lived presigned URL; multipart for large files returns part URLs).
2. The client sends the file straight to object storage.
3. `POST /api/v1/civic/media/uploads/:id/complete` verifies size and hash, queues the scan and processing, and returns `{ media_id, state: "processing" }`.
4. `GET /api/v1/civic/media/:id` returns `{ state, variants, poster, duration }`; the client polls or the admin screen refreshes.

`purpose` is one of `issue_photo`, `consultation_audio`, `video`, `video_poster`, `source_logo`. Each purpose has its own size cap, allowed types, who may upload, scanning and retention (a table in MEDIA_STORAGE.md). A citizen photo is not readable by anyone until the scan passes and the person's own re-encoded copy is stored.

Reading: public media (library videos, posters, public photos) by CDN URL; private media (citizen photos, audio) by `GET /civic/media/:id/content`, which checks who is asking, then streams (or redirects to a very short-lived signed URL when the object is not application-encrypted).

## 7. Compatibility of existing routes with the move
No existing route changes shape because of MySQL. The things that can change are performance and a few edge behaviours, all listed with their fixes in DATA_MODEL_MYSQL.md section 3 and proven by the same test suite running on both engines (S-248, S-271).
