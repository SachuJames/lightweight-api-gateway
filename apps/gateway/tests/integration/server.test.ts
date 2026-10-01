import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit-service.js';
import { hashPassword } from '../../src/auth.js';
import { CircuitBreakerRegistry } from '../../src/circuit-breaker.js';
import { loadConfig } from '../../src/config.js';
import { ConfigStore, loadSnapshot } from '../../src/config-service.js';
import { insertRoute } from '../../src/db/routes.js';
import { bumpVersion } from '../../src/db/config-versions.js';
import { insertCircuitBreakerPolicy, insertRateLimitPolicy } from '../../src/db/policies.js';
import { createUser } from '../../src/db/users.js';
import { MetricsRegistry } from '../../src/metrics.js';
import { PluginManager, type GatewayPlugin } from '../../src/plugins.js';
import { createRedis } from '../../src/redis.js';
import { buildServer } from '../../src/server.js';
import { routeInputSchema } from '../../src/routing.js';
import { setupTestDb } from './setup.js';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';

let pool: Pool;
let redis: Redis;
let publisher: Redis;
let app: FastifyInstance;
let goodBase: string;
let flakyBase: string;
let slowBase: string;
let servers: Server[] = [];
let adminToken = '';
let operatorToken = '';

function startUpstream(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ path: req.url, requestId: req.headers['x-request-id'] ?? null }));
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  pool = await setupTestDb('gateway_test_server');
  process.env['DATABASE_URL'] = 'postgres://gateway:gateway@localhost:5432/gateway_test_server';
  process.env['REDIS_URL'] = REDIS_URL;
  process.env['JWT_SECRET'] = 'test-secret-at-least-32-chars-long!!';
  const config = loadConfig();

  redis = createRedis(REDIS_URL);
  publisher = createRedis(REDIS_URL);
  await redis.ping();
  const staleKeys = await redis.keys('rl:*');
  if (staleKeys.length > 0) await redis.del(...staleKeys);

  goodBase = await startUpstream();
  flakyBase = await new Promise<string>((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  slowBase = await new Promise<string>((resolve) => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, 1500);
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });

  const passwordHash = await hashPassword('password-123456');
  await createUser(pool, { email: 'admin@example.local', passwordHash, role: 'admin' });
  await createUser(pool, { email: 'operator@example.local', passwordHash, role: 'operator' });

  const rlPolicy = await insertRateLimitPolicy(pool, {
    name: 'tight',
    capacity: 2,
    refillRatePerSec: 0.05,
    keyStrategy: 'ip',
    failOpen: false,
  });
  const cbPolicy = await insertCircuitBreakerPolicy(pool, {
    name: 'fragile',
    failureThreshold: 2,
    rollingWindowMs: 60_000,
    openDurationMs: 60_000,
    halfOpenMaxProbes: 1,
    failureStatuses: [500, 502],
    countTimeouts: true,
  });

  const base = {
    methods: ['GET'],
    enabled: true,
    priority: 100,
    authRequired: false,
    stripPathPrefix: true,
  };
  const seedRoute = (input: Record<string, unknown>): Promise<unknown> =>
    insertRoute(pool, routeInputSchema.parse(input));
  await seedRoute({ ...base, name: 'proxy', pathPattern: '/proxy/*', upstreamUrl: goodBase });
  await seedRoute({
    ...base,
    name: 'secure',
    pathPattern: '/secure/*',
    upstreamUrl: goodBase,
    authRequired: true,
  });
  await seedRoute({
    ...base,
    name: 'limited',
    pathPattern: '/limited/*',
    upstreamUrl: goodBase,
    rateLimitPolicyId: rlPolicy.id,
  });
  await seedRoute({
    ...base,
    name: 'flaky',
    pathPattern: '/flaky/*',
    upstreamUrl: flakyBase,
    circuitBreakerPolicyId: cbPolicy.id,
  });
  await seedRoute({
    ...base,
    name: 'slow',
    pathPattern: '/slow/*',
    upstreamUrl: slowBase,
    timeoutMs: 400,
  });

  await bumpVersion(pool, 'test', 'seed routes for server tests');

  const plugins = new PluginManager();
  const blocker: GatewayPlugin = {
    name: 'test-blocker',
    onRequest: async (req) => {
      if (req.url.includes('/blocked')) return { statusCode: 403, body: 'blocked by plugin' };
    },
  };
  plugins.register(blocker);

  app = await buildServer({
    config,
    pool,
    redis,
    publisher,
    store: new ConfigStore(await loadSnapshot(pool)),
    plugins,
    metrics: new MetricsRegistry(),
    breakers: new CircuitBreakerRegistry(),
    auth: { jwtSecret: config.jwtSecret, tokenTtlSec: 3600 },
    audit: new AuditService(pool),
  });
  await app.ready();

  const login = async (email: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'password-123456' },
    });
    return res.json<{ token: string }>().token;
  };
  adminToken = await login('admin@example.local');
  operatorToken = await login('operator@example.local');
}, 90_000);

