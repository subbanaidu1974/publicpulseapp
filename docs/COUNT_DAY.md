# Count day: signed static snapshots (S-41, E2E-50)

Implements DESIGN_2028 3.7 and 3.8 item 6. **No source is verified.** No ECI, CEO or results site is scraped: their terms and robots are unverified and scraping is not authorised (GAP_AUDIT). The ingest is built around a pluggable `ResultsSource`.

## Sources (all unverified or synthetic)

| id | kind | status |
|---|---|---|
| `synthetic-fixture` | fixture | SYNTHETIC generator for tests and demos. Batches carry `synthetic: true`; refused in production unless `COUNTDAY_ALLOW_SYNTHETIC=1`. |
| `file-drop` | file-drop | An operator places a licensed or official feed file (schema below). Rights to the file are the operator's. |
| `tcpd-delayed` | tcpd-delayed | Existing TCPD/in-rolls snapshot: DELAYED fallback, post-count only (`COUNTDAY_FALLBACK_NOT_BEFORE`), declared seats only, NC licence (licences.json). |
| `http-feed` | http | Stub with config, **no default URL** (`COUNTDAY_HTTP_URL`), https only (loopback http allowed), neutral JSON schema. |

### Neutral feed schema (`FeedBatch`, pipeline/countday/types.ts)

JSON: `{schema:1, sourceId, sourceKind, synthetic, state, electionType, year, asOf (ISO), acs:[{acNo, acName, status: not_started|counting|declared, round, totalRounds|null, validVotes|null, candidates:[{candidate, party, votes}], correction: {reason}|null}]}`. Votes are cumulative after `round`.

CSV (one row per candidate per seat): `state,election_type,year,ac_no,ac_name,round,total_rounds,status,candidate,party,votes,valid_votes,as_of,source_id,correction_reason`. The newest `feed-*.json|csv` (lexicographic) in the drop directory wins.

## Pipeline

`scripts/countday-ingest.ts` (own process, isolated from the web server): fetch, validate against the last published state, hold anomalies, write files into `COUNTDAY_DIR` (default `data/generated/countday`):

```
keys.json  <ST>/index.json  <ST>/latest.json  <ST>/status.json
<ST>/snapshots/<seq>.json   (immutable, exclusive write)    <ST>/ac/<n>.json   (latest per seat)
<ST>/review/pending.json (ingest-owned)  review/decisions.json (server-owned)   never published
```

Each file is an envelope `{body, sha256, signature:{alg:"ed25519", keyId, value}}`. `sha256` is over the canonical JSON of `body` (sorted keys, no whitespace); the signature is over the 64-character hex string as UTF-8. A snapshot body has `seq`, `asOf`, `sourceId`, `sourceKind`, `delayLabel` (live | delayed-fallback | synthetic), `prevHash` (sha256 of the previous snapshot), `acHashes`, per-seat views and EN/TE `notice`. Per-seat files carry `snapshotSeq`, `snapshotSha256`, `acSha256` and `links`. `index.json` lists every snapshot with its hash and `prevHash` and is itself signed (head signed). Seat labels: `won` only for `status: declared`; a partial count is `leading` or `tied`.

## Signing and verification

Purpose `countday-signing` in KeyProvider (`server/civic/providers/keys.ts`). KeyProvider is symmetric, so an Ed25519 pair is derived from `hmac("countday-signing", "ed25519-seed:v1")` (`server/countday/signer.ts`). **Limitation:** anyone able to call hmac on that purpose can derive the private key; a production HSM should implement the `Signer` interface directly. Rotation changes the key id; old public keys stay in `keys.json`. `GET /api/v1/countday/keys` serves them. Pin the key id out of band; `keys.json` is a convenience, not a trust anchor.

`npx tsx scripts/countday-verify.ts <dir|https://mirror> [more mirrors] [--state AP,TG] [--pin cd-...]` checks hashes, signatures, the chain, index head against `latest.json`, per-seat files and the manifest, and compares mirrors (lower head = rollback or lag, same seq with another hash = fork). A single mirror cannot prove it is not rolled back: compare at least two, or keep a `minSeq`.

## Validation and review

Rejected and never publishable (cannot be approved; the feed must be corrected): vote sum above valid votes, a round or any candidate's votes going down without a flagged `correction` with a reason, votes on a seat not started, declared with no votes, bad schema.
Anomalies, withheld until **two different admins** approve (`requireRole("admin")` + audit): correction, declared before the last round, status regress, declared seat changed, candidate added or removed. The last approved figures stay public with `underReview: true`; `summary.underReview` counts them. Endpoints: `GET /:state/review`, `POST /:state/review/:id/approve|reject` (one reject blocks). Approved items are applied on the next ingest tick.

## Serving

`/api/v1/countday/keys`, `/:state/latest` (adds an unsigned `live` block, `max-age=5`), `/:state/index`, `/:state/snapshots/:seq` (`public, max-age=31536000, immutable`), `/:state/ac/:acNo`. All carry ETag and answer 304.

Degraded behaviour (`live.state`): `live`; `stale` when no source update for `COUNTDAY_STALE_MINUTES` (default 10) with `delayed_minutes` and an EN/TE banner; `source-down` after 3 failed polls; `delayed-fallback` when the snapshot came from the archive; `synthetic`. Stale data is never served as plain live. Static mirrors have no server: clients must compute `now - body.asOf` themselves (CountDayPage shows the server banner; mirror clients must apply the same rule).

`COUNT_DAY_ACTIVE=1` makes `forecastDecision` return hidden (`reason: "count-day"`) and the forecast route answers with a notice EN/TE and no projection.

Links: each per-seat body has `links` (Form 20, affidavit, results portal) taken only from `data/reference/countday-sources.json`; all `verified: false`. No PDFs are copied.

## Multi-origin publishing

```
npx tsx scripts/countday-ingest.ts --state AP --source file-drop --path /drop --loop 30
npx tsx scripts/countday-publish.ts --out /tmp/countday-out      # copies the tree (never review/), writes a signed manifest.json
# upload /tmp/countday-out unchanged to every origin (CDN bucket A, bucket B, university mirror); snapshots/*: cache 1 year immutable; latest/index/ac: 5 s
npx tsx scripts/countday-verify.ts https://a.example/countday https://b.example/countday --pin <keyId>
```

Upload order: snapshot, ac files, index, then latest.

## Load test

`npm run load:countday [-- --smoke]` seeds a temp tree of SYNTHETIC snapshots and drives the production bundle (latest, numbered snapshot, per-seat, keys). Measured on a developer laptop, one Node process, localhost: 200 connections p95 115 ms, 500 connections p95 228 ms (p99 268 ms), about 3,900 requests per second, zero errors. This is not a capacity claim for count day: the design serves the static tree from CDNs.

## Not done

Real-feed adapters (no source verified), HSM Ed25519 signer, external witnessing of the index head, booth-wise Form 20 data (outbound links only), automatic `COUNT_DAY_ACTIVE` toggling, TE copy review, Playwright run on the production bundle.
