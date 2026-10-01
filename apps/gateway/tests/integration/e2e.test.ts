/**
 * End-to-end tests: full gateway instances (buildServer) against real
 * upstream HTTP servers, exercising zero-downtime reconfiguration and
 * multi-instance convergence exactly the way production runs them
 * (admin API mutation -> Redis pub/sub -> ConfigReloader refresh).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit-service.js';
import { hashPassword } from '../../src/auth.js';
import { CircuitBreakerRegistry } from '../../src/circuit-breaker.js';
import { loadConfig } from '../../src/config.js';
import { ConfigStore, loadSnapshot } from '../../src/config-service.js';
import { bumpVersion } from '../../src/db/config-versions.js';
import { insertRoute } from '../../src/db/routes.js';
import { createUser } from '../../src/db/users.js';
import { MetricsRegistry } from '../../src/metrics.js';
import { PluginManager } from '../../src/plugins.js';
import { createRedis } from '../../src/redis.js';
import { ConfigReloader } from '../../src/reload.js';
import { buildServer } from '../../src/server.js';
import { routeInputSchema } from '../../src/routing.js';
import { setupTestDb } from './setup.js';
import type { Pool } from 'pg';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const DB_NAME = 'gateway_test_e2e';

let pool: Pool;
let upstreamA = '';
let upstreamB = '';
const httpServers: Server[] = [];

/** One running gateway instance, wired exactly like production (index.ts). */
interface Instance {
  app: FastifyInstance;
  store: ConfigStore;
  redis: Redis;
  publisher: Redis;
  subscriber: Redis;
  reloader: ConfigReloader;
  token: string;
}

const instances: Instance[] = [];

function startUpstream(id: string): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': id });
      res.end(JSON.stringify({ upstream: id }));
    });
    server.listen(0, '127.0.0.1', () => {
      httpServers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function spawnInstance(): Promise<Instance> {
  const config = loadConfig();
  const redis = createRedis(REDIS_URL);
  const publisher = createRedis(REDIS_URL);
  const subscriber = createRedis(REDIS_URL);
  await redis.ping();
  const store = new ConfigStore(await loadSnapshot(pool));
  const reloader = new ConfigReloader(store, pool, subscriber, { pollIntervalMs: 15_000 });
  await reloader.start();
  const app = await buildServer({
    config,
    pool,
    redis,
    publisher,
    store,
    plugins: new PluginManager(),
    metrics: new MetricsRegistry(),
    breakers: new CircuitBreakerRegistry(),
    auth: { jwtSecret: config.jwtSecret, tokenTtlSec: 3600 },
    audit: new AuditService(pool),
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.local', password: 'password-123456' },
  });
  const instance: Instance = {
    app,
    store,
    redis,
    publisher,
    subscriber,
    reloader,
    token: login.json<{ token: string }>().token,
  };
  instances.push(instance);
  return instance;
}

function authHeader(instance: Instance): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${instance.token}` } };
}

beforeAll(async () => {
  pool = await setupTestDb(DB_NAME);
  process.env['DATABASE_URL'] = `postgres://gateway:gateway@localhost:5432/${DB_NAME}`;
  process.env['REDIS_URL'] = REDIS_URL;
  process.env['JWT_SECRET'] = 'test-secret-at-least-32-chars-long!!';
  process.env['SSRF_DEV_ALLOWLIST'] = '127.0.0.1';

  upstreamA = await startUpstream('A');
  upstreamB = await startUpstream('B');

  const passwordHash = await hashPassword('password-123456');
  await createUser(pool, { email: 'admin@example.local', passwordHash, role: 'admin' });

  const base = {
    methods: ['GET'],
    enabled: true,
    priority: 100,
    authRequired: false,
    stripPathPrefix: true,
  };
  await insertRoute(
    pool,
    routeInputSchema.parse({
      ...base,
      name: 'shop',
      pathPattern: '/shop/*',
      upstreamUrl: upstreamA,
    }),
  );
  await insertRoute(
    pool,
    routeInputSchema.parse({
      ...base,
      name: 'control',
      pathPattern: '/control/*',
      upstreamUrl: upstreamA,
    }),
  );
  await bumpVersion(pool, 'test', 'e2e seed');
}, 90_000);

afterAll(async () => {
  for (const i of instances) {
    await i.reloader.stop();
    await i.app.close();
    i.redis.disconnect();
    i.publisher.disconnect();
    i.subscriber.disconnect();
  }
  for (const s of httpServers) s.close();
  await pool.end();
});

async function proxied(instance: Instance, path: string) {
  return instance.app.inject({ method: 'GET', url: path });
}

