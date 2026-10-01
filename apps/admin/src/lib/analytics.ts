// Pure aggregation helpers over gateway metrics snapshots.
// Kept free of React/DOM so they are trivially unit-testable.

import type { AnalyticsSnapshot, MetricsSnapshot } from '@gateway/shared-types';

/** A parsed `name{label="value",...}` series key. */
export interface SeriesRef {
  name: string;
  labels: Record<string, string>;
}

export function parseSeriesKey(key: string): SeriesRef {
  const brace = key.indexOf('{');
  if (brace === -1) return { name: key, labels: {} };
  const name = key.slice(0, brace);
  const labels: Record<string, string> = {};
  const inner = key.slice(brace + 1, key.endsWith('}') ? -1 : undefined);
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)=(("(?:[^"\\]|\\.)*")|([^,}]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const raw = m[2] ?? '';
    labels[m[1] ?? ''] =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        : raw;
  }
  return { name, labels };
}

export interface OverviewStats {
  totalRequests: number;
  requestsByStatusClass: Record<string, number>;
  errorRate: number;
  avgLatencyMs: number;
  /** Sample-weighted blend of per-series p95 values; an approximation, labeled as such in the UI. */
  blendedP95Ms: number;
  maxLatencyMs: number;
  rateLimited: number;
  circuitRejected: number;
  authFailures: number;
  upstreamErrors: number;
}

/**
 * Reduce a metrics snapshot to dashboard overview numbers.
 * Counter series used: gateway.requests{status,route}, gateway.rate_limited{route},
 * gateway.circuit_rejected{route}, gateway.auth_failures{route},
 * gateway.upstream{route,status}, gateway.config_reloads{result}.
 * Latency series: gateway.request.duration{route}.
 */
export function summarizeMetrics(m: MetricsSnapshot): OverviewStats {
  let total = 0;
  const byClass: Record<string, number> = {};
  let rateLimited = 0;
  let circuitRejected = 0;
  let authFailures = 0;
  let upstreamErrors = 0;

  for (const [key, value] of Object.entries(m.counters)) {
    const { name, labels } = parseSeriesKey(key);
    if (name === 'gateway.requests') {
      total += value;
      const cls = `${(labels['status'] ?? '?')[0] ?? '?'}xx`;
      byClass[cls] = (byClass[cls] ?? 0) + value;
    } else if (name === 'gateway.rate_limited') {
      rateLimited += value;
    } else if (name === 'gateway.circuit_rejected') {
      circuitRejected += value;
    } else if (name === 'gateway.auth_failures') {
      authFailures += value;
    } else if (name === 'gateway.upstream') {
      const status = Number(labels['status'] ?? 0);
      if (status === 0 || status >= 500) upstreamErrors += value;
    }
  }

  let latSamples = 0;
  let latSum = 0;
  let p95Weighted = 0;
  let maxLat = 0;
  for (const [key, stats] of Object.entries(m.latencies)) {
    const { name } = parseSeriesKey(key);
    if (name !== 'gateway.request.duration') continue;
    latSamples += stats.count;
    latSum += stats.sum;
    p95Weighted += stats.p95 * stats.count;
    if (stats.max > maxLat) maxLat = stats.max;
  }

  const errors5xx = byClass['5xx'] ?? 0;
  return {
    totalRequests: total,
    requestsByStatusClass: byClass,
    errorRate: total > 0 ? errors5xx / total : 0,
    avgLatencyMs: latSamples > 0 ? latSum / latSamples : 0,
    blendedP95Ms: latSamples > 0 ? p95Weighted / latSamples : 0,
    maxLatencyMs: maxLat,
    rateLimited,
    circuitRejected,
    authFailures,
    upstreamErrors,
  };
}

export interface RouteTraffic {
  route: string;
  requests: number;
  errors5xx: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

/** Per-route traffic table from request counters + latency series. */
export function perRouteTraffic(m: MetricsSnapshot): RouteTraffic[] {
  const byRoute = new Map<string, { requests: number; errors5xx: number }>();
  for (const [key, value] of Object.entries(m.counters)) {
    const { name, labels } = parseSeriesKey(key);
    if (name !== 'gateway.requests') continue;
    const route = labels['route'] ?? 'unknown';
    const entry = byRoute.get(route) ?? { requests: 0, errors5xx: 0 };
    entry.requests += value;
    if ((labels['status'] ?? '').startsWith('5')) entry.errors5xx += value;
    byRoute.set(route, entry);
  }
  const latByRoute = new Map<string, { sum: number; count: number; p95w: number }>();
  for (const [key, stats] of Object.entries(m.latencies)) {
    const { name, labels } = parseSeriesKey(key);
    if (name !== 'gateway.request.duration') continue;
    const route = labels['route'] ?? 'unknown';
    const entry = latByRoute.get(route) ?? { sum: 0, count: 0, p95w: 0 };
    entry.sum += stats.sum;
    entry.count += stats.count;
    entry.p95w += stats.p95 * stats.count;
    latByRoute.set(route, entry);
  }
  const rows: RouteTraffic[] = [];
  for (const [route, t] of byRoute) {
    const lat = latByRoute.get(route);
    rows.push({
      route,
      requests: t.requests,
      errors5xx: t.errors5xx,
      avgLatencyMs: lat && lat.count > 0 ? lat.sum / lat.count : null,
      p95LatencyMs: lat && lat.count > 0 ? lat.p95w / lat.count : null,
    });
  }
  rows.sort((a, b) => b.requests - a.requests);
  return rows;
}

/** Requests/sec between two snapshots (counter deltas over wall-clock time). */
export function requestsPerSecond(
  prev: AnalyticsSnapshot | null,
  next: AnalyticsSnapshot,
): number | null {
  if (!prev) return null;
  const total = (s: AnalyticsSnapshot): number =>
    Object.entries(s.metrics.counters)
      .filter(([k]) => parseSeriesKey(k).name === 'gateway.requests')
      .reduce((acc, [, v]) => acc + v, 0);
  const dtSec = (new Date(next.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;
  if (dtSec <= 0) return null;
  return Math.max(0, (total(next) - total(prev)) / dtSec);
}

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < 10
    ? `${ms.toFixed(2)} ms`
    : ms < 1000
      ? `${ms.toFixed(1)} ms`
      : `${(ms / 1000).toFixed(2)} s`;
}

export function formatPct(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}
