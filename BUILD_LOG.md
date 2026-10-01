# Build Log — Lightweight API Gateway

Decisions, per-phase results, test counts, and measured numbers.
Nothing here is aspirational: every claim below was observed.

## Structural decisions

- Monorepo with pnpm workspaces. Gateway internals live in `apps/gateway/src/<module>`
  rather than one npm package per module: fewer build boundaries, same testability.
  Only genuinely cross-app code (`@gateway/shared-types`) is a separate package.
- No hash chain on audit records: the spec marks it optional, and append-only +
  restricted DB role + no application-level mutation path already gives the
  integrity property. Added crypto would be decoration.
- Circuit breaker state is per gateway instance (in-memory), documented in
  `docs/circuit-breaker.md`. Not distributed: sharing it via Redis would add
  coordination cost for little benefit at this scale.
- Metrics are in-memory bounded structures streamed over SSE. Postgres is not a
  traffic log: only audit records persist.
- Proxy via `undici` (request streaming), not an external reverse proxy.
- Password hashing with `bcryptjs` (pure JS): avoids native build failures in
  minimal Docker images; cost factor 12 keeps local login latency acceptable.

## Phase 1 — workspace and skeletons

- pnpm workspace, strict TS base config, ESLint (strictTypeChecked), Prettier.
- `apps/gateway`: Fastify v5 skeleton with /health.
- `apps/admin`: Vite + React + TS skeleton.
- `packages/shared-types`: shared DTO types.
- Verified: `pnpm install` clean, gateway `tsc` build clean, admin `vite build` clean.

## Phase 2 — configuration subsystem

- `apps/gateway/src/config.ts`: zod-validated env parsing, typed `GatewayConfig`,
  production refuses dev JWT secret / short secrets / dev admin password,
  `describeConfig()` exposes only non-secret diagnostics.
- Tests: 7 unit tests pass (defaults, CSV parsing, invalid port, missing values,
  production secret refusal, secret redaction in diagnostics).

## Phase 3 — reverse proxy engine

- `apps/gateway/src/proxy.ts`: undici-based streaming reverse proxy. Forwards
  method/path/query/headers/body both directions without buffering; strips
  hop-by-hop headers (including `Connection`-listed tokens); validates or
  generates `X-Request-ID`; appends `X-Forwarded-For`; enforces body size via a
  byte-counting stream transform (413); per-request total timeout via
  `AbortSignal.timeout`; connect timeout via undici Agent. Errors map to stable
  codes: 504 UPSTREAM_TIMEOUT, 503 UPSTREAM_UNAVAILABLE, 502 UPSTREAM_ERROR,
  404 ROUTE_NOT_FOUND, 413 PAYLOAD_TOO_LARGE.
- Learned: Fastify v5 `addContentTypeParser('*', ...)` does NOT override the
  built-in JSON/text parsers, so the plugin replaces those explicitly in its
  encapsulated context to keep raw body streams readable.
- Tests: 13 proxy tests pass (GET/POST, headers, query, body streaming,
  status passthrough, timeout, refused, oversized, 404, concurrency) against a
  real local upstream. Total unit: 20 passed.

## Phase 4 — routing engine

- `apps/gateway/src/routing.ts`: pattern compiler (`:param`, trailing `/*`,
  static segments) with deterministic ordering: priority, then specificity
  (static > param > wildcard), then pattern length, then route id. Path
  forwarding strips the static prefix (`/api/users/*` + `/api/users/123` ->
  `/123`); query strings preserved; trailing slashes tolerated. Zod input
  schema validates name/pattern/methods/upstream/timeout/policies; upstream
  must be http(s). Bare `/` is not a valid pattern (use `/*`).
- Tests: 28 pass (matching, params, stripping, query, priority, specificity,
  determinism, validation rejections).

## Phase 5 — PostgreSQL persistence

- `apps/gateway/migrations/001..005`: pgcrypto, users, rate-limit and
  circuit-breaker policy tables, routes, audit_logs, config_versions.
  `src/scripts/migrate.ts` (up/down/reset; reset refuses production);
  `src/scripts/seed.ts` (admin user, 2 rate-limit policies, 1 circuit policy,
  4 sample routes, config v1; idempotent; refuses production and short
  admin passwords).
