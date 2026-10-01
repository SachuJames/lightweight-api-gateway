import { describe, expect, it } from 'vitest';
import { ConfigStore, loadSnapshot } from '../../src/config-service.js';

/** Minimal stub of pg's queryable: matches queries by a substring key. */
function stubClient(routes: unknown[], version: number) {
  return {
    query: async (sql: string) => {
      if (sql.includes('config_versions')) return { rows: [{ v: version }] };
      if (sql.includes('FROM routes')) return { rows: routes };
      if (sql.includes('rate_limit_policies')) return { rows: [] };
      if (sql.includes('circuit_breaker_policies')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as never;
}

function routeRow(id: string, pattern: string, priority: number) {
  return {
    id,
    name: id,
    path_pattern: pattern,
    methods: ['GET'],
    upstream_url: 'http://x:3001',
    enabled: true,
    priority,
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

describe('loadSnapshot', () => {
  it('loads versioned, compiled routes from the database', async () => {
    const client = stubClient([routeRow('r1', '/api/users/*', 100)], 3);
    const snap = await loadSnapshot(client);
    expect(snap.version).toBe(3);
    expect(snap.routes).toHaveLength(1);
    expect(snap.routes[0]?.route.pathPattern).toBe('/api/users/*');
    expect(snap.routes[0]?.regex.test('/api/users/1')).toBe(true);
  });
});

describe('ConfigStore', () => {
  it('starts empty at version 0 and swaps snapshots on refresh', async () => {
    const store = ConfigStore.empty();
    expect(store.version()).toBe(0);
    expect(store.current().routes).toHaveLength(0);

    const before = store.current();
    const { from, to } = await store.refresh(stubClient([routeRow('r1', '/a/*', 1)], 1));
    expect(from).toBe(0);
    expect(to).toBe(1);
    expect(store.version()).toBe(1);
    expect(store.current()).not.toBe(before); // swapped reference
    expect(store.current().routes).toHaveLength(1);

    // Readers that grabbed the old reference keep seeing the old snapshot.
    expect(before.routes).toHaveLength(0);
  });
});
