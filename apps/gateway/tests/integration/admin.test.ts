import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { AuditService } from '../../src/audit-service.js';
import { hashPassword } from '../../src/auth.js';
import { ConfigStore } from '../../src/config-service.js';
import { registerAdminApi } from '../../src/admin.js';
import { createUser } from '../../src/db/users.js';
import { MetricsRegistry } from '../../src/metrics.js';
import { createRedis } from '../../src/redis.js';
import { CONFIG_RELOAD_CHANNEL } from '../../src/reload.js';
import { setupTestDb } from './setup.js';
import type { Pool } from 'pg';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const AUTH = { jwtSecret: 'test-secret-at-least-32-chars-long!!', tokenTtlSec: 3600 };

let pool: Pool;
let publisher: Redis;
let app: ReturnType<typeof Fastify>;

const tokens: Record<string, string> = {};

async function loginAs(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

function auth(email: string) {
  return { headers: { authorization: `Bearer ${tokens[email]}` } };
}

beforeAll(async () => {
  pool = await setupTestDb('gateway_test_admin');
  publisher = createRedis(REDIS_URL);
  await publisher.ping();

  const passwordHash = await hashPassword('password-123456');
  await createUser(pool, { email: 'admin@example.local', passwordHash, role: 'admin' });
  await createUser(pool, { email: 'operator@example.local', passwordHash, role: 'operator' });
  await createUser(pool, { email: 'viewer@example.local', passwordHash, role: 'viewer' });

  app = Fastify();
  registerAdminApi(app, {
    pool,
    publisher,
    store: ConfigStore.empty(),
    audit: new AuditService(pool),
    auth: AUTH,
    metrics: new MetricsRegistry(),
  });
  await app.ready();

  tokens['admin@example.local'] = await loginAs('admin@example.local', 'password-123456');
  tokens['operator@example.local'] = await loginAs('operator@example.local', 'password-123456');
  tokens['viewer@example.local'] = await loginAs('viewer@example.local', 'password-123456');
}, 60_000);

afterAll(async () => {
  await app.close();
  await publisher.quit();
  await pool.end();
});

describe('auth', () => {
  it('rejects bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.local', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTHENTICATION_ERROR');
  });

  it('rejects unauthenticated admin calls', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/routes' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed tokens', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/routes',
      headers: { authorization: 'Bearer garbage' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('RBAC', () => {
  it('viewer can read but not write', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/routes', ...auth('viewer@example.local') }))
        .statusCode,
    ).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/api/routes',
      ...auth('viewer@example.local'),
      payload: { name: 'x', pathPattern: '/x/*', methods: ['GET'], upstreamUrl: 'http://x:1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_ERROR');
  });

  it('operator cannot manage routes or users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      ...auth('operator@example.local'),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('routes', () => {
  it('creates, reads, updates, deletes with validation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/routes',
      ...auth('admin@example.local'),
      payload: {
        name: 'users',
        pathPattern: '/api/users/*',
        methods: ['GET'],
        upstreamUrl: 'http://users:3001',
      },
    });
    expect(created.statusCode).toBe(201);
    const route = (created.json() as { route: { id: string; version: number } }).route;
    expect(route.version).toBe(1);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/routes',
      ...auth('admin@example.local'),
      payload: { name: 'bad', pathPattern: 'nope', methods: ['GET'], upstreamUrl: 'http://x:1' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');

    const unknownPolicy = await app.inject({
      method: 'POST',
      url: '/api/routes',
      ...auth('admin@example.local'),
      payload: {
        name: 'x',
        pathPattern: '/x/*',
        methods: ['GET'],
        upstreamUrl: 'http://x:1',
        rateLimitPolicyId: '9b2d5c1a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      },
    });
    expect(unknownPolicy.statusCode).toBe(422);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/routes/${route.id}`,
      ...auth('admin@example.local'),
      payload: { priority: 500 },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { route: { version: number } }).route.version).toBe(2);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/routes/9b2d5c1a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      ...auth('admin@example.local'),
    });
    expect(missing.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/routes/${route.id}`,
      ...auth('admin@example.local'),
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('publishes a reload notification on mutation', async () => {
    const subscriber = createRedis(REDIS_URL);
    await subscriber.subscribe(CONFIG_RELOAD_CHANNEL);
    const received: string[] = [];
    subscriber.on('message', (_ch, msg) => received.push(msg));
    try {
      await app.inject({
        method: 'POST',
        url: '/api/routes',
        ...auth('admin@example.local'),
        payload: {
          name: 'tmp',
          pathPattern: '/tmp/*',
          methods: ['GET'],
          upstreamUrl: 'http://x:1',
        },
      });
      const start = Date.now();
      while (received.length === 0 && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received.length).toBe(1);
      const msg = JSON.parse(received[0] as string) as { version: number };
      expect(msg.version).toBeGreaterThan(0);
    } finally {
      await subscriber.unsubscribe(CONFIG_RELOAD_CHANNEL);
      subscriber.disconnect();
    }
  });
});

describe('policies', () => {
  it('creates and deletes policies; blocks deletion when referenced', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/rate-limit-policies',
      ...auth('admin@example.local'),
      payload: {
        name: 'strict',
        capacity: 10,
        refillRatePerSec: 1,
        keyStrategy: 'ip',
        failOpen: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const policy = (created.json() as { policy: { id: string } }).policy;

    const route = await app.inject({
      method: 'POST',
      url: '/api/routes',
      ...auth('admin@example.local'),
      payload: {
        name: 'guarded',
        pathPattern: '/guarded/*',
        methods: ['GET'],
        upstreamUrl: 'http://x:1',
        rateLimitPolicyId: policy.id,
      },
    });
    const routeId = (route.json() as { route: { id: string } }).route.id;

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/rate-limit-policies/${policy.id}`,
      ...auth('admin@example.local'),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('CONFLICT');

    await app.inject({
      method: 'DELETE',
      url: `/api/routes/${routeId}`,
      ...auth('admin@example.local'),
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/rate-limit-policies/${policy.id}`,
      ...auth('admin@example.local'),
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('validates circuit breaker policy input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/circuit-breaker-policies',
      ...auth('admin@example.local'),
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('audit', () => {
  it('records mutations and exposes filters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit?action=route.create&limit=5',
      ...auth('admin@example.local'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { records: { actor: string; action: string }[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.records[0]?.actor).toBe('admin@example.local');
    expect(body.records.every((r) => r.action === 'route.create')).toBe(true);
  });
});

describe('config and metrics', () => {
  it('reports versions and serves metrics', async () => {
    const version = await app.inject({
      method: 'GET',
      url: '/api/config/version',
      ...auth('viewer@example.local'),
    });
    expect(version.statusCode).toBe(200);
    expect((version.json() as { dbVersion: number }).dbVersion).toBeGreaterThan(0);

    const reload = await app.inject({
      method: 'POST',
      url: '/api/config/reload',
      ...auth('operator@example.local'),
    });
    expect(reload.statusCode).toBe(200);

    const viewerReloadDenied = await app.inject({
      method: 'POST',
      url: '/api/config/reload',
      ...auth('viewer@example.local'),
    });
    expect(viewerReloadDenied.statusCode).toBe(403);

    const metrics = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      ...auth('viewer@example.local'),
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toHaveProperty('counters');
  });
});

describe('users', () => {
  it('admin creates users; cannot delete self', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      ...auth('admin@example.local'),
      payload: { email: 'newop@example.local', password: 'another-password-1', role: 'operator' },
    });
    expect(created.statusCode).toBe(201);
    const userId = (created.json() as { user: { id: string } }).user.id;

    const me = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.local', password: 'password-123456' },
    });
    const myId = (me.json() as { user: { id: string } }).user.id;
    const selfDelete = await app.inject({
      method: 'DELETE',
      url: `/api/users/${myId}`,
      ...auth('admin@example.local'),
    });
    expect(selfDelete.statusCode).toBe(400);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/users/${userId}`,
      ...auth('admin@example.local'),
    });
    expect(deleted.statusCode).toBe(200);
  });
});
