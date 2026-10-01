import { Redis } from 'ioredis';

/**
 * Redis connections. The gateway uses two connections: one for commands
 * (rate limiting) and a dedicated one for pub/sub (config reload), because a
 * subscriber connection cannot issue other commands.
 */

export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  redis.on('error', () => {
    // Errors are surfaced at the call site (fail-open/fail-closed policy);
    // the client itself keeps retrying in the background.
  });
  return redis;
}

export async function checkRedis(redis: Redis): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
