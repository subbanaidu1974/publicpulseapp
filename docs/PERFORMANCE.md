# Performance: lite page on 2G, OTP flood, count-day reads (S-75, E2E-90)

Measured on the development machine (Windows 11, Node 26, one process, localhost), production bundle (`npm run build`, then `SERVE_BUILT=1 node dist/server.cjs`). Numbers are from real runs on 2026-11-22; they show relative behaviour and the shape of the limits, not absolute capacity of production hardware. Re-run the commands below and replace the tables when the hardware or the code changes. Nothing here was run against anything but localhost.

## 1. `/lite` (the 2G entry page)

`/lite` is its own Vite entry (`lite.html`, `src/lite/`), built beside the full app and served by `server.ts` at `/lite`. It is plain TypeScript with no framework, no map, no third-party request and system fonts; the self-hosted Noto Telugu subset (`/fonts/NotoSansTelugu-subset.woff2`, 107 KB) is requested by script only after Telugu is chosen. A service worker (`/civic-sw.js`) keeps the shell for offline use; reports made offline are queued in `localStorage` and sent when the connection returns (a photo is not queued offline, and the page says so).

### Size (gzip level 9 of the built files)

| Part | Raw | Gzip |
|---|---|---|
| `lite.html` | 0.7 KB | 0.4 KB |
| `lite-*.js` | 16.2 KB | 6.1 KB |
| `lite-*.css` | 2.2 KB | 0.9 KB |
| **First load (HTML+JS+CSS)** | 19.1 KB | **about 7.5 KB** |
| Telugu font (lazy, Telugu only) | 107 KB | 107 KB (already woff2) |
| For comparison: full app first load (`main` JS+CSS, plus `names-te` chunk) | | about 250 KB |

Budget: 150 KB (DESIGN_2028 3.9). `tests/load/lite.size.test.ts` builds `lite.html`, gzips the real output files and fails above 150 KB; it also fails if the output has map code, a React runtime, any absolute third-party URL, or references the font from HTML or CSS (so the font cannot become part of first load by accident). The older `tests/civic/channels.size.test.ts` still guards the in-app civic bundle. The Vite config sets `modulePreload.polyfill = false` so `/lite` does not pay a separate 0.4 KB round trip for the polyfill (every browser that runs `type=module` handles or ignores the hint).

### Time on a simulated 2G connection

Profile: Chromium via CDP `Network.emulateNetworkConditions`: 50 kbit/s down (6,250 B/s), 20 kbit/s up, 300 ms RTT added to every request, HTTP cache disabled, service worker blocked (cold first visit), fresh browser context per run, desktop Chromium on the dev machine. Three runs, median reported (`e2e/lite.spec.ts`, test tagged `@E2E-90 @measure`, `npm run measure:lite` against a server on `PORT`).

| Metric | Median of 3 |
|---|---|
| Bytes on the wire for first load | 10.7 KB (3 requests: HTML, JS, CSS) |
| HTML response end | 0.73 s |
| First contentful paint | 2.7 s |
| Report form visible | 2.9 s |
| **First usable: first keystroke accepted in the description box** | **3.0 s** |
| Telugu font fetched on language switch (108 KB, after the form is already usable) | 17.7 s |

Why the numbers are what they are: 10.7 KB at 6.25 KB/s is 1.7 s of pure transfer, plus about three round trips at 300 ms (HTML, then JS and CSS in parallel, then execution). The Telugu font costs 17.7 s on this link because 108 KB / 6.25 KB/s is 17 s, which is exactly why it is lazy and never blocks the form: Telugu text is shown immediately in the phone's own system Telugu font where one exists, and switches to the subset when it arrives (`font-display: swap`). On a phone with no Telugu system font the first 18 s on 2G show boxes; an open item is to trim the subset further or to preload it only for devices that report no Telugu font (see section 4).

**Pass/fail threshold: first usable form in under 8 s** on this profile. Rationale: the measured median is 3.0 s; 8 s leaves about 2.5x for run-to-run jitter in CI and for a slower CPU than this laptop (the page is 6 KB of gzip script, so CPU is a small part of the 3 s), and it still fails loudly if someone adds even 25 KB gzip (4 s of transfer) to the first load. The size budget (150 KB, which alone would take 25 s on this link) is the upper bound, not the target; the page is at 5 percent of it.

Not measured here (no real device): a real low-end Android, a real 2G radio (loss, bufferbloat, radio wake-up). RELEASE_GATE row 12 still needs a run on a physical low-end phone; this table is the automated part.

Offline: after one visit the shell and assets are cached; `e2e/lite.spec.ts` reloads the page with the network off, submits a report (queued, count shown), restores the network and checks the queue drains. The worker never caches `/api/` or tiles.

## 2. OTP flood (`npm run load:otp`)

