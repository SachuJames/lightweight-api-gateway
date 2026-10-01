import { describe, expect, it } from 'vitest';
import { liveness, readiness } from '../../src/health.js';
import { MetricsRegistry } from '../../src/metrics.js';

describe('MetricsRegistry', () => {
  it('counts with labels', () => {
    const m = new MetricsRegistry();
    m.inc('reqs', { route: 'a', method: 'GET' });
    m.inc('reqs', { route: 'a', method: 'GET' }, 2);
    m.inc('reqs', { route: 'b', method: 'GET' });
    const snap = m.snapshot();
    expect(snap.counters['reqs{method="GET",route="a"}']).toBe(3);
    expect(snap.counters['reqs{method="GET",route="b"}']).toBe(1);
  });

  it('computes latency stats', () => {
    const m = new MetricsRegistry();
    for (let i = 1; i <= 100; i++) m.observeLatency('d', { route: 'a' }, i);
    const stats = m.snapshot().latencies['d{route="a"}'];
    expect(stats?.count).toBe(100);
    expect(stats?.min).toBe(1);
    expect(stats?.max).toBe(100);
    expect(stats?.avg).toBe(50.5);
    expect(stats?.p50).toBe(50);
    expect(stats?.p95).toBe(95);
    expect(stats?.p99).toBe(99);
  });

  it('bounds memory: caps series and samples', () => {
    const m = new MetricsRegistry({ maxSeries: 10, maxSamples: 5 });
    for (let i = 0; i < 50; i++) m.inc('c', { i: String(i) });
    expect(m.seriesCount()).toBeLessThanOrEqual(10);
    for (let i = 0; i < 50; i++) m.observeLatency('l', {}, i);
    const stats = m.snapshot().latencies['l'];
    expect(stats?.count).toBe(5);
    expect(stats?.min).toBe(45);
  });

  it('resets cleanly', () => {
    const m = new MetricsRegistry();
    m.inc('c');
    m.observeLatency('l', {}, 1);
    m.reset();
    expect(m.seriesCount()).toBe(0);
    expect(m.snapshot().counters).toEqual({});
  });
});

describe('health', () => {
  it('liveness is always ok', () => {
    expect(liveness()).toEqual({ statusCode: 200, body: { status: 'ok' } });
  });

  it('readiness is 200 when dependencies are reachable', async () => {
    const r = await readiness(
      { database: async () => true, redis: async () => true },
      { configVersion: 7, uptimeSec: 42 },
    );
    expect(r.ok).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', configVersion: 7, uptimeSec: 42 });
  });

  it('readiness is 503 when a dependency is down', async () => {
    const r = await readiness(
      { database: async () => true, redis: async () => false },
      { configVersion: 7, uptimeSec: 42 },
    );
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(503);
    expect(r.body.checks).toEqual({ database: 'ok', redis: 'unreachable' });
  });
});
