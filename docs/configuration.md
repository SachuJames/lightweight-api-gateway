# Configuration

All gateway configuration is via environment variables, validated at startup
by a zod schema (`apps/gateway/src/config.ts`). Invalid values fail fast with
a message naming the variable. Copy `.env.example` to `.env` for local work;
never commit `.env`.

## Reference

| Variable                       | Default                   | Description                                                                          |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------ |
| `NODE_ENV`                     | `development`             | `development` / `test` / `production`                                                |
| `PORT`                         | `8080`                    | Port the gateway listens on (plain HTTP, or HTTPS when `TLS_ENABLED=true`)           |
| `HTTPS_PORT`                   | `8443`                    | Port used in `https://` URLs built by the HTTP→HTTPS redirect                        |
| `TLS_ENABLED`                  | `false`                   | Serve HTTPS using `TLS_CERT_PATH`/`TLS_KEY_PATH`                                     |
| `TLS_CERT_PATH`                | `.local/certs/server.crt` | PEM certificate chain                                                                |
| `TLS_KEY_PATH`                 | `.local/certs/server.key` | PEM private key                                                                      |
| `HTTPS_REDIRECT`               | `false`                   | Also listen on plain HTTP :8080 and 301-redirect everything to `HTTPS_PORT`          |
| `DATABASE_URL`                 | — (required)              | PostgreSQL connection string                                                         |
| `REDIS_URL`                    | `redis://localhost:6379`  | Redis connection string                                                              |
| `JWT_SECRET`                   | — (required)              | HMAC secret for admin JWTs (≥32 chars recommended)                                   |
| `JWT_EXPIRES_IN`               | `15m`                     | Token lifetime (`30s`, `15m`, `1h`, `2d`, or bare seconds)                           |
| `ADMIN_EMAIL`                  | `admin@example.local`     | Email of the user created by `db:seed`                                               |
| `ADMIN_PASSWORD`               | `admin12345678`           | Password for the seeded user (min 12 chars; dev only)                                |
| `TRUSTED_PROXIES`              | _(empty)_                 | Who may set `X-Forwarded-For`: CIDRs, `loopback`, `unloopback`; empty trusts nothing |
| `RATE_LIMIT_FAIL_OPEN`         | `true`                    | If Redis is unreachable, allow (`true`) or reject (`false`) rate-limited requests    |
| `ADMIN_LOGIN_MAX_ATTEMPTS`     | `10`                      | Failed admin logins before throttling kicks in                                       |
| `ADMIN_LOGIN_WINDOW_MS`        | `60000`                   | Window for the login-attempt throttle                                                |
| `SSRF_DEV_ALLOWLIST`           | _(empty)_                 | Hostnames allowed to bypass private-IP blocking for upstream URLs (dev only)         |
| `UPSTREAM_CONNECT_TIMEOUT_MS`  | `5000`                    | TCP connect timeout per proxied request                                              |
| `UPSTREAM_RESPONSE_TIMEOUT_MS` | `30000`                   | Full upstream response timeout                                                       |
| `MAX_BODY_BYTES`               | `1048576`                 | Max proxied request body (1 MiB)                                                     |
| `MAX_HEADER_BYTES`             | `8192`                    | Max proxied request headers                                                          |
| `LOG_LEVEL`                    | `info`                    | `debug` / `info` / `warn` / `error`                                                  |
| `LOG_PRETTY`                   | `false`                   | Human-readable logs (dev) vs JSON (prod)                                             |
| `METRICS_PATH`                 | `/internal/metrics`       | Reserved metrics path                                                                |
| `CORS_ALLOWED_ORIGINS`         | _(empty)_                 | Comma-separated origins allowed to call the API; empty disables CORS                 |
| `PLUGIN_DIR`                   | _(empty)_                 | Directory of `.js` plugin modules loaded at startup                                  |

## TLS

Generate local certificates (self-signed, localhost only — never for production):

```bash
pnpm tls:generate
TLS_ENABLED=true PORT=8443 pnpm dev
```

With `HTTPS_REDIRECT=true`, a second listener on plain HTTP :8080 answers `301`
to `https://<host>:8443<path>`. In production, terminate TLS at your load
balancer or reverse proxy and leave `TLS_ENABLED=false` behind it.

## Admin UI build-time config

| Variable            | Default         | Description                                             |
| ------------------- | --------------- | ------------------------------------------------------- |
| `VITE_API_BASE_URL` | _(same origin)_ | Gateway base URL baked into the admin SPA at build time |

The Docker admin image accepts this as a build arg; `docker-compose.yml` sets
it to `http://localhost:8080`.
