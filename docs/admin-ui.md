# Admin UI

A React 19 + Vite single-page app in `apps/admin`. It is served separately
(Docker: nginx on :3000) and talks to the gateway's `/api/...` over HTTP.

## Running it

```bash
# development (Vite dev server, proxies /api to the gateway)
pnpm --filter admin-ui dev

# production build
pnpm --filter admin-ui build
```

`VITE_API_BASE_URL` bakes the gateway address in at build time; unset means
same-origin. The compose setup points it at `http://localhost:8080`.

## Sign in

Open the UI and sign in with an admin/operator/viewer account (seeded default:
`admin@example.local` / `admin12345678`). The JWT is kept in `sessionStorage`, so it
is scoped to the tab and cleared when the tab closes. Every API call sends it
as an `Authorization: Bearer` header; the UI never puts tokens in URLs.

What you can do depends on your role (viewer < operator < admin):

- **viewer** — read everything: dashboard, routes, policies, audit log, status.
- **operator** — viewer plus triggering config reloads and watching the live
  analytics stream.
- **admin** — everything, including creating/editing routes, policies, and users.

## Pages

- **Dashboard** — live traffic from the SSE stream: request rate, error rate,
  latency (avg + blended p95, labeled approximate), rate-limited and rejected
  counts, per-route table, open-circuit alerts. Empty states say so explicitly;
  the page never invents data.
- **Routes** — list, enable/disable, create, edit, delete. Mutations show the
  new config version ("Configuration updated — config version N").
- **Route detail** — full route JSON, its policies, and recent audit entries.
- **Policies** — rate-limit and circuit-breaker policy CRUD.
- **Circuit breakers** — live per-route breaker states from the SSE stream.
- **Audit log** — filterable, paginated record of every admin mutation.
- **System status** — readiness, config version, reload trigger, metrics summary.
- **Settings** — session info and user management (admins only).

## Live updates

The dashboard, circuit breakers, and system status pages share one
`useAnalytics` hook: a `fetch()`-based SSE consumer with exponential-backoff
reconnect. `EventSource` cannot send an `Authorization` header, and tokens in
query strings leak into logs and history, so streaming goes over `fetch` +
`ReadableStream`. See `docs/security.md` for the rationale.
