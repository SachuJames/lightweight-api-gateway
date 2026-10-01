import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Route } from '@gateway/shared-types';
import {
  PluginManager,
  createAddHeaderPlugin,
  type GatewayPlugin,
  type PluginRequest,
} from '../../src/plugins.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: 'r1',
    name: 'test',
    pathPattern: '/api/*',
    methods: ['GET'],
    upstreamUrl: 'http://x:3001',
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

function makeRequest(): PluginRequest {
  return {
    method: 'GET',
    url: '/api/things',
    headers: {},
    route: makeRoute(),
    requestId: 'req-1',
    ip: '1.2.3.4',
  };
}

describe('PluginManager', () => {
  it('rejects duplicate and invalid registrations', () => {
    const m = new PluginManager();
    m.register(createAddHeaderPlugin('x-a', '1'));
    expect(() => {
      m.register(createAddHeaderPlugin('x-a', '2'));
    }).toThrow(/already registered/);
    expect(() => {
      m.register({} as GatewayPlugin);
    }).toThrow(/Invalid plugin/);
    expect(m.names()).toEqual(['add-header']);
  });

  it('runs onRequest hooks in order and lets them mutate headers', async () => {
    const m = new PluginManager();
    const order: string[] = [];
    m.register({
      name: 'first',
      onRequest: async (req) => {
        order.push('first');
        req.headers['x-first'] = '1';
        return undefined;
      },
    });
    m.register({
      name: 'second',
      onRequest: async (req) => {
        order.push('second');
        req.headers['x-second'] = '2';
        return undefined;
      },
    });
    const req = makeRequest();
    expect(await m.runOnRequest(req, makeRoute())).toBeNull();
    expect(order).toEqual(['first', 'second']);
    expect(req.headers['x-first']).toBe('1');
    expect(req.headers['x-second']).toBe('2');
  });

  it('short-circuits on the first response and skips later hooks', async () => {
    const m = new PluginManager();
    let secondRan = false;
    m.register({
      name: 'blocker',
      onRequest: async () => ({ statusCode: 403, body: 'blocked' }),
    });
    m.register({
      name: 'second',
      onRequest: async () => {
        secondRan = true;
        return undefined;
      },
    });
    const res = await m.runOnRequest(makeRequest(), makeRoute());
    expect(res).toEqual({ statusCode: 403, body: 'blocked' });
    expect(secondRan).toBe(false);
  });

  it('isolates hook errors and keeps the chain going', async () => {
    const errors: string[] = [];
    const m = new PluginManager((name, hook) => {
      errors.push(`${name}:${hook}`);
    });
    let secondRan = false;
    m.register({
      name: 'explodes',
      onRequest: async () => {
        throw new Error('boom');
      },
    });
    m.register({
      name: 'second',
      onRequest: async () => {
        secondRan = true;
        return undefined;
      },
    });
    expect(await m.runOnRequest(makeRequest(), makeRoute())).toBeNull();
    expect(secondRan).toBe(true);
    expect(errors).toEqual(['explodes:onRequest']);
  });

  it('respects per-route disabling via pluginConfig', async () => {
    const m = new PluginManager();
    m.register(createAddHeaderPlugin('x-added', 'yes'));
    const req = makeRequest();
    const route = makeRoute({ pluginConfig: { 'add-header': { enabled: false } } });
    await m.runOnRequest(req, route);
    expect(req.headers['x-added']).toBeUndefined();
  });

  it('passes route options to the plugin context', async () => {
    const m = new PluginManager();
    let seen: Record<string, unknown> | undefined;
    m.register({
      name: 'opt-reader',
      onRequest: async (_req, ctx) => {
        seen = ctx.options;
        return undefined;
      },
    });
    const route = makeRoute({ pluginConfig: { 'opt-reader': { mode: 'strict' } } });
    await m.runOnRequest(makeRequest(), route);
    expect(seen).toEqual({ mode: 'strict' });
  });

  it('runs onResponse hooks in order', async () => {
    const m = new PluginManager();
    m.register({
      name: 'a',
      onResponse: async (res) => {
        res.headers['x-a'] = '1';
      },
    });
    m.register({
      name: 'b',
      onResponse: async (res) => {
        res.headers['x-b'] = '2';
      },
    });
    const res = { statusCode: 200, headers: {} };
    await m.runOnResponse(res, makeRoute());
    expect(res.headers).toMatchObject({ 'x-a': '1', 'x-b': '2' });
  });

  it('runs onError hooks and isolates their failures', async () => {
    const m = new PluginManager();
    const seen: unknown[] = [];
    m.register({
      name: 'watcher',
      onError: async (err) => {
        seen.push(err);
      },
    });
    m.register({
      name: 'bad-watcher',
      onError: async () => {
        throw new Error('nope');
      },
    });
    const err = new Error('pipeline failed');
    await m.runOnError(err, makeRoute());
    expect(seen).toEqual([err]);
  });

  it('loads plugins from a directory and reports failures', async () => {
    const m = new PluginManager();
    const result = await m.loadFromDirectory(fixturesDir);
    expect(result.loaded).toEqual(['fixture-add-header']);
    expect(result.failed.map((f) => f.file).sort()).toEqual(['broken.js', 'not-a-plugin.js']);
    expect(m.names()).toContain('fixture-add-header');

    const req = makeRequest();
    await m.runOnRequest(req, makeRoute());
    expect(req.headers['x-fixture']).toBe('yes');
  });

  it('throws for a missing plugin directory', async () => {
    const m = new PluginManager();
    await expect(m.loadFromDirectory('/no/such/dir')).rejects.toThrow(
      /Cannot read plugin directory/,
    );
  });
});
