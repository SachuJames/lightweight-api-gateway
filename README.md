# Lightweight API Gateway

A production-style API gateway in TypeScript: reverse proxy, routing engine,
JWT auth with RBAC, Redis token-bucket rate limiting, per-route circuit
breakers, a plugin system, versioned zero-downtime config reloads, and a
React admin UI with live traffic analytics. PostgreSQL for config, Redis for
coordination. MIT licensed.

## Features

- **Reverse proxy** — streams requests/responses without buffering whole
  bodies; per-route connect/response timeouts; path prefix stripping.
- **Routing engine** — `:param` segments and trailing `/*` wildcards, method
  matching, priority then specificity wins; routes compile to regexes once per
  config version.
- **Auth & RBAC** — JWT bearer tokens, bcrypt passwords, hierarchical roles
  (`viewer` < `operator` < `admin`), per-route `authRequired`, throttled admin
  logins.
- **Rate limiting** — Redis Lua token bucket shared across instances;
  `ip` / `user` / `route_ip` / `route_user` key strategies; fail-open or
  fail-closed when Redis is down.
- **Circuit breakers** — per-route, per-instance breakers with rolling-window
  failure counting, open/half-open/closed states, and probe limiting.
- **Plugins** — framework-free `onRequest` / `onResponse` / `onError` hooks,
  per-route options, directory loading; a throwing plugin never breaks the
  pipeline.
- **Zero-downtime reconfiguration** — every change bumps a config version and
  publishes on Redis pub/sub; instances atomically swap snapshots, in-flight
  requests finish on the old one. A 15s DB poll backstops missed messages.
- **Audit trail** — every admin mutation recorded with actor, before/after.
- **Admin UI** — React SPA: live dashboard (SSE), routes, policies, breakers,
  audit log, system status, user management.
- **TLS** — optional HTTPS serving plus HTTP→HTTPS redirect; dev cert script
  included.
- **Docker** — multi-stage images and a compose stack (gateway, admin UI,
  Postgres, Redis, 4 example upstreams).
- **Hardening** — SSRF protection on upstream URLs, body/header caps,
  trusted-proxy config, structured JSON logs, no secrets in logs.

## Quickstart

Prerequisites: Node 24, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
cp .env.example .env          # dev-only defaults; never commit .env
pnpm db:migrate
pnpm db:seed                  # demo routes + admin@example.local / admin12345678
pnpm dev                      # gateway on :8080
```

In another terminal, start a demo upstream and the admin UI:

```bash
node examples/upstreams/users/server.js        # :3001
pnpm --filter admin-ui dev                     # :5173
```

Try it (the seeded `users` route proxies `/api/users/*` without auth):

```bash
curl localhost:8080/health
curl localhost:8080/api/users/1          # 404 until the upstream hostname resolves;
                                         # point the route at 127.0.0.1:3001 or use compose
```

Or run the whole stack with Docker:

```bash
docker compose up --build
# admin UI at http://localhost:3000, gateway at http://localhost:8080
```

Sign in with `admin@example.local` / `admin12345678`, create a route pointing at
`http://users-service:3001`, and watch traffic on the dashboard.

## Documentation

- `docs/architecture.md` — components, request pipeline, reload design
- `docs/configuration.md` — every environment variable
- `docs/api.md` — admin REST API reference (incl. SSE stream)
- `docs/admin-ui.md` — using the dashboard
- `docs/security.md` — auth, SSRF, hardening, known limitations
- `docs/deployment.md` — compose, manual deploys, production checklist
- `docs/development.md` — setup, tests, repo layout, conventions
- `docs/plugins.md` — writing and loading plugins
- `docs/performance.md` — measured benchmarks and how to reproduce them

## Commands

| Command                                                     | Purpose                                             |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `pnpm dev`                                                  | Run the gateway (watch mode)                        |
| `pnpm build`                                                | Build all packages                                  |
| `pnpm typecheck`                                            | TypeScript across the repo                          |
| `pnpm lint` / `pnpm format:check`                           | ESLint / Prettier                                   |
| `pnpm test:unit`                                            | 131 gateway unit tests                              |
| `pnpm test:integration`                                     | 58 integration + e2e tests (needs Postgres + Redis) |
| `pnpm --filter admin-ui test`                               | 7 admin UI tests                                    |
| `pnpm --filter gateway perf`                                | Benchmarks; rewrites `docs/performance.md`          |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset`        | Database lifecycle                                  |
| `pnpm tls:generate`                                         | Self-signed localhost certs (dev only)              |
| `pnpm docker:build` / `pnpm docker:up` / `pnpm docker:down` | Compose stack (needs a container runtime)           |

## Project structure

```
apps/gateway/          # gateway service
apps/admin/            # React admin SPA
packages/shared-types/ # shared TypeScript types
examples/upstreams/    # demo upstream services (users, orders, slow, failing)
docker/                # Dockerfiles
scripts/               # dev certs, demo script
docs/                  # documentation
```

## Tests

196 tests total (131 unit, 58 integration/e2e, 7 admin UI), all passing,
plus 5 benchmarks. The e2e suite covers the headline guarantee: an 11-step
zero-downtime route reconfiguration (traffic migrates across an upstream swap
with zero failed requests, disable/re-enable/delete all take effect without
restarts) and two gateway instances converging on config changes via Redis
pub/sub.

## License

MIT. See `LICENSE`.
