# Capacity and load run (internal self-assessment, not independent)

Date: 2026-11-24. One developer machine (Intel Core Ultra 9 275HX, 24 logical CPUs, Node 26.13.1, Windows 11), localhost, production bundle (`npm run build`; the harness starts `dist/server.cjs`), dev stand-ins, with other agents' processes running on the same machine, so numbers are noisy. Scripts: `scripts/load/otp-flood.ts`, `count-day.ts`, `countday.ts` with `--smoke` (small scale, a few seconds per phase), plus an inline scrypt micro-benchmark (not committed). This does not replace gate row 7 (target hardware, real SMS provider, human review) or row 12.

## OTP flood (`otp-flood --smoke`), all phases PASS (two runs)

| Phase | Cap under test | Requests (2 s) | Codes sent | Result |
|---|---|---|---|---|
| one IP, default limits | 10 per IP per 10 min | 44k to 61k | 10 | 429 with Retry-After 600, no 5xx |
| one IP, OTP caps only | 10 per IP per 10 min | 17k to 21k | 10 | held |
| many /24s, SMS budget 25 | 25 per hour | 39k to 47k | 25 | rest degraded 503, no other 5xx |
| one /24, many hosts | 60 per /24 | about 15k | 60 | held |
| one phone, many IPs | 3 per phone | about 3.3k | 3 | held |

p50 0.6 to 12 ms, p99 1.4 to 36 ms, zero errors or timeouts.

## Count-day reads (`count-day --smoke`): PASS

30 connections, 4,569 requests in 3.0 s (1,518/s), p50 17.5 ms, p95 39.6 ms, p99 49.9 ms, all 200. All ten paths gzip (except the 698-byte /lite), ETag and 304 on conditional GET. Largest payload: AP assembly GeoJSON 306 KB.

## Count-day snapshots (`countday --smoke`): PASS

30 connections, 27,392 requests in 4.0 s (6,831/s), p50 4.3 ms, p95 7.9 ms, p99 10.9 ms, no errors.

## PIN hashing (the documented bottleneck)

scrypt N=16384: 27.4 ms per hash synchronously. Async: 37 hashes/s with 1 in flight, 135/s with 4, 134/s with 8 (threadpool of 4). Consistent with `docs/CAPACITY.md` (29 ms; 33 to 105/s).

## Limits

Smoke scale only; full runs (minutes) were skipped. One process, loopback, temp or in-memory databases, synthetic snapshot data. Caps are shown to hold; capacity on a small VM (3 to 6 times slower per `docs/CAPACITY.md`) was not measured.
