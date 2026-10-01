/**
 * In-memory metrics.
 *
 * Bounded by design: label cardinality is capped (oldest series evicted past
 * the cap) and latency samples use fixed-size ring buffers, so a cardinality
 * explosion degrades gracefully instead of growing memory without limit.
 * The gateway exposes these as JSON and over SSE (wired in the server phase);
 * Prometheus exposition is deliberately out of scope for v1.
 */

export interface LatencyStats {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  latencies: Record<string, LatencyStats>;
  collectedAt: string;
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`);
  return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private samples = new Map<string, number[]>();
  private maxSeries: number;
  private maxSamples: number;

  constructor(opts: { maxSeries?: number; maxSamples?: number } = {}) {
    this.maxSeries = opts.maxSeries ?? 1000;
    this.maxSamples = opts.maxSamples ?? 1024;
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
    this.evictIfNeeded(this.counters);
  }

  observeLatency(name: string, labels: Record<string, string>, ms: number): void {
    const key = seriesKey(name, labels);
    let buf = this.samples.get(key);
    if (!buf) {
      buf = [];
      this.samples.set(key, buf);
      this.evictIfNeeded(this.samples);
    }
    buf.push(ms);
    if (buf.length > this.maxSamples) buf.splice(0, buf.length - this.maxSamples);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const latencies: Record<string, LatencyStats> = {};
    for (const [k, buf] of this.samples) {
      const sorted = [...buf].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      latencies[k] = {
        count: sorted.length,
        sum,
        avg: sorted.length > 0 ? sum / sorted.length : 0,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        p99: quantile(sorted, 0.99),
      };
    }
    return { counters, latencies, collectedAt: new Date().toISOString() };
  }

  reset(): void {
    this.counters.clear();
    this.samples.clear();
  }

  seriesCount(): number {
    return this.counters.size + this.samples.size;
  }

  private evictIfNeeded(map: Map<string, unknown>): void {
    while (map.size > this.maxSeries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

// Well-known series names used by the request pipeline.
export const MetricNames = {
  requestsTotal: 'gateway_requests_total',
  requestDurationMs: 'gateway_request_duration_ms',
  upstreamDurationMs: 'gateway_upstream_duration_ms',
  rateLimitedTotal: 'gateway_rate_limited_total',
  circuitOpenTotal: 'gateway_circuit_open_total',
  authFailuresTotal: 'gateway_auth_failures_total',
  configReloadsTotal: 'gateway_config_reloads_total',
} as const;
