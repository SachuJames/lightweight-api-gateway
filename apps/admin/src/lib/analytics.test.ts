import { describe, expect, it } from 'vitest';
import type { MetricsSnapshot } from '@gateway/shared-types';
import {
  formatMs,
  formatPct,
  parseSeriesKey,
  perRouteTraffic,
  requestsPerSecond,
  summarizeMetrics,
} from '../lib/analytics';
import type { AnalyticsSnapshot } from '@gateway/shared-types';

function snapshot(): MetricsSnapshot {
  return {
    counters: {
      'gateway.requests{route="users",status="200"}': 90,
      'gateway.requests{route="users",status="500"}': 10,
      'gateway.requests{route="orders",status="200"}': 50,
      'gateway.rate_limited{route="users"}': 5,
      'gateway.circuit_rejected{route="orders"}': 3,
      'gateway.auth_failures{route="users"}': 2,
      'gateway.upstream{route="users",status="500"}': 10,
      'gateway.upstream{route="users",status="200"}': 90,
      'gateway.config_reloads{result="ok"}': 4,
    },
    latencies: {
      'gateway.request.duration{route="users"}': {
        count: 100,
        sum: 5000,
        avg: 50,
        min: 5,
        max: 400,
        p50: 40,
        p95: 120,
        p99: 300,
      },
      'gateway.request.duration{route="orders"}': {
        count: 50,
        sum: 1000,
        avg: 20,
        min: 5,
        max: 60,
        p50: 18,
        p95: 45,
        p99: 55,
      },
    },
    collectedAt: new Date().toISOString(),
  };
}

describe('parseSeriesKey', () => {
  it('parses bare names', () => {
    expect(parseSeriesKey('gateway.requests')).toEqual({ name: 'gateway.requests', labels: {} });
  });

  it('parses labeled series', () => {
    const { name, labels } = parseSeriesKey('gateway.requests{route="users",status="200"}');
    expect(name).toBe('gateway.requests');
    expect(labels).toEqual({ route: 'users', status: '200' });
  });
});

describe('summarizeMetrics', () => {
  it('aggregates counters and latencies', () => {
    const s = summarizeMetrics(snapshot());
    expect(s.totalRequests).toBe(150);
    expect(s.requestsByStatusClass['2xx']).toBe(140);
    expect(s.requestsByStatusClass['5xx']).toBe(10);
    expect(s.errorRate).toBeCloseTo(10 / 150);
    expect(s.rateLimited).toBe(5);
    expect(s.circuitRejected).toBe(3);
    expect(s.authFailures).toBe(2);
    expect(s.upstreamErrors).toBe(10);
    expect(s.avgLatencyMs).toBeCloseTo(6000 / 150);
    expect(s.maxLatencyMs).toBe(400);
    // sample-weighted p95: (120*100 + 45*50) / 150 = 95
    expect(s.blendedP95Ms).toBeCloseTo(95);
  });

  it('handles empty snapshots', () => {
    const s = summarizeMetrics({ counters: {}, latencies: {}, collectedAt: '' });
    expect(s.totalRequests).toBe(0);
    expect(s.errorRate).toBe(0);
    expect(s.avgLatencyMs).toBe(0);
  });
});

describe('perRouteTraffic', () => {
  it('builds per-route rows sorted by volume', () => {
    const rows = perRouteTraffic(snapshot());
    expect(rows).toHaveLength(2);
    expect(rows[0]?.route).toBe('users');
    expect(rows[0]?.requests).toBe(100);
    expect(rows[0]?.errors5xx).toBe(10);
    expect(rows[0]?.avgLatencyMs).toBeCloseTo(50);
    expect(rows[1]?.route).toBe('orders');
  });
});

describe('requestsPerSecond', () => {
  it('computes deltas over wall-clock time', () => {
    const prev: AnalyticsSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      configVersion: 1,
      metrics: {
        counters: { 'gateway.requests{status="200"}': 100 },
        latencies: {},
        collectedAt: '',
      },
      circuits: {},
    };
    const next: AnalyticsSnapshot = {
      timestamp: '2026-01-01T00:00:10.000Z',
      configVersion: 1,
      metrics: {
        counters: { 'gateway.requests{status="200"}': 150 },
        latencies: {},
        collectedAt: '',
      },
      circuits: {},
    };
    expect(requestsPerSecond(prev, next)).toBeCloseTo(5);
    expect(requestsPerSecond(null, next)).toBeNull();
  });
});

describe('formatters', () => {
  it('formats durations and percentages', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(5.123)).toBe('5.12 ms');
    expect(formatMs(1500)).toBe('1.50 s');
    expect(formatPct(0.1234)).toBe('12.34%');
  });
});
