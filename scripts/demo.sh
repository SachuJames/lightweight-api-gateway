#!/usr/bin/env bash
#
# 22-step guided demo of the lightweight API gateway.
#
# Prerequisites: PostgreSQL + Redis reachable, DB migrated + seeded
# (`pnpm db:migrate && pnpm db:seed`), and the gateway running:
#
#   pnpm dev   # or: node apps/gateway/dist/index.js
#
# The script starts the example upstream services itself and cleans up
# everything it creates (routes, policies, users) on exit.
#
#   ./scripts/demo.sh
#   GATEWAY_URL=http://localhost:8080 ./scripts/demo.sh
#
set -euo pipefail

GATEWAY="${GATEWAY_URL:-http://localhost:8080}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin12345678}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STEP=0
TOTAL=22
step() {
  STEP=$((STEP + 1))
  printf '\n=== [%d/%d] %s ===\n' "$STEP" "$TOTAL" "$1"
}

# Extract a field from JSON on stdin: jget '.token'
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=($1);console.log(v??'')})" <<<"$(cat)"; }

api() { # api METHOD PATH [BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$GATEWAY$path" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$body"
  else
    curl -sS -X "$method" "$GATEWAY$path" -H "Authorization: Bearer $TOKEN"
  fi
}

UPSTREAM_PIDS=""
cleanup() {
  if [ -n "$UPSTREAM_PIDS" ]; then
    # shellcheck disable=SC2086
    kill $UPSTREAM_PIDS 2>/dev/null || true
  fi
}
trap cleanup EXIT

step "Check the gateway is up"
curl -sS --max-time 5 "$GATEWAY/health"
echo

step "Check readiness (database + redis checks)"
curl -sS "$GATEWAY/ready" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('status:',j.status,'| db:',j.checks.database,'| redis:',j.checks.redis,'| configVersion:',j.configVersion)})"

step "Start the example upstream services"
PORT=3001 node "$ROOT/examples/upstreams/users/server.js" >/tmp/demo-users.log 2>&1 &
UPSTREAM_PIDS="$UPSTREAM_PIDS $!"
PORT=3004 node "$ROOT/examples/upstreams/failing/server.js" >/tmp/demo-failing.log 2>&1 &
UPSTREAM_PIDS="$UPSTREAM_PIDS $!"
for i in $(seq 1 30); do
  curl -sS --max-time 1 http://localhost:3001/health >/dev/null 2>&1 &&
  curl -sS --max-time 1 http://localhost:3004/health >/dev/null 2>&1 && break
  sleep 0.5
done
echo "users upstream on :3001, failing upstream on :3004"

step "Log in as admin and capture the JWT"
TOKEN="$(curl -sS -X POST "$GATEWAY/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jget 'JSON.parse(d).token')"
[ -n "$TOKEN" ] || { echo "login failed"; exit 1; }
echo "token acquired (${#TOKEN} chars)"

step "Read the baseline config version"
V0="$(api GET /api/config/version | jget 'JSON.parse(d).version')"
echo "config version: $V0"

step "List the seeded routes"
api GET /api/routes | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const r of JSON.parse(d).routes)console.log('-',r.name,r.pathPattern,'->',r.upstreamUrl)})"

