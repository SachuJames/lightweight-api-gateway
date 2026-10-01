# Security

## Authentication & authorization

- Admin API auth is JWT (HMAC-SHA256) in the `Authorization: Bearer` header.
  Passwords are bcrypt-hashed. Tokens expire per `JWT_EXPIRES_IN` (default 15m).
- Roles are hierarchical: `viewer` < `operator` < `admin`. `requireRole('operator')`
  admits operators and admins. The UI mirrors this with the same ordering.
- Login attempts are throttled per IP (`ADMIN_LOGIN_MAX_ATTEMPTS` /
  `ADMIN_LOGIN_WINDOW_MS`, Redis-backed).
- Every admin mutation writes an audit record (actor, action, resource, before/after).

## Transport

- The admin UI sends the JWT in the `Authorization` header, never in a query
  string: query strings land in server logs, browser history, and referers.
  The analytics SSE stream is therefore consumed with `fetch()` streaming
  rather than `EventSource`, which cannot set request headers.
- The token lives in `sessionStorage` (tab-scoped, cleared on tab close),
  not `localStorage`.
- Because auth is header-based, there is no cookie/CSRF surface on the API.
- Terminate TLS at your load balancer in production, or set `TLS_ENABLED=true`
  with a real certificate. The `scripts/generate-dev-certs.sh` certificates
  are self-signed for localhost only.

## SSRF protection

Route `upstreamUrl` values are validated at creation/update time: hostnames
that resolve to private, loopback, or link-local IPs are rejected, since a
route creator could otherwise make the gateway probe internal infrastructure.
`SSRF_DEV_ALLOWLIST` exists only for local development (the compose hostnames);
leave it empty in production. Note the DNS check happens at route-write time,
not per request: a hostname that later resolves to a new address (DNS
rebinding) is not re-checked, so point routes at stable infrastructure you
control.

## Request hardening

- Proxied bodies are capped (`MAX_BODY_BYTES`, default 1 MiB) and header
  sizes capped (`MAX_HEADER_BYTES`).
- Upstream connect and response timeouts bound every proxied request.
- `X-Forwarded-For` is honored only from `TRUSTED_PROXIES`; by default the
  gateway trusts no proxy, so `req.ip` is the direct peer (rate-limit keys
  cannot be spoofed via headers).
- Unknown routes, disabled routes, and auth/rate-limit/breaker rejections all
  return the same JSON error envelope with a `requestId`; stack traces are
  never sent to clients.

## Secrets

- `JWT_SECRET`, `DATABASE_URL`, `POSTGRES_PASSWORD` have no production
  defaults — the service refuses to start without them. Anything marked
  "dev-only" in `.env.example` and `docker-compose.yml` must be replaced.
- Secrets never appear in logs; the config loader redacts them from error
  output and the request logger skips authorization headers.
- Never commit `.env`. The repo contains no real credentials.

## Known limitations

- Rate limiting is per resolved key in a shared Redis; a client behind NAT
  shares an `ip`-strategy bucket with everyone behind that NAT.
- Circuit breakers are per instance, so a rolling upstream failure trips
  breakers independently on each instance.
- The metrics registry is in-memory per instance; restarting an instance
  resets its counters (the SSE stream is a live view, not history).