- `src/db.ts` (pool, `withTransaction`, health check), `src/db/routes.ts`
  (CRUD with version bump on update), `src/db/users.ts`, `src/db/audit.ts`
  (append-only + filtered list), `src/db/config-versions.ts` (monotonic
  version counter). All queries parameterized.
- Also fixed: added `"type": "module"` to gateway package.json (was missing,
  breaking `node dist/...` ESM output); migrate/seed scripts read DATABASE_URL
  directly instead of the full config.
- Tests: 9 integration tests pass against a fresh `gateway_test` DB
  (CRUD, ordering, rollback, audit, version bump, users).

## Phase 6 — configuration snapshots

- `apps/gateway/src/config-service.ts`: `loadSnapshot()` reads routes +
  policies + current version from Postgres and compiles patterns once;
  `ConfigStore` holds the active immutable snapshot and swaps it with a single
  assignment on `refresh()` (atomic in Node's single thread, so the hot path
  never sees a half-loaded config). `CompiledRoute` is now exported.
- Tests: 2 unit tests (snapshot load from a stub client, atomic swap
  semantics); total unit 50 pass.

## Phase 7 — JWT auth and RBAC

- `apps/gateway/src/auth.ts`: bcrypt password hashing, HS256 JWTs via jose
  (`sub`/`email`/`role`, configurable TTL), `authenticateUser` (constant-time
  safe bcrypt compare, generic 401 message), `extractBearerToken`,
  Fastify `onRequest` hook attaching `request.authUser` (public paths:
  `/health`, `/ready`, `/api/auth/login`), `requireAuth` and
  `requireRole(...)` pre-handlers. Errors use stable codes
  `AUTHENTICATION_ERROR` / `AUTHORIZATION_ERROR`.
- Tests: 12 pass (hash/verify, token round-trip, wrong-secret, expiry,
  garbage token, bearer parsing, login success/failure); total unit 62.

## Phase 8 — Redis and rate limiting

- `apps/gateway/src/redis.ts`: ioredis client factory (lazy connect,
  background retries), `checkRedis` health check. Note: ioredis v6 exports a
  named `Redis` class, not a default export.
- `apps/gateway/src/rate-limit.ts`: atomic token-bucket in Lua
  (shared across instances), key strategies `ip` / `user` / `route_ip` /
  `route_user` (matching shared-types), fail-open returns a `degraded` result,
  fail-closed throws `REDIS_ERROR` 503, misconfigured policy throws
  `CONFIGURATION_ERROR`.
- Tests: 5 unit (key resolution) + 7 integration against real Redis
  (capacity/deny, refill, bucket isolation, fail-open, fail-closed,
  misconfigured policy); totals: unit 67, integration 16.

## Phase 9 — circuit breaker

- `apps/gateway/src/circuit-breaker.ts`: per-instance in-memory breaker
  (documented trade-off: no cross-instance consensus needed to protect an
  upstream, no Redis round trip per request). Rolling-window failure counting,
  open/half-open/closed transitions, concurrent probe limiting, timeout
  counting toggle, breaker reset when the policy id changes, per-route
  isolation.
- Tests: 10 unit with an injectable clock; total unit 77.

## Phase 10 — zero-downtime reconfiguration

- `apps/gateway/src/reload.ts`: `notifyConfigChange()` publishes
  `{version}` on `gateway:config:reload`; `ConfigReloader` subscribes per
  instance, refreshes + atomically swaps the snapshot only when behind,
  ignores malformed/stale messages, and polls the DB version every 15s as a
  backstop for missed messages. In-flight requests finish on the old snapshot;
  new requests see the new one.
- Tests: 3 integration (two instances converge on one notification, stale +
  malformed ignored, poll backstop catches a missed message); total
  integration 19.

## Phase 11 — plugin system

- `apps/gateway/src/plugins.ts`: framework-free plugin API with `onRequest`
  (mutable headers, short-circuit responses), `onResponse`, `onError` hooks.
  `PluginManager`: registration with validation + duplicate rejection, ordered
  execution, per-route enable/disable via `route.pluginConfig`, per-plugin
  options in context, hook error isolation (a throwing plugin never breaks the
  pipeline), directory loading of `.js` modules with per-file failure reports.
  Ships an example `add-header` plugin factory.
- Tests: 10 unit (ordering, short-circuit, error isolation, per-route
  disable, options passing, directory loading incl. broken fixtures);
  total unit 87.