describe('zero-downtime route reconfiguration (11 steps)', () => {
  let inst: Instance;
  let routeId: string;

  it('spawns the instance and reads the seeded route id', async () => {
    inst = await spawnInstance();
    const res = await inst.app.inject({ method: 'GET', url: '/api/routes', ...authHeader(inst) });
    expect(res.statusCode).toBe(200);
    const routes = res.json<{ routes: Array<{ id: string; name: string }> }>().routes;
    routeId = routes.find((r) => r.name === 'shop')?.id ?? '';
    expect(routeId).not.toBe('');
    expect(inst.store.version()).toBe(1);
  });

  it('step 1: traffic flows to upstream A', async () => {
    const res = await proxied(inst, '/shop/items');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream']).toBe('A');
  });

  it('step 2: config version starts at 1', async () => {
    const res = await inst.app.inject({
      method: 'GET',
      url: '/api/config/version',
      ...authHeader(inst),
    });
    expect(res.json<{ version: number }>().version).toBe(1);
  });

  it('step 3: admin repoints the route at upstream B, version bumps', async () => {
    const res = await inst.app.inject({
      method: 'PUT',
      url: `/api/routes/${routeId}`,
      ...authHeader(inst),
      payload: { upstreamUrl: upstreamB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ version: number }>().version).toBe(2);
  });

  it('step 4: the instance picks up the new config without a restart', async () => {
    await waitFor(() => inst.store.version() === 2);
    const res = await proxied(inst, '/shop/items');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream']).toBe('B');
  });

  it('step 5: a burst of requests during the next swap all succeed', async () => {
    const swap = await inst.app.inject({
      method: 'PUT',
      url: `/api/routes/${routeId}`,
      ...authHeader(inst),
      payload: { upstreamUrl: upstreamA },
    });
    expect(swap.json<{ version: number }>().version).toBe(3);
    // Fire traffic immediately, mid-reload: every request must succeed
    // (served by A or B), none may 500/404/503.
    const burst = await Promise.all(Array.from({ length: 30 }, () => proxied(inst, '/shop/items')));
    for (const res of burst) {
      expect(res.statusCode).toBe(200);
      expect(['A', 'B']).toContain(res.headers['x-upstream']);
    }
    await waitFor(() => inst.store.version() === 3);
    const after = await proxied(inst, '/shop/items');
    expect(after.headers['x-upstream']).toBe('A');
  });

  it('step 6: disabling the route 404s without touching anything else', async () => {
    const res = await inst.app.inject({
      method: 'PUT',
      url: `/api/routes/${routeId}`,
      ...authHeader(inst),
      payload: { enabled: false },
    });
    expect(res.json<{ version: number }>().version).toBe(4);
    await waitFor(() => inst.store.version() === 4);
    const gone = await proxied(inst, '/shop/items');
    expect(gone.statusCode).toBe(404);
  });

  it('step 7: the control route keeps serving while shop is disabled', async () => {
    const res = await proxied(inst, '/control/ping');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream']).toBe('A');
  });

  it('step 8: re-enabling the route restores traffic', async () => {
    const res = await inst.app.inject({
      method: 'PUT',
      url: `/api/routes/${routeId}`,
      ...authHeader(inst),
      payload: { enabled: true },
    });
    expect(res.json<{ version: number }>().version).toBe(5);
    await waitFor(() => inst.store.version() === 5);
    const back = await proxied(inst, '/shop/items');
    expect(back.statusCode).toBe(200);
    expect(back.headers['x-upstream']).toBe('A');
  });

  it('step 9: deleting the route 404s and bumps the version', async () => {
    const res = await inst.app.inject({
      method: 'DELETE',
      url: `/api/routes/${routeId}`,
      ...authHeader(inst),
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => inst.store.version() === 6);
    const gone = await proxied(inst, '/shop/items');
    expect(gone.statusCode).toBe(404);
  });

  it('step 10: every mutation advanced the config version', async () => {
    const res = await inst.app.inject({
      method: 'GET',
      url: '/api/config/version',
      ...authHeader(inst),
    });
    expect(res.json<{ version: number }>().version).toBe(6);
  });

  it('step 11: the audit log records the route mutations', async () => {
    const res = await inst.app.inject({ method: 'GET', url: '/api/audit', ...authHeader(inst) });
    expect(res.statusCode).toBe(200);
    const actions = res
      .json<{
        records: Array<{ action: string; resourceType: string; resourceId: string | null }>;
      }>()
      .records.filter((r) => r.resourceType === 'route' && r.resourceId === routeId)
      .map((r) => r.action);
    expect(actions).toContain('route.update');
    expect(actions).toContain('route.delete');
    expect(actions.filter((a) => a === 'route.update').length).toBeGreaterThanOrEqual(4);
  });
});

describe('two gateway instances converge on config changes', () => {
  let a: Instance;
  let b: Instance;

  it('spawns a second instance; both agree on version 6', async () => {
    a = instances[0] as Instance;
    b = await spawnInstance();
    expect(b.store.version()).toBe(6);
    expect(a.store.version()).toBe(6);
  });

  it('a route created via instance A is served by instance B', async () => {
    const created = await a.app.inject({
      method: 'POST',
      url: '/api/routes',
      ...authHeader(a),
      payload: {
        name: 'converge',
        pathPattern: '/conv/*',
        methods: ['GET'],
        upstreamUrl: upstreamA,
        enabled: true,
        priority: 100,
        authRequired: false,
        stripPathPrefix: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ version: number }>().version).toBe(7);

    await waitFor(() => b.store.version() === 7);
    const res = await proxied(b, '/conv/x');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream']).toBe('A');
  });

  it('an update via instance B converges back onto instance A', async () => {
    const routes = await b.app.inject({ method: 'GET', url: '/api/routes', ...authHeader(b) });
    const routeId = routes
      .json<{ routes: Array<{ id: string; name: string }> }>()
      .routes.find((r) => r.name === 'converge')?.id;
    expect(routeId).toBeDefined();

    const updated = await b.app.inject({
      method: 'PUT',
      url: `/api/routes/${routeId as string}`,
      ...authHeader(b),
      payload: { upstreamUrl: upstreamB },
    });
    expect(updated.json<{ version: number }>().version).toBe(8);

    await waitFor(() => a.store.version() === 8);
    const res = await proxied(a, '/conv/x');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream']).toBe('B');
  });

  it('both instances report the same config version', async () => {
    const va = await a.app.inject({ method: 'GET', url: '/api/config/version', ...authHeader(a) });
    const vb = await b.app.inject({ method: 'GET', url: '/api/config/version', ...authHeader(b) });
    expect(va.json<{ version: number }>().version).toBe(8);
    expect(vb.json<{ version: number }>().version).toBe(8);
  });
});
