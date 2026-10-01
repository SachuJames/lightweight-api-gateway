import type { CircuitBreakerPolicy, RateLimitPolicy, Route } from '@gateway/shared-types';
import type { DbClient } from '../db.js';
import { normalizeUpstreamUrl, type RouteInput } from '../routing.js';

interface RouteRow {
  id: string;
  name: string;
  path_pattern: string;
  methods: string[];
  upstream_url: string;
  enabled: boolean;
  priority: number;
  auth_required: boolean;
  rate_limit_policy_id: string | null;
  circuit_breaker_policy_id: string | null;
  timeout_ms: number;
  plugin_config: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export function rowToRoute(row: RouteRow): Route {
  return {
    id: row.id,
    name: row.name,
    pathPattern: row.path_pattern,
    methods: row.methods as Route['methods'],
    upstreamUrl: row.upstream_url,
    enabled: row.enabled,
    priority: row.priority,
    authRequired: row.auth_required,
    rateLimitPolicyId: row.rate_limit_policy_id,
    circuitBreakerPolicyId: row.circuit_breaker_policy_id,
    timeoutMs: row.timeout_ms,
    pluginConfig: row.plugin_config ?? {},
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listRoutes(client: DbClient): Promise<Route[]> {
  const res = await client.query<RouteRow>(
    'SELECT * FROM routes ORDER BY priority DESC, path_pattern ASC, id ASC',
  );
  return res.rows.map(rowToRoute);
}

export async function getRoute(client: DbClient, id: string): Promise<Route | null> {
  const res = await client.query<RouteRow>('SELECT * FROM routes WHERE id = $1', [id]);
  const row = res.rows[0];
  return row ? rowToRoute(row) : null;
}

export async function insertRoute(client: DbClient, input: RouteInput): Promise<Route> {
  const res = await client.query<RouteRow>(
    `INSERT INTO routes
      (name, path_pattern, methods, upstream_url, enabled, priority, auth_required,
       rate_limit_policy_id, circuit_breaker_policy_id, timeout_ms, plugin_config)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.name,
      input.pathPattern,
      input.methods,
      normalizeUpstreamUrl(input.upstreamUrl),
      input.enabled,
      input.priority,
      input.authRequired,
      input.rateLimitPolicyId,
      input.circuitBreakerPolicyId,
      input.timeoutMs,
      JSON.stringify(input.pluginConfig),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insertRoute returned no row');
  return rowToRoute(row);
}

export type RoutePatchKey =
  | 'name'
  | 'pathPattern'
  | 'methods'
  | 'upstreamUrl'
  | 'enabled'
  | 'priority'
  | 'authRequired'
  | 'rateLimitPolicyId'
  | 'circuitBreakerPolicyId'
  | 'timeoutMs'
  | 'pluginConfig';

/** Patch with explicit-undefined tolerance (zod `.partial()` output). */
export type RoutePatch = { [K in RoutePatchKey]?: RouteInput[K] | undefined };

const PATCH_COLUMNS: Record<RoutePatchKey, string> = {
  name: 'name',
  pathPattern: 'path_pattern',
  methods: 'methods',
  upstreamUrl: 'upstream_url',
  enabled: 'enabled',
  priority: 'priority',
  authRequired: 'auth_required',
  rateLimitPolicyId: 'rate_limit_policy_id',
  circuitBreakerPolicyId: 'circuit_breaker_policy_id',
  timeoutMs: 'timeout_ms',
  pluginConfig: 'plugin_config',
};

export async function updateRoute(client: DbClient, id: string, patch: RoutePatch): Promise<Route | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = PATCH_COLUMNS[key as RoutePatchKey];
    if (value === undefined || column === undefined) continue;
    values.push(key === 'upstreamUrl' ? normalizeUpstreamUrl(value as string) : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return getRoute(client, id);
  values.push(id);
  const res = await client.query<RouteRow>(
    `UPDATE routes SET ${sets.join(', ')}, version = version + 1, updated_at = now()
     WHERE id = $${values.length} RETURNING *`,
    values,
  );
  const row = res.rows[0];
  return row ? rowToRoute(row) : null;
}

export async function deleteRoute(client: DbClient, id: string): Promise<Route | null> {
  const res = await client.query<RouteRow>('DELETE FROM routes WHERE id = $1 RETURNING *', [id]);
  const row = res.rows[0];
  return row ? rowToRoute(row) : null;
}

export interface PolicyRow {
  id: string;
  name: string;
}

export async function policyExists(client: DbClient, table: 'rate_limit_policies' | 'circuit_breaker_policies', id: string): Promise<boolean> {
  const res = await client.query('SELECT 1 FROM ' + table + ' WHERE id = $1', [id]);
  return res.rowCount !== 0;
}

export async function listRateLimitPolicies(client: DbClient): Promise<RateLimitPolicy[]> {
  const res = await client.query(
    'SELECT id, name, capacity, refill_rate_per_sec, key_strategy, fail_open FROM rate_limit_policies ORDER BY name ASC',
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    capacity: r.capacity as number,
    refillRatePerSec: Number(r.refill_rate_per_sec),
    keyStrategy: r.key_strategy as RateLimitPolicy['keyStrategy'],
    failOpen: r.fail_open as boolean,
  }));
}

export async function listCircuitBreakerPolicies(client: DbClient): Promise<CircuitBreakerPolicy[]> {
  const res = await client.query('SELECT * FROM circuit_breaker_policies ORDER BY name ASC');
  return res.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    failureThreshold: r.failure_threshold as number,
    rollingWindowMs: r.rolling_window_ms as number,
    openDurationMs: r.open_duration_ms as number,
    halfOpenMaxProbes: r.half_open_max_probes as number,
    failureStatuses: r.failure_statuses as number[],
    countTimeouts: r.count_timeouts as boolean,
  }));
}