step "Create a demo route (no restart needed)"
ROUTE_JSON="$(api POST /api/routes '{"name":"demo-users","pathPattern":"/demo/*","methods":["GET"],"upstreamUrl":"http://localhost:3001","enabled":true,"priority":100,"authRequired":false,"timeoutMs":5000}')"
ROUTE_ID="$(echo "$ROUTE_JSON" | jget 'JSON.parse(d).route.id')"
V1="$(echo "$ROUTE_JSON" | jget 'JSON.parse(d).version')"
echo "route id: $ROUTE_ID (version $V0 -> $V1)"

step "Proxy a request through the new route"
curl -sS "$GATEWAY/demo/users/1"
echo

step "Observe the request in the metrics snapshot"
api GET /api/metrics | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=JSON.parse(d).counters;for(const k of Object.keys(c))if(k.includes('demo-users')||k.includes('gateway.requests'))console.log(k,'=',c[k])})" | head -5

step "Create a strict rate-limit policy (3 requests burst)"
POL_JSON="$(api POST /api/rate-limit-policies '{"name":"demo-strict","capacity":3,"refillRatePerSec":1,"keyStrategy":"ip","failOpen":true}')"
RL_ID="$(echo "$POL_JSON" | jget 'JSON.parse(d).policy.id')"
echo "policy id: $RL_ID"

step "Attach the policy to the demo route"
api PUT "/api/routes/$ROUTE_ID" "{\"rateLimitPolicyId\":\"$RL_ID\"}" | jget 'JSON.parse(d).version' | xargs echo "version:"

step "Burst 5 requests: expect 3x200 then 2x429"
OK=0; LIMITED=0
for _ in 1 2 3 4 5; do
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$GATEWAY/demo/users/1")"
  if [ "$CODE" = "200" ]; then OK=$((OK+1)); elif [ "$CODE" = "429" ]; then LIMITED=$((LIMITED+1)); fi
done
echo "200s: $OK, 429s: $LIMITED"
[ "$OK" = "3" ] && [ "$LIMITED" = "2" ] || { echo "unexpected rate-limit behavior"; exit 1; }

step "Detach the policy again"
api PUT "/api/routes/$ROUTE_ID" '{"rateLimitPolicyId":null}' >/dev/null
curl -sS -o /dev/null -w 'after detach: %{http_code}\n' "$GATEWAY/demo/users/1"

step "Create a circuit-breaker policy (opens after 2 failures)"
CB_JSON="$(api POST /api/circuit-breaker-policies '{"name":"demo-breaker","failureThreshold":2,"rollingWindowMs":10000,"openDurationMs":30000,"halfOpenMaxProbes":1,"failureStatuses":[500],"countTimeouts":true}')"
CB_ID="$(echo "$CB_JSON" | jget 'JSON.parse(d).policy.id')"
echo "policy id: $CB_ID"

step "Point a route at the failing upstream with the breaker attached"
FAIL_JSON="$(api POST /api/routes '{"name":"demo-failing","pathPattern":"/demo/failing/*","methods":["GET"],"upstreamUrl":"http://localhost:3004","enabled":true,"priority":100,"authRequired":false,"timeoutMs":5000}')"
FAIL_ID="$(echo "$FAIL_JSON" | jget 'JSON.parse(d).route.id')"
api PUT "/api/routes/$FAIL_ID" "{\"circuitBreakerPolicyId\":\"$CB_ID\"}" >/dev/null
echo "route id: $FAIL_ID"

step "Trip the breaker: 500, 500, then 503 (open)"
for _ in 1 2 3; do
  curl -sS -o /dev/null -w '%{http_code} ' "$GATEWAY/demo/failing/x"
done
echo

step "Watch one live analytics event from the SSE stream"
curl -sS -N --max-time 6 "$GATEWAY/api/analytics/stream" -H "Authorization: Bearer $TOKEN" \
  -o /tmp/demo-sse.txt 2>/dev/null || true
grep -m 1 '^data:' /tmp/demo-sse.txt | head -c 200
echo

step "Change the demo route's path with zero downtime (no restart)"
api PUT "/api/routes/$ROUTE_ID" '{"pathPattern":"/demo/v2/*"}' | jget 'JSON.parse(d).version' | xargs echo "version:"
curl -sS -o /dev/null -w 'old path: %{http_code}\n' "$GATEWAY/demo/users/1"
curl -sS -o /dev/null -w 'new path: %{http_code}\n' "$GATEWAY/demo/v2/users/1"

step "Disable the route (404), then re-enable it (200)"
api PUT "/api/routes/$ROUTE_ID" '{"enabled":false}' >/dev/null
curl -sS -o /dev/null -w 'disabled: %{http_code}\n' "$GATEWAY/demo/v2/users/1"
api PUT "/api/routes/$ROUTE_ID" '{"enabled":true}' >/dev/null
curl -sS -o /dev/null -w 're-enabled: %{http_code}\n' "$GATEWAY/demo/v2/users/1"

step "Inspect the audit log for this session's mutations"
api GET "/api/audit?limit=8" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('total records:',j.total);for(const r of j.records.slice(0,6))console.log('-',r.action,r.resourceType,r.actor)})"

step "RBAC: a viewer cannot create routes (403)"
VIEWER_JSON="$(api POST /api/users '{"email":"demo-viewer@example.local","password":"viewer-password-123","role":"viewer"}')"
VIEWER_ID="$(echo "$VIEWER_JSON" | jget 'JSON.parse(d).user.id')"
VTOKEN="$(curl -sS -X POST "$GATEWAY/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"demo-viewer@example.local","password":"viewer-password-123"}' | jget 'JSON.parse(d).token')"
curl -sS -o /dev/null -w 'viewer POST /api/routes: %{http_code}\n' -X POST "$GATEWAY/api/routes" \
  -H "Authorization: Bearer $VTOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"nope","pathPattern":"/nope/*","methods":["GET"],"upstreamUrl":"http://localhost:3001"}'
api DELETE "/api/users/$VIEWER_ID" >/dev/null
echo "viewer user removed"

step "Clean up everything this demo created"
api DELETE "/api/routes/$ROUTE_ID" >/dev/null
api DELETE "/api/routes/$FAIL_ID" >/dev/null
api DELETE "/api/rate-limit-policies/$RL_ID" >/dev/null
api DELETE "/api/circuit-breaker-policies/$CB_ID" >/dev/null
api GET /api/config/version | jget 'JSON.parse(d).version' | xargs echo "final config version:"
echo
echo "Demo complete: 22/22 steps."
