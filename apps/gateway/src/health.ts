/**
 * Liveness and readiness probes.
 *
 * Liveness is unconditional (the process answers at all). Readiness aggregates
 * dependency checks; a failing dependency yields 503 so orchestrators stop
 * sending traffic until recovery.
 */

export interface DependencyChecks {
  database: () => Promise<boolean>;
  redis: () => Promise<boolean>;
}

export interface ReadinessResult {
  ok: boolean;
  statusCode: number;
  body: {
    status: 'ok' | 'degraded';
    checks: Record<'database' | 'redis', 'ok' | 'unreachable'>;
    configVersion: number;
    uptimeSec: number;
  };
}

export function liveness(): { statusCode: 200; body: { status: 'ok' } } {
  return { statusCode: 200, body: { status: 'ok' } };
}

export async function readiness(
  checks: DependencyChecks,
  info: { configVersion: number; uptimeSec: number },
): Promise<ReadinessResult> {
  const [database, redis] = await Promise.all([checks.database(), checks.redis()]);
  const ok = database && redis;
  return {
    ok,
    statusCode: ok ? 200 : 503,
    body: {
      status: ok ? 'ok' : 'degraded',
      checks: {
        database: database ? 'ok' : 'unreachable',
        redis: redis ? 'ok' : 'unreachable',
      },
      configVersion: info.configVersion,
      uptimeSec: info.uptimeSec,
    },
  };
}
