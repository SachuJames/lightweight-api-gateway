# Example upstream services

Four tiny upstream services with zero dependencies, used by the demo script
(`scripts/demo.sh`), the seeded database routes, and the Docker Compose setup.
Each exposes a `GET /health` endpoint and listens on `PORT` (defaults below).

| Service   | Default port | What it does                                                  |
| --------- | ------------ | ------------------------------------------------------------- |
| `users`   | 3001         | In-memory users API: list, get by id, create                  |
| `orders`  | 3002         | In-memory orders API: list (filter by `?userId=`), create     |
| `slow`    | 3003         | Delays every response by `?delay=` ms (timeout testing)       |
| `failing` | 3004         | Returns 500 for everything except `/health` (breaker testing) |

Run one directly:

```bash
node examples/upstreams/users/server.js
# or on a custom port:
PORT=4001 node examples/upstreams/users/server.js
```

Run all four at once:

```bash
for svc in users orders slow failing; do
  node examples/upstreams/$svc/server.js &
done
```

The seeded gateway routes (`pnpm db:seed`) point at the Docker Compose
hostnames (`users-service:3001`, …). For local runs without Compose, either
add hostnames to `/etc/hosts` or point the routes at `http://127.0.0.1:3001`
etc. via the admin API or UI.