`scripts/load/otp-flood.ts` starts a fresh production bundle per phase and floods `POST /api/v1/civic/identity/signup/request` with autocannon (100 connections, 10 s). `-- --smoke` runs a 2 s version (also run by `tests/load/load.smoke.test.ts`). Distinct client addresses use `TRUST_PROXY=1` plus a random `X-Forwarded-For` per request; the edge limiter (`RATE_LIMIT_*`) is raised in every phase except the first so the OTP caps themselves are what is measured.

| Phase | Requests | Codes sent (2xx) | Cap that held | Other responses | p50 / p95 / p99 |
|---|---|---|---|---|---|
| One IP, default edge limiter (120 burst, 20/s) | 222,995 (22k/s) | 10 | 10 per IP per 10 min | 222,985 x 429 | 4.2 / 5.9 / 7.7 ms |
| One IP, OTP caps only | 108,399 (10.8k/s) | 10 | 10 per IP per 10 min | 108,389 x 429 | 8.6 / 13.0 / 20.0 ms |
| Many /24s, a new phone each, SMS budget 200/h | 6,257 (625/s) | 200 | `CIVIC_SMS_HOURLY_BUDGET` | 6,057 x **503** (`degraded: true`) | 169 / 263 / 375 ms |
| One /24, many hosts | 92,292 (9.2k/s) | 60 | 60 per /24 per 10 min | 92,232 x 429 | 10.2 / 14.7 / 18.1 ms |
| One phone, many IPs | 15,738 (1.6k/s) | 3 | 3 per phone per 10 min | 15,735 x 429 | 47.9 / 173 / 251 ms |

Result: every cap held exactly, no connection errors or timeouts, no 5xx other than the documented degraded 503. Even with the budget gone the server keeps answering in under 400 ms p99.

Findings (code under `server/civic/`, not changed here):

1. **The SMS-budget answer is a 503.** `requestOtp` in `server/civic/identity/routes.ts` answers 503 with `degraded: true` when the hourly SMS budget is spent, with no `Retry-After`. The households and enrolment routes answer 429 for the same condition. Under a billing-DoS this is a 5xx storm in monitoring and some clients and CDNs treat 503 as an origin outage; it should be 429 with `Retry-After` (seconds to the top of the budget window), like the other two routes.
2. **OTP-cap 429s carry no `Retry-After`.** The edge limiter's 429 does (verified). The per-IP, per-/24, per-phone and login 429s from `fail()` in the identity router do not, so the lite page cannot tell people how long to wait. Add the header in `fail()` for 429 using the window that tripped.
3. An attacker using many /24s and many phones can exhaust the whole hourly budget and block legitimate sign-ups for the hour (the cap protects the bill, not availability). The per-/24 cap bounds how many addresses it takes; the planned number-intelligence, attestation and per-ASN caps (DESIGN_2028 3.8 item 2) are what reduce this, and a reserved slice of the budget for already-trusted numbers (recovery and login codes) is worth considering.

## 3. Count-day reads (`npm run build && npm run load:count`)

