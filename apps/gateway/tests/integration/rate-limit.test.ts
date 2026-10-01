import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RateLimitPolicy } from '@gateway/shared-types';
import { checkRateLimit } from '../../src/rate-limit.js';
import { checkRedis, createRedis } from '../../src/redis.js';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';

let redis: Redis;

beforeAll(async () => {
  redis = createRedis(REDIS_URL);
  await redis.ping();
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

function policy(overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    name: 'test',
    capacity: 3,
    refillRatePerSec: 10,
    keyStrategy: 'route_ip',
    failOpen: true,
    ...overrides,
  };
}

const parts = { ip: '9.9.9.9', routeId: 'route-x' };

describe('token bucket', () => {
  it('allows capacity requests, then denies with a retry hint', async () => {
    const p = policy();
    const k = { ...parts, routeId: p.id };
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(redis, p, k);
      expect(r.allowed).toBe(true);
      expect(r.degraded).toBe(false);
    }
    const denied = await checkRateLimit(redis, p, k);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills tokens over time', async () => {
    const p = policy({ capacity: 1, refillRatePerSec: 5 });
    const k = { ...parts, routeId: p.id };
    expect((await checkRateLimit(redis, p, k)).allowed).toBe(true);
    expect((await checkRateLimit(redis, p, k)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 300)); // ~1.5 tokens refill
    expect((await checkRateLimit(redis, p, k)).allowed).toBe(true);
  });

  it('isolates buckets per key', async () => {
    const p = policy({ capacity: 1 });
    const k1 = { ...parts, routeId: p.id, ip: '1.1.1.1' };
    const k2 = { ...parts, routeId: p.id, ip: '2.2.2.2' };
    expect((await checkRateLimit(redis, p, k1)).allowed).toBe(true);
    expect((await checkRateLimit(redis, p, k1)).allowed).toBe(false);
    expect((await checkRateLimit(redis, p, k2)).allowed).toBe(true);
  });

  it('rejects a misconfigured policy', async () => {
    await expect(checkRateLimit(redis, policy({ capacity: 0 }), parts)).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });
});

describe('redis outage', () => {
  it('fails open when the policy allows it', async () => {
    const dead = new Redis('redis://localhost:6399', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy: () => null,
    });
    try {
      const r = await checkRateLimit(dead, policy({ failOpen: true }), parts);
      expect(r.allowed).toBe(true);
      expect(r.degraded).toBe(true);
    } finally {
      dead.disconnect();
    }
  });

  it('fails closed when the policy requires it', async () => {
    const dead = new Redis('redis://localhost:6399', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy: () => null,
    });
    try {
      await expect(checkRateLimit(dead, policy({ failOpen: false }), parts)).rejects.toMatchObject({
        code: 'REDIS_ERROR',
        statusCode: 503,
      });
    } finally {
      dead.disconnect();
    }
  });
});

describe('checkRedis', () => {
  it('returns true for a live server', async () => {
    expect(await checkRedis(redis)).toBe(true);
  });
});
