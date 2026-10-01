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
