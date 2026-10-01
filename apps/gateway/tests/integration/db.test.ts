import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withTransaction } from '../../src/db.js';
import { appendAudit, listAudit } from '../../src/db/audit.js';
import { bumpVersion, getCurrentVersion } from '../../src/db/config-versions.js';
import {
  deleteRoute,
  getRoute,
  insertRoute,
  listRoutes,
  policyExists,
  updateRoute,
} from '../../src/db/routes.js';
import { createUser, getUserByEmail } from '../../src/db/users.js';
import { routeInputSchema } from '../../src/routing.js';

const TEST_DB = process.env['TEST_DATABASE_URL'] ?? 'postgres://gateway:gateway@localhost:5432/gateway_test';
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

let pool: Pool;

beforeAll(async () => {
  // Create the test database if it does not exist.
  const admin = new Pool({ connectionString: 'postgres://gateway:gateway@localhost:5432/postgres' });
  try {
    await admin.query('CREATE DATABASE gateway_test');
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }
  // Fresh schema for every run.
  const fresh = new Pool({ connectionString: TEST_DB });
  try {
    await fresh.query('DROP SCHEMA public CASCADE');
    await fresh.query('CREATE SCHEMA public');
  } finally {
    await fresh.end();
  }
  await runner({ databaseUrl: TEST_DB, dir: migrationsDir, direction: 'up', migrationsTable: 'pgmigrations' });
  pool = getPool({ databaseUrl: TEST_DB });
}, 60_000);

beforeEach(async () => {
  await pool.query(
    'TRUNCATE routes, users, audit_logs, config_versions, rate_limit_policies, circuit_breaker_policies CASCADE',
  );
});

afterAll(async () => {
  await closePool();
});

const validRoute = {
  name: 'users',
  pathPattern: '/api/users/*',
  methods: ['GET', 'POST'],
  upstreamUrl: 'http://users-service:3001/',
};

describe('routes repository', () => {
  it('inserts, reads, updates, and deletes a route', async () => {
    const created = await insertRoute(pool, routeInputSchema.parse(validRoute));
    expect(created.upstreamUrl).toBe('http://users-service:3001'); // trailing slash stripped
    expect(created.version).toBe(1);

    const fetched = await getRoute(pool, created.id);
    expect(fetched?.name).toBe('users');

    const updated = await updateRoute(pool, created.id, { priority: 500, enabled: false });
    expect(updated?.priority).toBe(500);
    expect(updated?.enabled).toBe(false);
    expect(updated?.version).toBe(2);

    const deleted = await deleteRoute(pool, created.id);
    expect(deleted?.id).toBe(created.id);
    expect(await getRoute(pool, created.id)).toBeNull();
  });

  it('lists routes ordered by priority then pattern', async () => {
    await insertRoute(pool, routeInputSchema.parse({ ...validRoute, name: 'low', pathPattern: '/b/*', priority: 1 }));
    await insertRoute(pool, routeInputSchema.parse({ ...validRoute, name: 'high', pathPattern: '/a/*', priority: 999 }));
    const routes = await listRoutes(pool);
    expect(routes.map((r) => r.name)).toEqual(['high', 'low']);
  });

  it('returns null for unknown ids', async () => {
    expect(await getRoute(pool, '00000000-0000-0000-0000-000000000099')).toBeNull();
    expect(await updateRoute(pool, '00000000-0000-0000-0000-000000000099', { priority: 1 })).toBeNull();
  });
});

describe('transactions', () => {
  it('rolls back the whole transaction on error', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await insertRoute(client, routeInputSchema.parse(validRoute));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await listRoutes(pool)).toHaveLength(0);
  });

  it('commits when the callback succeeds', async () => {
    await withTransaction(pool, async (client) => {
      await insertRoute(client, routeInputSchema.parse(validRoute));
    });
    expect(await listRoutes(pool)).toHaveLength(1);
  });
});

describe('policies', () => {
  it('policyExists detects seeded ids', async () => {
    await pool.query(
      `INSERT INTO rate_limit_policies (id, name, capacity, refill_rate_per_sec, key_strategy)
       VALUES ('00000000-0000-0000-0000-0000000000a1', 'x', 10, 1, 'ip')`,
    );
    expect(await policyExists(pool, 'rate_limit_policies', '00000000-0000-0000-0000-0000000000a1')).toBe(true);
    expect(await policyExists(pool, 'rate_limit_policies', '00000000-0000-0000-0000-0000000000a2')).toBe(false);
  });
});

describe('users', () => {
  it('creates and fetches a user by email (case-insensitive)', async () => {
    await createUser(pool, { email: 'Admin@Example.Local', passwordHash: 'hash', role: 'admin' });
    const user = await getUserByEmail(pool, 'admin@example.local');
    expect(user?.role).toBe('admin');
    expect(user?.email).toBe('admin@example.local');
  });
});

describe('audit log', () => {
  it('appends and filters records; never updates', async () => {
    await appendAudit(pool, { actor: 'admin@example.local', action: 'route.create', resourceType: 'route', resourceId: 'r1' });
    await appendAudit(pool, { actor: 'admin@example.local', action: 'route.delete', resourceType: 'route', resourceId: 'r1' });
    const { records, total } = await listAudit(pool, { resourceType: 'route', resourceId: 'r1' });
    expect(total).toBe(2);
    expect(records[0]?.action).toBe('route.delete'); // newest first
    const filtered = await listAudit(pool, { action: 'route.create' });
    expect(filtered.total).toBe(1);
  });
});

describe('config versions', () => {
  it('bumps monotonically', async () => {
    expect(await getCurrentVersion(pool)).toBe(0);
    expect(await bumpVersion(pool, 'tester', 'v1')).toBe(1);
    expect(await bumpVersion(pool, 'tester', 'v2')).toBe(2);
    expect(await getCurrentVersion(pool)).toBe(2);
  });
});
