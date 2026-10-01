# Performance

> Measured on this machine on 2026-10-01. Your numbers will differ;
> treat these as order-of-magnitude guidance, not guarantees.

## Environment

- Node v24.20.0 (x64)
- CPU: 2x Intel(R) Xeon(R) Platinum 8321HC CPU @ 1.40GHz
- Memory: 7.8GB total, 0.4GB free at run time
- Postgres 16 and Redis 7 on localhost (same host as the gateway)
- Gateway and a trivial `node:http` upstream on 127.0.0.1; real TCP, no mocks
- 300 warmup requests before each network benchmark; benchmarks run sequentially

## Results

### Proxy overhead (sequential requests)

2,000 sequential GETs direct to the upstream vs 2,000 through the gateway
(routing + proxy + metrics + audit-sampling pipeline):

- Gateway: p50 3.94ms, p95 7.49ms, p99 16.72ms
- direct p50=2.04ms p95=4.24ms | gateway p50=3.94ms p95=7.49ms | overhead p50=1.90ms

The overhead is the gateway pipeline itself: route matching, building the
upstream request, streaming the response back, and recording metrics.

### Route matching

- 1,182 matches/sec over 2000 routes (20000/20000 hits)
- Cost per match: ~845.8us

Routes are compiled to regexes once per config version; matching is a linear
scan over the compiled list ordered by priority/specificity, so cost grows
with route count (a typical tens-of-routes table matches in tens of
microseconds).

### Rate limiting (Redis Lua token bucket)

- 4,395 checks/sec (Redis Lua, localhost)
- Per-check latency: p50 172.3us, p95 419.0us, p99 967.9us

The limiter is Redis-only by design (one Lua `EVAL` per request): every
gateway instance shares the same buckets, which is what makes limits hold
under multi-instance deployments. There is no in-memory limiter to compare
against; localhost Redis round-trip dominates the per-check cost.

### Config reload

Time from `bumpVersion` + Redis publish to the instance serving the new
config (10 iterations):

- avg 13.21ms, p50 8.13ms, p95 56.58ms, p99 56.58ms

Reloads swap the compiled snapshot atomically; in-flight requests finish on
the old snapshot. A 15s DB poll backstops missed pub/sub messages.

### 100 concurrent clients

- 4000 requests, 100 concurrent clients, 259 req/s, 0 errors
- Latency: p50 350.35ms, p95 583.54ms, p99 806.12ms

No failed requests; the gateway streams upstream responses without
buffering whole bodies.

## How to reproduce

```bash
pnpm --filter gateway perf   # runs apps/gateway/tests/perf and rewrites this file
```
