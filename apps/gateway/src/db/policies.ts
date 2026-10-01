import { z } from 'zod';
import type { CircuitBreakerPolicy, RateLimitPolicy } from '@gateway/shared-types';
import type { DbClient } from '../db.js';

export const rateLimitPolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  capacity: z.number().int().positive().max(1_000_000),
  refillRatePerSec: z.number().positive().max(1_000_000),
  keyStrategy: z.enum(['ip', 'user', 'route_ip', 'route_user']),
  failOpen: z.boolean().default(true),
});

export const circuitBreakerPolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  failureThreshold: z.number().int().positive().max(10_000),
  rollingWindowMs: z.number().int().positive().max(3_600_000),
  openDurationMs: z.number().int().positive().max(3_600_000),
  halfOpenMaxProbes: z.number().int().positive().max(1_000),
  failureStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(20),
  countTimeouts: z.boolean().default(true),
});

export type RateLimitPolicyInput = z.infer<typeof rateLimitPolicyInputSchema>;
export type CircuitBreakerPolicyInput = z.infer<typeof circuitBreakerPolicyInputSchema>;

function rowToRateLimit(r: Record<string, unknown>): RateLimitPolicy {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    capacity: r['capacity'] as number,
    refillRatePerSec: Number(r['refill_rate_per_sec']),
    keyStrategy: r['key_strategy'] as RateLimitPolicy['keyStrategy'],
    failOpen: r['fail_open'] as boolean,
  };
}

function rowToCircuit(r: Record<string, unknown>): CircuitBreakerPolicy {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    failureThreshold: r['failure_threshold'] as number,
    rollingWindowMs: r['rolling_window_ms'] as number,
    openDurationMs: r['open_duration_ms'] as number,
    halfOpenMaxProbes: r['half_open_max_probes'] as number,
    failureStatuses: r['failure_statuses'] as number[],
    countTimeouts: r['count_timeouts'] as boolean,
  };
}

const RL_COLS = 'id, name, capacity, refill_rate_per_sec, key_strategy, fail_open';
const CB_COLS =
  'id, name, failure_threshold, rolling_window_ms, open_duration_ms, half_open_max_probes, failure_statuses, count_timeouts';

export async function insertRateLimitPolicy(client: DbClient, input: RateLimitPolicyInput): Promise<RateLimitPolicy> {
  const res = await client.query(
    `INSERT INTO rate_limit_policies (name, capacity, refill_rate_per_sec, key_strategy, fail_open)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${RL_COLS}`,
    [input.name, input.capacity, input.refillRatePerSec, input.keyStrategy, input.failOpen],
  );
  return rowToRateLimit(res.rows[0] as Record<string, unknown>);
}

export async function updateRateLimitPolicy(
  client: DbClient,
  id: string,
  patch: { [K in keyof RateLimitPolicyInput]?: RateLimitPolicyInput[K] | undefined },
): Promise<RateLimitPolicy | null> {
  const map: Record<string, string> = {
    name: 'name',
    capacity: 'capacity',
    refillRatePerSec: 'refill_rate_per_sec',
    keyStrategy: 'key_strategy',
    failOpen: 'fail_open',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !map[k]) continue;
    values.push(v);
    sets.push(`${map[k]} = $${values.length}`);
  }
  if (sets.length === 0) {
    const res = await client.query(`SELECT ${RL_COLS} FROM rate_limit_policies WHERE id = $1`, [id]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? rowToRateLimit(row) : null;
  }
  values.push(id);
  const res = await client.query(
    `UPDATE rate_limit_policies SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${values.length} RETURNING ${RL_COLS}`,
    values,
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToRateLimit(row) : null;
}

export async function deleteRateLimitPolicy(client: DbClient, id: string): Promise<RateLimitPolicy | null> {
  const res = await client.query(`DELETE FROM rate_limit_policies WHERE id = $1 RETURNING ${RL_COLS}`, [id]);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToRateLimit(row) : null;
}

export async function insertCircuitBreakerPolicy(
  client: DbClient,
  input: CircuitBreakerPolicyInput,
): Promise<CircuitBreakerPolicy> {
  const res = await client.query(
    `INSERT INTO circuit_breaker_policies
       (name, failure_threshold, rolling_window_ms, open_duration_ms, half_open_max_probes, failure_statuses, count_timeouts)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${CB_COLS}`,
    [
      input.name,
      input.failureThreshold,
      input.rollingWindowMs,
      input.openDurationMs,
      input.halfOpenMaxProbes,
      input.failureStatuses,
      input.countTimeouts,
    ],
  );
  return rowToCircuit(res.rows[0] as Record<string, unknown>);
}

export async function updateCircuitBreakerPolicy(
  client: DbClient,
  id: string,
  patch: { [K in keyof CircuitBreakerPolicyInput]?: CircuitBreakerPolicyInput[K] | undefined },
): Promise<CircuitBreakerPolicy | null> {
  const map: Record<string, string> = {
    name: 'name',
    failureThreshold: 'failure_threshold',
    rollingWindowMs: 'rolling_window_ms',
    openDurationMs: 'open_duration_ms',
    halfOpenMaxProbes: 'half_open_max_probes',
    failureStatuses: 'failure_statuses',
    countTimeouts: 'count_timeouts',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !map[k]) continue;
    values.push(v);
    sets.push(`${map[k]} = $${values.length}`);
  }
  if (sets.length === 0) {
    const res = await client.query(`SELECT ${CB_COLS} FROM circuit_breaker_policies WHERE id = $1`, [id]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? rowToCircuit(row) : null;
  }
  values.push(id);
  const res = await client.query(
    `UPDATE circuit_breaker_policies SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${values.length} RETURNING ${CB_COLS}`,
    values,
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToCircuit(row) : null;
}

export async function deleteCircuitBreakerPolicy(
  client: DbClient,
  id: string,
): Promise<CircuitBreakerPolicy | null> {
  const res = await client.query(`DELETE FROM circuit_breaker_policies WHERE id = $1 RETURNING ${CB_COLS}`, [id]);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToCircuit(row) : null;
}

/** Routes referencing a policy block its deletion (clearer than silent SET NULL). */
export async function countRoutesUsingPolicy(
  client: DbClient,
  column: 'rate_limit_policy_id' | 'circuit_breaker_policy_id',
  id: string,
): Promise<number> {
  const res = await client.query(`SELECT COUNT(*)::int AS n FROM routes WHERE ${column} = $1`, [id]);
  return (res.rows[0] as { n: number }).n;
}
