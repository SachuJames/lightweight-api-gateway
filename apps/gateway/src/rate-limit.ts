import { Redis } from 'ioredis';
import type { RateLimitPolicy } from '@gateway/shared-types';
import { ErrorCodes, GatewayError } from './errors.js';

/**
 * Token-bucket rate limiting, executed atomically in Redis via Lua so that
 * concurrent gateway instances share one consistent bucket per key.
 *
 * Key strategies:
 *   ip        — per client IP across all routes
 *   user      — per authenticated user (falls back to IP when anonymous)
 *   route_ip  — per route + client IP
 *   route_user— per route + authenticated user (falls back to IP when anonymous)
 */

const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity end
if ts == nil then ts = now_ms end

local elapsed = math.max(0, now_ms - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill_per_sec)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

local ttl_ms = math.ceil(capacity / refill_per_sec * 1000)
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', KEYS[1], ttl_ms)

local retry_after_ms = 0
if allowed == 0 then
  retry_after_ms = math.ceil((1 - tokens) / refill_per_sec * 1000)
end
return {allowed, math.floor(tokens), retry_after_ms}
`;

export interface RateLimitKeyParts {
  ip: string;
  routeId: string;
  userId?: string;
}

export function resolveRateLimitKey(
  strategy: RateLimitPolicy['keyStrategy'],
  parts: RateLimitKeyParts,
): string {
  switch (strategy) {
    case 'ip':
      return `rl:ip:${parts.ip}`;
    case 'user':
      return `rl:user:${parts.userId ?? `ip:${parts.ip}`}`;
    case 'route_ip':
      return `rl:route:${parts.routeId}:ip:${parts.ip}`;
    case 'route_user':
      return `rl:route:${parts.routeId}:user:${parts.userId ?? `ip:${parts.ip}`}`;
    default:
      throw new GatewayError(
        ErrorCodes.CONFIGURATION_ERROR,
        500,
        `Unknown rate limit key strategy.`,
      );
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  /** True when Redis was unreachable and the policy failed open. */
  degraded: boolean;
}

export async function checkRateLimit(
  redis: Redis,
  policy: RateLimitPolicy,
  parts: RateLimitKeyParts,
): Promise<RateLimitResult> {
  if (policy.capacity <= 0 || policy.refillRatePerSec <= 0) {
    throw new GatewayError(
      ErrorCodes.CONFIGURATION_ERROR,
      500,
      `Rate limit policy "${policy.name}" has non-positive capacity/refill.`,
    );
  }
  const key = resolveRateLimitKey(policy.keyStrategy, parts);
  try {
    const [allowed, remaining, retryAfterMs] = (await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      String(policy.capacity),
      String(policy.refillRatePerSec),
      String(Date.now()),
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs, degraded: false };
  } catch {
    if (policy.failOpen) {
      return { allowed: true, remaining: 0, retryAfterMs: 0, degraded: true };
    }
    throw new GatewayError(
      ErrorCodes.REDIS_ERROR,
      503,
      'Rate limiter is unavailable and the policy requires fail-closed.',
    );
  }
}
