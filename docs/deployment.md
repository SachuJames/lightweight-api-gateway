# Deployment

## Docker Compose (recommended for demos)

```bash
docker compose up --build
```

This starts PostgreSQL 16, Redis 7, the gateway (:8080), the admin UI
(:3000), and the four example upstreams (:3001–:3004). The gateway runs
migrations and seeds the demo routes + admin user on first start
(`SEED_ON_START=true`). Sign in at http://localhost:3000 with
`admin@example.local` / `admin12345678`.

```bash
docker compose down        # stop
docker compose down -v     # stop and delete volumes (database included)
```

Service names (`users-service`, `orders-service`, …) match the seeded route
upstream hostnames, so the demo routes work out of the box. Images are
multi-stage and run as non-root users. See `docker/` for the Dockerfiles.

> Note: the images were validated with `docker compose config` but not
> built/run in this repo's dev environment (no container runtime there).

## Manual deployment

1. Provision PostgreSQL 16 and Redis 7.
2. Build: `pnpm install` then `pnpm --filter gateway build` and
   `pnpm --filter admin-ui build`.
3. Run migrations: `DATABASE_URL=... pnpm --filter gateway db:migrate`.
4. Seed (first time): `DATABASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=<strong> pnpm --filter gateway db:seed`.
5. Start: `DATABASE_URL=... REDIS_URL=... JWT_SECRET=<strong> node apps/gateway/dist/index.js`.
6. Serve `apps/admin/dist` from any static host with SPA fallback
   (`/*` → `/index.html`), built with `VITE_API_BASE_URL` pointing at the gateway.

## Production checklist

- [ ] `JWT_SECRET`: long random value, unique per environment.
- [ ] `DATABASE_URL` / `REDIS_URL`: managed instances, not the compose defaults.
- [ ] `ADMIN_PASSWORD`: strong; rotate the seeded default immediately.
- [ ] `TRUSTED_PROXIES`: set to your load balancer's CIDRs so rate-limit keys
      and audit IPs are correct; never trust the open internet.
- [ ] `SSRF_DEV_ALLOWLIST`: empty.
- [ ] `RATE_LIMIT_FAIL_OPEN`: decide explicitly (`false` fails closed when
      Redis is down).
- [ ] TLS: terminate at the load balancer, or `TLS_ENABLED=true` with a real
      certificate (not the dev script's).
- [ ] `LOG_PRETTY=false`, `LOG_LEVEL=info` (or `warn`).
- [ ] `CORS_ALLOWED_ORIGINS`: set to your admin UI origin if it is cross-origin.
- [ ] Run at least 2 gateway instances; Postgres and Redis HA per your platform.

## Health checks

- Liveness: `GET /health` → `{"status":"ok"}`
- Readiness: `GET /ready` → checks database + redis, reports `ok`/`degraded`,
  the config version, and uptime. Load balancers should use `/ready`.
