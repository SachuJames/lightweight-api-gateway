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

## Phase 12 — observability

- `apps/gateway/src/metrics.ts`: bounded in-memory metrics — labeled
  counters, latency ring buffers with p50/p95/p99, series cap with oldest
  eviction (cardinality explosions degrade instead of OOMing). Well-known
  series names for the pipeline. Prometheus exposition out of scope for v1
  (documented).
- `apps/gateway/src/health.ts`: unconditional liveness; readiness aggregating
  DB + Redis checks (503 when degraded) with config version and uptime.
- Tests: 7 unit (counters, quantiles, bounds, reset, liveness, readiness
  ok/degraded); total unit 94.

## Phase 13 — audit trail service

- `apps/gateway/src/audit-service.ts`: `AuditService.record()` with a fixed
  action vocabulary (`route.create/update/delete`, policy CRUD, `user.*`,
  `auth.login`), actor + request id context, before/after payloads. Backed by
  the append-only `audit_logs` table from Phase 5.
- Tests: 2 unit (field mapping, optional-field handling); total unit 96.

## Phase 14 — admin API

- `apps/gateway/src/admin.ts`: full REST admin API — login, route CRUD,
  rate-limit/circuit policy CRUD, user management (admin-only, no self-delete),
  audit log query, config version + reload trigger, metrics snapshot. RBAC:
  viewer read-only, operator read + reload, admin full. Mutations are
  transactional (write + version bump + audit) and publish a reload
  notification afterwards. Zod validation errors -> 400 with issue details;
  unknown policy refs -> 422; referenced policy delete -> 409. JSON 404s.
- `apps/gateway/src/db/policies.ts`: policy CRUD repositories. Fixed a real
  bug found by tests: `RETURNING (cols)` returns one composite column;
  changed to `RETURNING cols`.
- `packages/shared-types`: `ErrorBody` gains optional `details`;
  `GatewayError` accepts details.
- Tests: 12 integration (auth, RBAC, route validation, policy ref guard,
  audit trail, reload notification over pub/sub, users); totals unit 96,
  integration 31.

## Phase 15 — gateway server + request pipeline + SSE

- `apps/gateway/src/server.ts`: `buildServer()` wiring the full pipeline —
  health (`/health`, `/ready`), admin API, SSE analytics stream
  (`/api/analytics/stream`, 2s snapshots, operator+), and the catch-all
  gateway handler: route match -> auth -> plugin onRequest -> rate limit ->
  circuit breaker `canRequest` -> proxy -> plugin onResponse/onError.
  Metrics recorded per request; request ids validated/generated.
- `apps/gateway/src/index.ts`: real entrypoint — env config, Postgres pool,
  Redis x3, auto-migrate off unless `GATEWAY_AUTO_MIGRATE=1`, `ConfigReloader`
  (pub/sub + 15s poll), `PLUGIN_DIR` loading, graceful shutdown.
- Fixed a real ordering bug found by the circuit-breaker test: the breaker
  outcome was recorded after `proxyRequest` resolved, but that only happens
  after `dispatcher.close()` in the `finally`, so the record landed after the
  response was delivered and the next request's `canRequest` saw stale state.
  Fix: `onSettled` now fires before dispatcher teardown, and the breaker
  record moved into `onSettled`, so state is visible to the next admitted
  request. Same ordering now covers the metrics hook.
- Tests: 11 integration (proxy pipeline, auth, rate limit, circuit breaker
  open/half-open, plugin hooks, SSE, health); totals unit 96, integration 42.

## Tooling — lint/format now enforced

- `pnpm lint` was broken since Phase 1 (`typescript-eslint` imported by
  eslint.config.js but never installed); installed it as a dev dependency.
- Fixed all strictTypeChecked errors in `src/` (unnecessary assertions,
  deprecated zod `.email()`/`.uuid()` -> `z.email()`/`z.uuid()`, unsafe `any`
  handling in db mappers and auth, `void` in plugin hook union ->
  `| undefined`, `require-await`, `no-console` left as warnings in the
  entrypoint) and mechanical test issues. Test files get a relaxed override
  (`no-unsafe-*`, `require-await` off: test fakes and `res.json()` any
  boundaries are idiomatic); `**/fixtures/**` and `**/migrations/**` ignored;
  config files use `disableTypeChecked`.
- `pnpm lint` (eslint .) and `tsc` typecheck are clean; `prettier --check`
  clean for all source/test files (12 pre-existing config files like
  package.json use single-line JSON style and remain as-is).

## Phase 16 — React admin UI

- Full SPA in `apps/admin/src`: typed API client (`api/client.ts`), session
  auth context (JWT in `Authorization` header, token in tab-scoped
  sessionStorage), fetch-streaming SSE hook, pure analytics aggregation lib,
  layout + pages: login, dashboard, routes, route detail, route create/edit
  form, rate-limit/circuit-breaker policy management, circuit breaker states,
  audit log (filters + pagination), system status (readiness, config version,
  reload trigger), settings (session info, user management for admins).
- Route create/update forms show "Configuration updated" with the new config
  version returned by the API (backend: POST/PUT /api/routes now include
  `version` in the response).
- Backend fix found while building the UI: `MetricNames` listed series names
  that the pipeline never recorded; aligned to the real names. Added the
  missing `gateway.rate_limited`, `gateway.circuit_rejected`,
  `gateway.auth_failures` counters (spec-required metrics that previously only
  existed as status-labeled `gateway.requests`), and wired
  `gateway.config_reloads{result}` through the reloader's onReload/onError
  hooks in `index.ts`.
