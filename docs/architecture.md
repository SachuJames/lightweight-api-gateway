# Architecture

The gateway is a single Node.js/TypeScript service (Fastify) that reverse-proxies
HTTP traffic according to routes stored in PostgreSQL. Configuration is versioned,
cached in memory per instance, and reloaded without restarts.

## Components

```
                    ┌─────────────────────────────────────────────┐
                    │                  Gateway                     │
                    │                                            │
 clients ──────────▶│  route matching → auth → plugins →          │
                    │  rate limit → circuit breaker → proxy      │
                    │                                            │
                    │  admin API (/api/...)  SSE (/api/analytics) │
                    └──────┬──────────────────────────┬──────────┘
                           │                          │
                    ┌──────▼──────┐            ┌──────▼──────┐
                    │  PostgreSQL │            │    Redis    │
                    │ routes,     │            │ Lua token   │
                    │ policies,   │            │ buckets,    │
                    │ users,      │            │ reload      │
                    │ versions,   │            │ pub/sub,    │
                    │ audit log   │            │ login guard │
                    └─────────────┘            └─────────────┘
```

- **PostgreSQL** is the source of truth: routes, rate-limit and circuit-breaker
  policies, users, config versions, and the audit log. See `docs/development.md`
  for the migration layout.
- **Redis** does three jobs: the Lua token-bucket rate limiter (shared across
  instances), the `gateway:config:reload` pub/sub channel, and login-attempt
  throttling for the admin API.
- Each gateway instance keeps a **compiled in-memory snapshot** of the config
  (`ConfigStore`): routes compiled to regexes once per version, policies in
  maps. The request path never touches the database.

## Request pipeline

Every proxied request goes through these stages in order:

1. **Route matching** — the compiled route table is scanned (priority, then
   specificity). No match → `404 ROUTE_NOT_FOUND`.
2. **Authentication** — if the route requires auth, a JWT bearer token is
   verified; missing/invalid → `401`. (`gateway.auth_failures` counts these.)
3. **Plugins** — `onRequest` hooks run in registration order and may mutate
   headers or short-circuit with a response.
4. **Rate limiting** — one Redis Lua `EVAL` per request against the route's
   token-bucket policy. Over the limit → `429` with `retry-after`.
5. **Circuit breaker** — per-route breaker consulted before proxying; open
   breaker → `503 CIRCUIT_OPEN` without touching the upstream.
6. **Proxy** — the request is streamed to the upstream (path prefix stripped
   by default), honoring connect/response timeouts. The outcome (status,
   latency, timeout) is fed back to the breaker and the metrics registry.
   `onResponse`/`onError` plugin hooks run around this.

Metrics (`gateway.requests`, `gateway.request.duration`, `gateway.upstream`,
`gateway.rate_limited`, `gateway.circuit_rejected`, `gateway.auth_failures`,
`gateway.config_reloads`) are recorded in a bounded in-memory registry and
exposed to the admin UI via `/api/metrics` and the SSE stream.

## Zero-downtime reconfiguration

Config changes (admin API or direct DB writes) bump `config_versions` and
publish `{version}` on Redis pub/sub. Every instance's `ConfigReloader`:

- refreshes from Postgres and **atomically swaps** the snapshot only when its
  version is behind,
- ignores stale or malformed messages,
- polls the DB version every 15s as a backstop for missed messages.

In-flight requests finish on the old snapshot; new requests see the new one.
No restarts, no dropped connections. Two instances always converge on the
latest version; there is no leader election and no consensus protocol.

## Multi-instance behavior

Instances are stateless and share nothing except Postgres and Redis:

- Rate-limit buckets live in Redis, so limits hold across instances.
- Circuit breakers are **per instance** (documented trade-off): an unhealthy
  upstream trips each instance's breaker independently, with no cross-instance
  coordination and no Redis round trip per request.
- Config reloads converge via pub/sub; see above.

## Admin UI

A React/Vite single-page app (`apps/admin`) talks to the same gateway process
over `/api/...` with JWT bearer auth. It polls nothing: the dashboard,
circuit-breaker list, and system status consume the SSE analytics stream.
See `docs/admin-ui.md`.