afterAll(async () => {
  await app.close();
  for (const s of servers) s.close();
  servers = [];
  redis.disconnect();
  publisher.disconnect();
  await pool.end();
});

describe('health', () => {
  it('serves liveness and readiness', async () => {
    const live = await app.inject({ method: 'GET', url: '/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks).toEqual({ database: 'ok', redis: 'ok' });
    expect(ready.json().configVersion).toBeGreaterThan(0);
  });
});

describe('proxy pipeline', () => {
  it('proxies with path stripping, query preservation, and request ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/proxy/hello?x=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ path: string; requestId: string | null }>();
    expect(body.path).toBe('/hello?x=1');
    expect(body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.requestId);
    expect(res.headers['x-upstream']).toBe('yes');
  });

  it('echoes a valid client request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/proxy/hi',
      headers: { 'x-request-id': 'client-123' },
    });
    expect(res.headers['x-request-id']).toBe('client-123');
  });

  it('returns 404 for unmatched paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/nothing-here' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('enforces auth on protected routes', async () => {
    const anon = await app.inject({ method: 'GET', url: '/secure/data' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe('AUTHENTICATION_ERROR');

    const authed = await app.inject({
      method: 'GET',
      url: '/secure/data',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(authed.statusCode).toBe(200);
  });

  it('short-circuits via plugins', async () => {
    const res = await app.inject({ method: 'GET', url: '/proxy/blocked' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('blocked by plugin');
  });
});

describe('rate limiting', () => {
  it('rejects over-limit requests with 429 and retry-after', async () => {
    const url = '/limited/res';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    const third = await app.inject({ method: 'GET', url });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(third.headers['retry-after']).toBeTruthy();
  });
});

describe('circuit breaker', () => {
  it('opens after repeated upstream failures', async () => {
    const first = await app.inject({ method: 'GET', url: '/flaky/a' });
    expect(first.statusCode).toBe(500);
    const second = await app.inject({ method: 'GET', url: '/flaky/b' });
    expect(second.statusCode).toBe(500);
    const third = await app.inject({ method: 'GET', url: '/flaky/c' });
    expect(third.statusCode).toBe(503);
    expect(third.json().error.code).toBe('CIRCUIT_OPEN');
  });

  it('times out slow upstreams', async () => {
    const res = await app.inject({ method: 'GET', url: '/slow/x' });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('SSE analytics', () => {
  it('requires operator role', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/stream' });
    expect(res.statusCode).toBe(401);
  });

  it('streams metrics snapshots', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('data:')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const payload = JSON.parse(text.split('data:')[1]!.split('\n')[0] as string) as {
      configVersion: number;
      metrics: unknown;
      circuits: unknown;
    };
    expect(payload.configVersion).toBeGreaterThan(0);
    expect(payload.metrics).toBeTruthy();
  }, 30_000);
});
