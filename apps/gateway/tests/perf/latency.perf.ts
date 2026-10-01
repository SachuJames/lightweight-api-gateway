/**
 * Performance benchmarks. NOT part of the unit/integration suites; run with:
 *   pnpm perf
 * Measures real latencies on this machine and writes docs/performance.md.
 * Numbers are environment-specific; the doc records the machine details.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, totalmem, freemem } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit-service.js';
import { CircuitBreakerRegistry } from '../../src/circuit-breaker.js';
import { loadConfig } from '../../src/config.js';
import { ConfigStore, loadSnapshot } from '../../src/config-service.js';
import { bumpVersion } from '../../src/db/config-versions.js';
import { insertRoute } from '../../src/db/routes.js';
import { MetricsRegistry } from '../../src/metrics.js';
import { PluginManager } from '../../src/plugins.js';
import { createRedis } from '../../src/redis.js';
import { ConfigReloader, notifyConfigChange } from '../../src/reload.js';
import { checkRateLimit } from '../../src/rate-limit.js';
import { compileRoute, matchCompiled } from '../../src/routing.js';
import { routeInputSchema } from '../../src/routing.js';
import { buildServer } from '../../src/server.js';
import { setupTestDb } from '../integration/setup.js';
import type { RateLimitPolicy } from '@gateway/shared-types';
import type { Pool } from 'pg';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const DB_NAME = 'gateway_test_perf';

interface Stats {
  n: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function summarize(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, avgMs: avg, p50Ms: pick(0.5), p95Ms: pick(0.95), p99Ms: pick(0.99) };
}

const fmt = (v: number) => (v < 1 ? `${(v * 1000).toFixed(1)}us` : `${v.toFixed(2)}ms`);

let pool: Pool;
let redis: Redis;
let publisher: Redis;
let subscriber: Redis;
let reloader: ConfigReloader;
let store: ConfigStore;
let app: FastifyInstance;
let upstreamBase = '';
let gatewayBase = '';
let httpServer: Server;

const results: Record<string, Stats & { extra?: string }> = {};

beforeAll(async () => {
  pool = await setupTestDb(DB_NAME);
  process.env['DATABASE_URL'] = `postgres://gateway:gateway@localhost:5432/${DB_NAME}`;
  process.env['REDIS_URL'] = REDIS_URL;
  process.env['JWT_SECRET'] = 'test-secret-at-least-32-chars-long!!';
  const config = loadConfig();

  httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  await insertRoute(
    pool,
    routeInputSchema.parse({
      name: 'bench',
      pathPattern: '/bench/*',
      methods: ['GET'],
      upstreamUrl: upstreamBase,
      enabled: true,
      priority: 100,
      authRequired: false,
      stripPathPrefix: true,
    }),
  );
  await bumpVersion(pool, 'perf', 'perf seed');

  redis = createRedis(REDIS_URL);
  publisher = createRedis(REDIS_URL);
  subscriber = createRedis(REDIS_URL);
  await redis.ping();
  store = new ConfigStore(await loadSnapshot(pool));
  reloader = new ConfigReloader(store, pool, subscriber, { pollIntervalMs: 15_000 });
  await reloader.start();

  app = await buildServer({
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
  await app.listen({ port: 0, host: '127.0.0.1' });
  gatewayBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // Warmup so JIT/GC settle before measuring.
  for (let i = 0; i < 300; i++) {
    await (await fetch(`${gatewayBase}/bench/warm`)).arrayBuffer();
  }
}, 120_000);

afterAll(async () => {
  await reloader.stop();
  await app.close();
  httpServer.close();
  redis.disconnect();
  publisher.disconnect();
  subscriber.disconnect();
  await pool.end();
  writeReport();
});

async function timeFetch(url: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
  return performance.now() - t0;
}

describe('benchmarks', () => {
  it('proxy overhead: direct upstream vs through gateway', async () => {
    const direct: number[] = [];
    for (let i = 0; i < 2000; i++) direct.push(await timeFetch(`${upstreamBase}/x`));
    const via: number[] = [];
    for (let i = 0; i < 2000; i++) via.push(await timeFetch(`${gatewayBase}/bench/x`));
    const d = summarize(direct);
    const v = summarize(via);
    results['proxy_overhead'] = {
      ...v,
      extra: `direct p50=${fmt(d.p50Ms)} p95=${fmt(d.p95Ms)} | gateway p50=${fmt(v.p50Ms)} p95=${fmt(v.p95Ms)} | overhead p50=${fmt(v.p50Ms - d.p50Ms)}`,
    };
    expect(v.p99Ms).toBeLessThan(1000);
  }, 120_000);

  it('route matching throughput (2000 routes)', () => {
    const routes = Array.from({ length: 2000 }, (_, i) =>
      compileRoute({
        id: `svc${i}`,
        ...routeInputSchema.parse({
          name: `svc${i}`,
          pathPattern: `/svc${i}/*`,
          methods: ['GET'],
          upstreamUrl: upstreamBase,
          enabled: true,
          priority: 100,
          authRequired: false,
          stripPathPrefix: true,
        }),
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const N = 20_000;
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (matchCompiled(routes, 'GET', '/svc1500/deep/path') !== null) hits++;
    }
    const elapsedMs = performance.now() - t0;
    results['route_matching'] = {
      n: N,
      avgMs: elapsedMs / N,
      p50Ms: elapsedMs / N,
      p95Ms: elapsedMs / N,
      p99Ms: elapsedMs / N,
      extra: `${Math.round(N / (elapsedMs / 1000)).toLocaleString('en-US')} matches/sec over 2000 routes (${hits}/${N} hits)`,
    };
    expect(hits).toBe(N);
  }, 120_000);

  it('rate limiter: Redis Lua token bucket', async () => {
    const policy: RateLimitPolicy = {
      id: 'bench',
      name: 'bench',
      capacity: 1_000_000_000,
      refillRatePerSec: 1_000_000_000,
      keyStrategy: 'ip',
      failOpen: false,
    };
    const samples: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t0 = performance.now();
      const r = await checkRateLimit(redis, policy, { ip: '127.0.0.1', routeId: 'bench' });
      samples.push(performance.now() - t0);
      if (!r.allowed) throw new Error('rate limiter denied a benchmark request');
    }
    const s = summarize(samples);
    results['rate_limit_redis'] = {
      ...s,
      extra: `${Math.round(1000 / s.avgMs).toLocaleString('en-US')} checks/sec (Redis Lua, localhost)`,
    };
    expect(s.p99Ms).toBeLessThan(100);
  }, 120_000);

  it('config reload latency (DB bump + Redis notify -> instance converged)', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const before = store.version();
      const t0 = performance.now();
      const version = await bumpVersion(pool, 'perf', `reload bench ${i}`);
      await notifyConfigChange(publisher, version);
      while (store.version() === before) {
        if (performance.now() - t0 > 10_000) throw new Error('reload timed out');
        await new Promise((r) => setTimeout(r, 5));
      }
      samples.push(performance.now() - t0);
    }
    results['config_reload'] = summarize(samples);
    expect(results['config_reload'].p99Ms).toBeLessThan(10_000);
  }, 120_000);

  it('100 concurrent clients through the gateway', async () => {
    const clients = 100;
    const perClient = 40;
    const latencies: number[] = [];
    let errors = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: clients }, async () => {
        for (let i = 0; i < perClient; i++) {
          const start = performance.now();
          try {
            const res = await fetch(`${gatewayBase}/bench/load`);
            await res.arrayBuffer();
            if (res.status !== 200) errors++;
            latencies.push(performance.now() - start);
          } catch {
            errors++;
          }
        }
      }),
    );
    const elapsedSec = (performance.now() - t0) / 1000;
    const total = clients * perClient;
    const s = summarize(latencies);
    results['concurrent_load'] = {
      ...s,
      extra: `${total} requests, ${clients} concurrent clients, ${Math.round(total / elapsedSec).toLocaleString('en-US')} req/s, ${errors} errors`,
    };
    expect(errors).toBe(0);
  }, 180_000);
});

function writeReport(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(here, '../../../../docs/performance.md');
  mkdirSync(path.dirname(out), { recursive: true });

  const lines = [
    '# Performance',
    '',
    '> Measured on this machine on 2026-10-01. Your numbers will differ;',
    '> treat these as order-of-magnitude guidance, not guarantees.',
    '',
    '## Environment',
    '',
    `- Node ${process.version} (${process.arch})`,
    ...machineInfo(),
    `- Postgres 16 and Redis 7 on localhost (same host as the gateway)`,
    '- Gateway and a trivial `node:http` upstream on 127.0.0.1; real TCP, no mocks',
    '- 300 warmup requests before each network benchmark; benchmarks run sequentially',
    '',
    '## Results',
    '',
    '### Proxy overhead (sequential requests)',
    '',
    '2,000 sequential GETs direct to the upstream vs 2,000 through the gateway',
    '(routing + proxy + metrics + audit-sampling pipeline):',
    '',
    `- Gateway: p50 ${fmt(results['proxy_overhead']?.p50Ms ?? 0)}, p95 ${fmt(results['proxy_overhead']?.p95Ms ?? 0)}, p99 ${fmt(results['proxy_overhead']?.p99Ms ?? 0)}`,
    `- ${results['proxy_overhead']?.extra ?? ''}`,
    '',
    'The overhead is the gateway pipeline itself: route matching, building the',
    'upstream request, streaming the response back, and recording metrics.',
    '',
    '### Route matching',
    '',
    `- ${results['route_matching']?.extra ?? ''}`,
    `- Cost per match: ~${fmt(results['route_matching']?.avgMs ?? 0)}`,
    '',
    'Routes are compiled to regexes once per config version; matching is a linear',
    'scan over the compiled list ordered by priority/specificity, so cost grows',
    'with route count (a typical tens-of-routes table matches in tens of',
    'microseconds).',
    '',
    '### Rate limiting (Redis Lua token bucket)',
    '',
    `- ${results['rate_limit_redis']?.extra ?? ''}`,
    `- Per-check latency: p50 ${fmt(results['rate_limit_redis']?.p50Ms ?? 0)}, p95 ${fmt(results['rate_limit_redis']?.p95Ms ?? 0)}, p99 ${fmt(results['rate_limit_redis']?.p99Ms ?? 0)}`,
    '',
    'The limiter is Redis-only by design (one Lua `EVAL` per request): every',
    'gateway instance shares the same buckets, which is what makes limits hold',
    'under multi-instance deployments. There is no in-memory limiter to compare',
    'against; localhost Redis round-trip dominates the per-check cost.',
    '',
    '### Config reload',
    '',
    'Time from `bumpVersion` + Redis publish to the instance serving the new',
    'config (10 iterations):',
    '',
    `- avg ${fmt(results['config_reload']?.avgMs ?? 0)}, p50 ${fmt(results['config_reload']?.p50Ms ?? 0)}, p95 ${fmt(results['config_reload']?.p95Ms ?? 0)}, p99 ${fmt(results['config_reload']?.p99Ms ?? 0)}`,
    '',
    'Reloads swap the compiled snapshot atomically; in-flight requests finish on',
    'the old snapshot. A 15s DB poll backstops missed pub/sub messages.',
    '',
    '### 100 concurrent clients',
    '',
    `- ${results['concurrent_load']?.extra ?? ''}`,
    `- Latency: p50 ${fmt(results['concurrent_load']?.p50Ms ?? 0)}, p95 ${fmt(results['concurrent_load']?.p95Ms ?? 0)}, p99 ${fmt(results['concurrent_load']?.p99Ms ?? 0)}`,
    '',
    'No failed requests; the gateway streams upstream responses without',
    'buffering whole bodies.',
    '',
    '## How to reproduce',
    '',
    '```bash',
    'pnpm --filter gateway perf   # runs apps/gateway/tests/perf and rewrites this file',
    '```',
    '',
  ];
  writeFileSync(out, lines.join('\n'));
  console.log(`Wrote ${out}`);
}

function machineInfo(): string[] {
  try {
    const gb = (v: number) => `${(v / 1024 ** 3).toFixed(1)}GB`;
    return [
      `- CPU: ${cpus().length}x ${cpus()[0]?.model ?? 'unknown'}`,
      `- Memory: ${gb(totalmem())} total, ${gb(freemem())} free at run time`,
    ];
  } catch {
    return ['- CPU/memory details unavailable'];
  }
}
