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
