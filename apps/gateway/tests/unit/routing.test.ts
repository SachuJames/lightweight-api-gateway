import { describe, expect, it } from 'vitest';
import type { Route } from '@gateway/shared-types';
import { isValidPattern, matchRoutes, normalizeUpstreamUrl, routeInputSchema } from '../../src/routing.js';

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'test',
    pathPattern: '/api/users/*',
    methods: ['GET'],
    upstreamUrl: 'http://users-service:3001',
    enabled: true,
    priority: 100,
    authRequired: false,
    rateLimitPolicyId: null,
    circuitBreakerPolicyId: null,
    timeoutMs: 30_000,
    pluginConfig: {},
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isValidPattern', () => {
  it.each(['/api/users/*', '/api/users/:id', '/api/users/new', '/health', '/*'])('accepts %s', (p) => {
    expect(isValidPattern(p)).toBe(true);
  });

  it.each([
    'api/users', // missing leading slash
    '/api/*/users', // wildcard not last
    '/api/:9bad', // bad param name
    '/api/users//x', // empty segment
    '/api/users?q=1', // query string
    '/api/us ers', // whitespace
    '/', // bare root (use /* instead)
  ])('rejects %s', (p) => {
    expect(isValidPattern(p)).toBe(false);
  });
});

describe('matchRoutes', () => {
  it('matches a wildcard and strips the static prefix', () => {
    const m = matchRoutes([makeRoute()], 'GET', '/api/users/123');
    expect(m?.route.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(m?.upstreamPath).toBe('/123');
  });

  it('matches the bare prefix of a wildcard pattern', () => {
    const m = matchRoutes([makeRoute()], 'GET', '/api/users');
    expect(m?.upstreamPath).toBe('/');
  });

  it('preserves the query string', () => {
    const m = matchRoutes([makeRoute()], 'GET', '/api/users/123?active=true&x=1');
    expect(m?.upstreamPath).toBe('/123?active=true&x=1');
  });

  it('extracts path params', () => {
    const m = matchRoutes([makeRoute({ pathPattern: '/api/users/:id' })], 'GET', '/api/users/42');
    expect(m?.params).toEqual({ id: '42' });
    expect(m?.upstreamPath).toBe('/42');
  });

  it('does not match a different method', () => {
    expect(matchRoutes([makeRoute()], 'POST', '/api/users/123')).toBeNull();
  });

  it('does not match a disabled route', () => {
    expect(matchRoutes([makeRoute({ enabled: false })], 'GET', '/api/users/123')).toBeNull();
  });

  it('does not match a partial segment', () => {
    expect(matchRoutes([makeRoute()], 'GET', '/api/users-new')).toBeNull();
    expect(matchRoutes([makeRoute()], 'GET', '/other/path')).toBeNull();
  });

  it('prefers higher priority over specificity', () => {
    const routes = [
      makeRoute({ id: 'a', pathPattern: '/api/users/new', priority: 100 }),
      makeRoute({ id: 'b', pathPattern: '/api/*', priority: 200 }),
    ];
    expect(matchRoutes(routes, 'GET', '/api/users/new')?.route.id).toBe('b');
  });

  it('prefers a static segment over a param at equal priority', () => {
    const routes = [
      makeRoute({ id: 'a', pathPattern: '/api/users/:id' }),
      makeRoute({ id: 'b', pathPattern: '/api/users/new' }),
    ];
    expect(matchRoutes(routes, 'GET', '/api/users/new')?.route.id).toBe('b');
    expect(matchRoutes(routes, 'GET', '/api/users/42')?.route.id).toBe('a');
  });

  it('prefers a param over a wildcard at equal priority', () => {
    const routes = [makeRoute({ id: 'a', pathPattern: '/api/users/*' }), makeRoute({ id: 'b', pathPattern: '/api/users/:id' })];
    expect(matchRoutes(routes, 'GET', '/api/users/42')?.route.id).toBe('b');
  });

  it('is deterministic for identical patterns (stable by id)', () => {
    const routes = [makeRoute({ id: 'b-id' }), makeRoute({ id: 'a-id' })];
    expect(matchRoutes(routes, 'GET', '/api/users/1')?.route.id).toBe('a-id');
  });

  it('tolerates a trailing slash on the request', () => {
    const m = matchRoutes([makeRoute({ pathPattern: '/api/users/:id' })], 'GET', '/api/users/42/');
    expect(m?.params).toEqual({ id: '42' });
  });
});

describe('routeInputSchema', () => {
  const valid = {
    name: 'users',
    pathPattern: '/api/users/*',
    methods: ['GET', 'POST'],
    upstreamUrl: 'http://users-service:3001',
  };

  it('accepts a valid route and applies defaults', () => {
    const r = routeInputSchema.parse(valid);
    expect(r.enabled).toBe(true);
    expect(r.priority).toBe(100);
    expect(r.timeoutMs).toBe(30_000);
  });

  it('rejects a bad pattern, bad method, and bad upstream', () => {
    expect(() => routeInputSchema.parse({ ...valid, pathPattern: 'nope' })).toThrow();
    expect(() => routeInputSchema.parse({ ...valid, methods: ['FETCH'] })).toThrow();
    expect(() => routeInputSchema.parse({ ...valid, upstreamUrl: 'ftp://x' })).toThrow();
    expect(() => routeInputSchema.parse({ ...valid, upstreamUrl: 'not a url' })).toThrow();
  });

  it('rejects an empty method list and out-of-range timeout', () => {
    expect(() => routeInputSchema.parse({ ...valid, methods: [] })).toThrow();
    expect(() => routeInputSchema.parse({ ...valid, timeoutMs: 0 })).toThrow();
  });
});

describe('normalizeUpstreamUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeUpstreamUrl('http://x:3001///')).toBe('http://x:3001');
  });
});
