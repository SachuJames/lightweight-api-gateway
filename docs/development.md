# Development

## Prerequisites

- Node.js 24, pnpm 10
- PostgreSQL 16 and Redis 7 running locally

```bash
cp .env.example .env   # adjust if needed; never commit .env
pnpm install
pnpm db:migrate        # create schema
pnpm db:seed           # demo routes, policies, admin@example.local / admin12345678
```

## Daily commands

| Command                                                     | What it does                                             |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                                                  | Gateway with hot reload (`apps/gateway`)                 |
| `pnpm --filter admin-ui dev`                                | Admin UI dev server                                      |
| `pnpm typecheck`                                            | `tsc` across all packages                                |
| `pnpm lint` / `pnpm lint:fix`                               | ESLint                                                   |
| `pnpm format:check` / `pnpm format`                         | Prettier                                                 |
| `pnpm test:unit`                                            | Gateway unit tests (no DB/Redis needed)                  |
| `pnpm test:integration`                                     | Gateway integration tests (needs local Postgres + Redis) |
| `pnpm --filter admin-ui test`                               | Admin UI unit tests                                      |
| `pnpm --filter gateway perf`                                | Performance benchmarks; rewrites `docs/performance.md`   |
| `pnpm tls:generate`                                         | Self-signed localhost certs for TLS dev                  |
| `pnpm docker:build` / `pnpm docker:up` / `pnpm docker:down` | Compose stack                                            |

Integration tests create their own databases (`gateway_test_*`) via
`tests/integration/setup.ts`, so they never touch your dev database.

## Repository layout

```
apps/gateway/          # the gateway service (Fastify + TypeScript)
  src/                 # server, proxy, routing, auth, rate-limit, circuit-breaker,
                       # config-service, reload, plugins, metrics, audit, admin API, db/*
  migrations/          # node-pg-migrate migrations (001–005)
  tests/unit/          # pure unit tests
  tests/integration/   # DB + Redis backed tests, incl. e2e.test.ts
  tests/perf/          # benchmarks (pnpm --filter gateway perf)
apps/admin/            # React 19 + Vite admin SPA
packages/shared-types/ # types shared by gateway and admin UI
examples/upstreams/    # zero-dependency demo upstream services
docker/                # Dockerfiles (gateway, admin, upstreams)
scripts/               # generate-dev-certs.sh, demo.sh
docs/                  # this folder
```

## Database

Migrations are plain JS run by `node-pg-migrate`:

- `001-pgcrypto` — `pgcrypto` extension
- `002-users` — `users` (id, email, password_hash, role)
- `003-policies` — `rate_limit_policies`, `circuit_breaker_policies`
- `004-routes` — `routes` (pattern, methods, upstream, policy refs, timeouts…)
- `005-audit-config` — `audit_log`, `config_versions`

`db:reset` drops and recreates everything (dev only).

## Conventions

- TypeScript strict; ESM (`"type": "module"`); `.js` import suffixes in
  `apps/gateway/src`.
- Gateway imports `@gateway/shared-types` as **types only** — nothing from it
  is needed at runtime.
- Every command in the README is verified working; if you add one, run it.
- Commit messages are short, human, and specific. Push to `origin/master`
  after each commit.
- Never log secrets, tokens, or authorization headers.
