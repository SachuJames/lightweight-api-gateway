# Admin REST API

Base path `/api`. All responses are JSON. Errors look like:

```json
{
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "No route matches this request.",
    "requestId": "req-3f9a"
  }
}
```

Include the `requestId` when reporting a problem; it appears in the server logs.

## Authentication

`POST /api/auth/login` — `{ "email", "password" }` → `{ "token", "user": { "id", "email", "role" } }`.
Pass the token as `Authorization: Bearer <token>` on every other call.
Failed logins are throttled (`ADMIN_LOGIN_MAX_ATTEMPTS` per `ADMIN_LOGIN_WINDOW_MS`).

Roles are hierarchical: `viewer` < `operator` < `admin`. An endpoint listed as
"operator" admits operators and admins.

## Endpoints

| Method & path                              | Roles     | Description                                                                                  |
| ------------------------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`                     | —         | Obtain a JWT                                                                                 |
| `GET /api/routes`                          | viewer+   | List routes                                                                                  |
| `POST /api/routes`                         | admin     | Create a route → `{ route, version }`                                                        |
| `GET /api/routes/:id`                      | viewer+   | Get one route                                                                                |
| `PUT /api/routes/:id`                      | admin     | Update a route (partial body) → `{ route, version }`                                         |
| `DELETE /api/routes/:id`                   | admin     | Delete a route                                                                               |
| `GET /api/rate-limit-policies`             | viewer+   | List rate-limit policies                                                                     |
| `POST /api/rate-limit-policies`            | admin     | Create a policy → `{ policy, version }`                                                      |
| `PUT /api/rate-limit-policies/:id`         | admin     | Update a policy                                                                              |
| `DELETE /api/rate-limit-policies/:id`      | admin     | Delete a policy                                                                              |
| `GET /api/circuit-breaker-policies`        | viewer+   | List circuit-breaker policies                                                                |
| `POST /api/circuit-breaker-policies`       | admin     | Create a policy → `{ policy, version }`                                                      |
| `PUT /api/circuit-breaker-policies/:id`    | admin     | Update a policy                                                                              |
| `DELETE /api/circuit-breaker-policies/:id` | admin     | Delete a policy                                                                              |
| `GET /api/users`                           | admin     | List users                                                                                   |
| `POST /api/users`                          | admin     | Create a user (email, password, role)                                                        |
| `PUT /api/users/:id`                       | admin     | Update a user (incl. role)                                                                   |
| `DELETE /api/users/:id`                    | admin     | Delete a user                                                                                |
| `GET /api/audit`                           | admin     | Audit log, `{ records, total }`; filters: `action`, `actor`, `from`, `to`, `limit`, `offset` |
| `GET /api/config/version`                  | viewer+   | `{ version, dbVersion }`                                                                     |
| `POST /api/config/reload`                  | operator+ | Force an immediate config refresh from the DB                                                |
| `GET /api/metrics`                         | viewer+   | Current metrics snapshot                                                                     |
| `GET /api/analytics/stream`                | operator+ | Server-sent events: a JSON snapshot every 2s                                                 |

Every mutation bumps the config version, writes an audit record, and notifies
all gateway instances over Redis pub/sub (see `docs/architecture.md`).

## Route object

```json
{
  "id": "uuid",
  "name": "users",
  "pathPattern": "/api/users/*",
  "methods": ["GET", "POST"],
  "upstreamUrl": "http://users-service:3001",
  "enabled": true,
  "priority": 100,
  "authRequired": false,
  "stripPathPrefix": true,
  "rateLimitPolicyId": "uuid | null",
  "circuitBreakerPolicyId": "uuid | null",
  "timeoutMs": 30000,
  "pluginConfig": {}
}
```

Path patterns support `:param` segments and a trailing `/*` wildcard. When
several routes match, the highest `priority` wins, then the most specific
pattern. With `stripPathPrefix: true`, `/api/users/42` is proxied as `/42`
(the matched prefix is removed).

## Policy objects

Rate-limit policy: `{ id, name, capacity, refillRatePerSec, keyStrategy, failOpen }`.
`keyStrategy` is one of `ip`, `user`, `route_ip`, `route_user`. The bucket is a
Redis Lua token bucket shared across instances.

Circuit-breaker policy: `{ id, name, failureThreshold, rollingWindowMs,
openDurationMs, halfOpenMaxProbes, failureStatuses, countTimeouts }`.
Breakers are per gateway instance (see `docs/architecture.md`).

## Health

- `GET /health` → `{ "status": "ok" }` (liveness, no auth)
- `GET /ready` → `{ "status": "ok"|"degraded", "checks": { "database", "redis" }, "configVersion", "uptimeSec" }` (no auth)

## SSE analytics stream

`GET /api/analytics/stream` (operator+) sends `data: {...}\n\n` every 2
seconds:

```json
{
  "timestamp": "2026-10-01T00:00:00.000Z",
  "configVersion": 3,
  "metrics": {
    "counters": { "gateway.requests{status=\"200\",route=\"users\"}": 42 },
    "latencies": {}
  },
  "circuits": { "<route-id>": "closed" }
}
```

The admin UI consumes this with `fetch()` streaming (not `EventSource`), so the
JWT travels in the `Authorization` header instead of a query string. Clients
should reconnect with backoff on disconnect; each event is self-contained.