`scripts/load/count-day.ts` starts the production bundle with the edge limiter raised (a real count day sits behind a CDN that fans out client IPs; from one loopback address the default limiter would answer almost everything with 429) and a temp database, checks cache headers, then drives a mix of ten URLs round-robin with `Accept-Encoding: gzip`: election seats+tally and summary for AP and TG, assembly GeoJSON for AP and TG, two constituency pages, `/` and `/lite`. Latency percentiles are exact (every response recorded, not autocannon's bucketed values).

### Cache headers and revalidation (all passed: ETag then conditional GET gives 304)

| URL | Gzip bytes | Cache-Control |
|---|---|---|
| `/api/v1/elections?state=AP&type=assembly` | 51.7 KB | `public, max-age=60` |
| `/api/v1/elections/AP/summary` | 2.5 KB | `public, max-age=60` |
| `/api/v1/geo/AP/ac.geojson` | 306 KB | `public, max-age=3600, must-revalidate` |
| `/api/v1/constituencies/AP/1` | 5.5 KB | `public, max-age=300` |
| `/` | 1.8 KB | `public, max-age=0` (weak ETag) |
| `/lite` | 0.7 KB (under the 1 KB gzip floor) | `no-cache` (weak ETag) |

Hashed files under `/assets/` are served by `express.static` with its default `max-age=0` (revalidate every time); see finding 3.

### Load

| Run | Requests | Rate | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| Mixed, 200 connections, 15 s | 16,474 | 1,093/s | 186 ms | 413 ms | 512 ms | 0, all 200 |
| Mixed, 500 connections, 15 s (stress) | 16,532 | 1,092/s | 1,247 ms | 10.5 s | 13.7 s | 7,134 connection refusals (`ECONNREFUSED`), 0 5xx |

Per endpoint, 100 connections, 5 s (single Node process):

| Endpoint | Rate | p50 | p95 | p99 |
|---|---|---|---|---|
| elections AP seats+tally (52 KB gz) | 829/s | 114 ms | 132 ms | 261 ms |
| elections TG seats+tally | 862/s | 111 ms | 136 ms | 164 ms |
| summary AP (2.5 KB) | 898/s | 105 ms | 150 ms | 194 ms |
| summary TG | 927/s | 105 ms | 135 ms | 175 ms |
| GeoJSON AP assembly (306 KB gz) | 400/s | 236 ms | 311 ms | 328 ms |
| GeoJSON TG assembly (194 KB gz) | 702/s | 132 ms | 154 ms | 354 ms |
| constituency page AP/1 | 1,836/s | 52 ms | 68 ms | 79 ms |
| constituency page TG/10 | 1,832/s | 53 ms | 65 ms | 87 ms |
| app shell `/` | 7,056/s | 13.5 ms | 17.8 ms | 27.3 ms |
| `/lite` | 12,998/s | 7.2 ms | 10.1 ms | 12.3 ms |

Compression cost (same URL, 100 connections, 4 s):

| URL | with `Accept-Encoding: gzip` | identity |
|---|---|---|
| `/api/v1/geo/AP/ac.geojson` | 478/s, p50 196 ms | 4,590/s, p50 19.9 ms |
| `/api/v1/elections?state=AP&type=assembly` | 910/s, p50 105 ms | 1,062/s, p50 95 ms |

### Reading the numbers

One Node process holds 200 concurrent connections of this mix cleanly (p99 0.5 s, zero errors, zero 5xx). At 500 connections the single process saturates at about 1,100 requests/s, queueing delay dominates (p50 1.2 s) and the accept backlog overflows on this Windows host (connection refusals, never 5xx), so the capacity plan is more processes plus the design's pre-rendered, signed, multi-CDN snapshots (DESIGN_2028 3.8 item 6), not one big origin. Static files and the lite shell are cheap (7k to 13k/s); the API is the cost.

### Hotspots found (none are in files owned by this story, so not changed here)

1. **On-the-fly gzip of large static bodies (`compression()` in `server/security.ts`).** GeoJSON throughput drops from 4,590/s to 478/s (about 10x) and p50 from 20 to 196 ms when the client accepts gzip, because every request re-compresses 1 to 2 MB of unchanged bytes on the event loop. `server/geo-api.ts` already caches the file body and ETag per file; it should also cache the gzip (and brotli) bytes next to it and send them with `Content-Encoding`, bypassing the generic middleware. Same for the hashed `/assets/*` (precompress at build time). Expected gain: GeoJSON and assets back to thousands per second.
2. **JSON API reads cost about 1 ms of CPU each even for a 2.5 KB summary.** `elections` and `elections/:state/summary` recompute seat results, tallies and vote shares from the rows on every request (`server/api.ts`), and `readCache()` serialises the body twice (once to hash it for the ETag, again in `res.json`). Memoising the computed payload per (state, year, type) and hashing it once would take these routes towards the constituency-page rate (1.8k/s) or better. The data is static between imports, so the cache key is the dataset version.
3. **Hashed assets are revalidated on every visit.** `express.static` is mounted with defaults, so `/assets/*-<hash>.js|css` get `max-age=0`. They are content-hashed, so `Cache-Control: public, max-age=31536000, immutable` is safe and removes a round trip per asset on every repeat visit, which matters most on 2G. A one-line `setHeaders` in `server.ts`.
4. **Listen backlog.** Node's default backlog (511) overflowed on this host at 500 simultaneous connections (`ECONNREFUSED`, not 5xx). Pass a larger backlog to `app.listen` and set the OS `somaxconn` accordingly in production, or terminate connections at a reverse proxy that queues.
5. `count-day` shows the full single-IP edge limiter answering 429 with `Retry-After` correctly; behind a CDN set `TRUST_PROXY` to the exact hop count or every user shares one bucket.

## 4. Open items

- Run the lite page on a physical low-end Android on a real throttled network (RELEASE_GATE row 12); the automated numbers above are the floor, not the proof.
- If the cold 18 s Telugu font on 2G matters for phones without a system Telugu font, split the subset (letters first, conjuncts later) or ship a smaller one; the form itself does not wait for it.
- Photos are not queued offline (the queue is `localStorage`, text only); moving the queue to IndexedDB would allow it.
- The fixes in section 3 and findings 1 and 2 in section 2 need the owners of `server/security.ts`, `server/api.ts`, `server/geo-api.ts`, `server.ts` and `server/civic/identity/`.

## 5. Reproducing

```
npm run build
npm run load:otp                 # about 1.5 min;  add -- --smoke for 2 s phases
npm run load:count               # about 2 min;    add -- --smoke for a 3 s run
npx vitest run tests/load        # size budget + both smoke runs
SERVE_BUILT=1 CIVIC_EXPOSE_DEV_OTP=1 PORT=4101 RATE_LIMIT_BURST=1000000 RATE_LIMIT_PER_SEC=1000000 node dist/server.cjs
PORT=4101 npx playwright test e2e/lite.spec.ts --project=chromium --workers=1   # includes the 2G measurement
```
