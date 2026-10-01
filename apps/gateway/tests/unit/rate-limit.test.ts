import { describe, expect, it } from 'vitest';
import { resolveRateLimitKey } from '../../src/rate-limit.js';

describe('resolveRateLimitKey', () => {
  const parts = { ip: '1.2.3.4', routeId: 'route-1', userId: 'user-9' };

  it.each([
    ['ip', 'rl:ip:1.2.3.4'],
    ['user', 'rl:user:user-9'],
    ['route_ip', 'rl:route:route-1:ip:1.2.3.4'],
    ['route_user', 'rl:route:route-1:user:user-9'],
  ])('strategy %s -> %s', (strategy, expected) => {
    expect(resolveRateLimitKey(strategy as never, parts)).toBe(expected);
  });

  it('falls back to IP for user strategies when anonymous', () => {
    expect(resolveRateLimitKey('user', { ip: '1.2.3.4', routeId: 'r1' })).toBe(
      'rl:user:ip:1.2.3.4',
    );
    expect(resolveRateLimitKey('route_user', { ip: '1.2.3.4', routeId: 'r1' })).toBe(
      'rl:route:r1:user:ip:1.2.3.4',
    );
  });
});
