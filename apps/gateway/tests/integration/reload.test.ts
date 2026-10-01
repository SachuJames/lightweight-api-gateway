import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/config-service.js';
import { createRedis } from '../../src/redis.js';
import { ConfigReloader, notifyConfigChange } from '../../src/reload.js';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';

function routeRow(id: string, pattern: string) {
  return {
    id,
    name: id,
    path_pattern: pattern,
    methods: ['GET'],
    upstream_url: 'http://x:3001',
    enabled: true,
    priority: 100,
    auth_required: false,
    rate_limit_policy_id: null,
    circuit_breaker_policy_id: null,
    timeout_ms: 30_000,
    plugin_config: {},
    version: 1,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

/** Stub DB whose visible config version the test can advance. */
function stubClient() {
  const versions: Record<number, unknown[]> = {
    1: [routeRow('r1', '/api/v1/*')],
    2: [routeRow('r1', '/api/v1/*'), routeRow('r2', '/api/v2/*')],
  };
  let current = 1;
  return {
    setVersion: (v: number) => {
      current = v;
    },
    query: async (sql: string) => {
      if (sql.includes('config_versions')) return { rows: [{ v: current }] };
      if (sql.includes('FROM routes')) return { rows: versions[current] ?? [] };
      if (sql.includes('rate_limit_policies')) return { rows: [] };
      if (sql.includes('circuit_breaker_policies')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

let publisher: Redis;

beforeAll(async () => {
  publisher = createRedis(REDIS_URL);
  await publisher.ping();
});

afterAll(async () => {
  await publisher.quit();
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ConfigReloader', () => {
  it('converges two instances on a single notification', async () => {
    const db = stubClient();
    const storeA = ConfigStore.empty();
    const storeB = ConfigStore.empty();
    await storeA.refresh(db as never);
    await storeB.refresh(db as never);
    expect(storeA.version()).toBe(1);

    const reloads: Array<[number, number]> = [];
    const subA = createRedis(REDIS_URL);
    const subB = createRedis(REDIS_URL);
    const reloaderA = new ConfigReloader(storeA, db as never, subA, {
      pollIntervalMs: 0,
      onReload: (f, t) => reloads.push([f, t]),
    });
    const reloaderB = new ConfigReloader(storeB, db as never, subB, { pollIntervalMs: 0 });
    await reloaderA.start();
    await reloaderB.start();

    try {
      db.setVersion(2);
      await notifyConfigChange(publisher, 2);
      await waitFor(() => storeA.version() === 2 && storeB.version() === 2);
      expect(storeA.current().routes).toHaveLength(2);
      expect(storeB.current().routes).toHaveLength(2);
      expect(reloads).toEqual([[1, 2]]);
    } finally {
      await reloaderA.stop();
      await reloaderB.stop();
      subA.disconnect();
      subB.disconnect();
    }
  });

  it('ignores stale versions and malformed messages', async () => {
    const db = stubClient();
    const store = ConfigStore.empty();
    await store.refresh(db as never);
    const sub = createRedis(REDIS_URL);
    let reloads = 0;
    const reloader = new ConfigReloader(store, db as never, sub, {
      pollIntervalMs: 0,
      onReload: () => {
        reloads += 1;
      },
    });
    await reloader.start();
    try {
      await notifyConfigChange(publisher, 1); // not newer
      await publisher.publish('gateway:config:reload', 'not-json');
      await new Promise((r) => setTimeout(r, 300));
      expect(store.version()).toBe(1);
      expect(reloads).toBe(0);
    } finally {
      await reloader.stop();
      sub.disconnect();
    }
  });

  it('catches up via the poll backstop when a message is missed', async () => {
    const db = stubClient();
    const store = ConfigStore.empty();
    await store.refresh(db as never);
    const sub = createRedis(REDIS_URL);
    const reloader = new ConfigReloader(store, db as never, sub, { pollIntervalMs: 100 });
    await reloader.start();
    try {
      db.setVersion(2); // no publish: simulate a missed message
      await waitFor(() => store.version() === 2);
      expect(store.current().routes).toHaveLength(2);
    } finally {
      await reloader.stop();
      sub.disconnect();
    }
  });
});