- Tests: 7 new vitest tests for the analytics aggregation lib (all pass).
  Totals: 96 gateway unit + 42 gateway integration + 7 admin unit = 145.
- Verified: admin `tsc`, `vite build`, `vitest` clean; gateway `tsc`,
  unit + integration suites clean; repo-wide `eslint` and `prettier --check`
  clean (added `.prettierignore` for the lockfile; one-time normalization of
  pre-existing unformatted JSON files).

## Phase 17 — real-time analytics via SSE

- Backend `/api/analytics/stream` (operator+) already existed from Phase 15;
  the dashboard now consumes it live: stat cards (total requests, req/s from
  snapshot deltas, error rate, avg/blended-p95 latency, rate-limited, circuit
  rejections, auth failures, upstream errors), top-routes table, open-circuit
  alerts. Circuit-breaker and system-status pages also stream live state.
- Auth over fetch() streaming (not EventSource): EventSource cannot send an
  Authorization header, and query-string tokens leak into logs/history, so the
  hook uses fetch + ReadableStream with the JWT in the header and manual
  exponential-backoff reconnect. Documented in `docs/security.md`.
- Every number on the dashboard comes from the live metrics snapshot; empty
  states say so explicitly instead of showing zeros as data.

## Phase 18 — TLS

- `scripts/generate-dev-certs.sh` creates a self-signed cert for localhost
  (SAN: DNS localhost/gateway, IP 127.0.0.1) in `.local/certs/`; dev-only, the
  script says so.
- `index.ts` reads `TLS_CERT_PATH`/`TLS_KEY_PATH` when `TLS_ENABLED=true`,
  passes key/cert into the Fastify instance (`server.ts` accepts a `tls` dep),
  and starts an optional plain-HTTP listener that 301-redirects everything to
  the HTTPS port when `HTTPS_REDIRECT=true`. Both are closed on shutdown.
- Verified live: HTTPS on :8443 (`/health`, `/ready` ok), 301 redirect from
  the HTTP listener, admin login + route creation + a proxied request to a
  throwaway upstream all over TLS, SSE analytics stream over TLS, cert
  details via openssl s_client.
- Real bug found by the TLS test: the SSE endpoint used `requireRole('operator')`,
  which locked out admins. Fixed properly with a role hierarchy in `auth.ts`:
  viewer < operator < admin, so `requireRole('operator')` admits operators and
  admins. Added 6 unit tests; now 102 unit + 42 integration, all passing.

## Phase 20 — example upstream services

- `examples/upstreams/{users,orders,slow,failing}/server.js`: zero-dependency
  Node http servers, each with `GET /health`, listening on `PORT`
  (3001-3004 by default, matching the seeded gateway routes' ports).
  users/orders are small in-memory CRUD-ish APIs; slow honors `?delay=` ms
  (timeout testing); failing returns 500 for everything but /health
  (circuit-breaker testing).
- `examples/upstreams/README.md` documents how to run them and how they map
  to the seeded routes (seed uses Compose hostnames; for local runs point the
  routes at 127.0.0.1 or add /etc/hosts entries).
- Verified live: all four /health endpoints, users list, slow delay timing
  (600ms), failing returning 500.

## Phase 19 — Docker

- `docker/gateway/Dockerfile`: multi-stage (node:24-alpine). Builder installs
  the pnpm workspace, compiles the gateway, and `pnpm deploy`s a prod-only
  bundle; runner is a non-root `gateway` user with a `/health` HEALTHCHECK.
  `docker/gateway/entrypoint.sh` runs migrations, optionally seeds
  (`SEED_ON_START`), then starts the gateway. Notable: the gateway imports
  `@gateway/shared-types` as types only, so the runtime bundle needs no
  compiled shared package.
- `docker/admin/Dockerfile` + `docker/admin/nginx.conf`: builds the Vite SPA
  (`VITE_API_BASE_URL` as a build arg) and serves it via nginx with SPA
  fallback, a `/health` probe, and immutable caching for hashed assets.
- `docker/upstreams/Dockerfile`: one parameterized Dockerfile for the four
  example upstreams (`SERVICE` build arg), non-root `upstream` user,
  `/health` HEALTHCHECK.
- `docker-compose.yml`: postgres 16 + redis 7 (both with healthchecks and
  persistent volumes), gateway (waits for healthy deps, migrates + seeds on
  start), admin UI on :3000, and the four upstreams on :3001-3004. Service
  names match the seeded route upstream hostnames. Dev-only secrets are
  labeled as such in comments.
- Root scripts: `docker:build`, `docker:up`, `docker:down`.
- Honest limitation: no container runtime in this environment, so the images
  were NOT built or run here; `docker compose config` validates the file and
  the compose comments say so.

## Phase 21 — end-to-end tests

- `apps/gateway/tests/integration/e2e.test.ts`: full gateway instances built
  with `buildServer` (not stubs), real upstream HTTP servers on ephemeral
  ports, and a real `ConfigReloader` per instance, exactly like production.
- The 11-step zero-downtime route reconfiguration test: traffic flows,
  version baseline, admin repoints upstream (version bumps), the instance
  picks it up with no restart, a 30-request burst mid-swap all succeed
  (served by old or new upstream, zero 5xx), disable 404s while a control
  route keeps serving, re-enable restores traffic, delete 404s, every
  mutation advanced the config version, and the audit log records the
  updates and the delete.
- Two-instance convergence test: a route created through instance A's admin
  API is served by instance B after the Redis notification; an update through
  B converges back onto A; both report the same config version.
- 16 new tests, all passing. Totals: 102 unit + 58 integration = 160 gateway
  tests, plus 7 admin UI tests.
