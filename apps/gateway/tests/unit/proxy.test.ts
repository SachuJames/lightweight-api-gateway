import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '../../src/config.js';
import { filterInboundHeaders, filterOutboundHeaders, proxyPlugin, resolveRequestId } from '../../src/proxy.js';

const testEnv = {
  DATABASE_URL: 'postgres://gateway:gateway@localhost:5432/gateway_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-very-long-test-secret-that-is-safe',
  MAX_BODY_BYTES: '65536',
};
const config = loadConfig(testEnv);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let upstream: Server;
let upstreamBase = '';

beforeAll(async () => {
  upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/slow') {
      const ms = Number(url.searchParams.get('ms') ?? '1500');
      await new Promise((r) => setTimeout(r, ms));
    }
    if (url.pathname === '/fail') {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    if (url.pathname === '/teapot') {
      res.statusCode = 418;
      res.end('teapot');
      return;
    }
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-upstream', 'yes');
    res.setHeader('connection', 'x-hop-test'); // connection-token: must not reach client
    res.setHeader('x-hop-test', 'leaked');
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: {
          'x-request-id': req.headers['x-request-id'],
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'x-custom': req.headers['x-custom'],
          'transfer-encoding': req.headers['transfer-encoding'],
        },
        body: body.toString('utf8'),
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstream.close((e) => (e ? reject(e) : resolve())),
  );
});

async function startGateway(resolveTarget: (req: { url?: string }) => { upstreamBase: string; upstreamPath: string; timeoutMs: number } | null) {
  const app = Fastify({ logger: false });
  await app.register(proxyPlugin, {
    config,
    resolveTarget: (req) =>
      resolveTarget(req as unknown as { url?: string }),
    getClientIp: () => '10.0.0.7',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

describe('header filtering', () => {
  it('strips hop-by-hop headers and connection-listed headers from outbound requests', () => {
    const out = filterOutboundHeaders({
      connection: 'keep-alive, x-secret',
      'x-secret': 'hidden',
      'x-custom': 'kept',
      host: 'example.com',
      'content-length': '5',
    });
    expect(out).toEqual({ 'x-custom': 'kept' });
  });

  it('strips hop-by-hop headers from inbound responses', () => {
    const out = filterInboundHeaders({ connection: 'close', 'x-upstream': 'yes', 'content-type': 'text/plain' });
    expect(out).toEqual({ 'x-upstream': 'yes', 'content-type': 'text/plain' });
  });
});

describe('request id', () => {
  it('accepts a well-formed client request id', () => {
    expect(resolveRequestId('abc-123_XYZ')).toBe('abc-123_XYZ');
  });

  it('rejects request ids with illegal characters', () => {
    const id = resolveRequestId('evil\r\nX-Injected: 1');
    expect(id).not.toContain('\r');
    expect(id).not.toContain('\n');
  });

  it('generates an id when none is supplied', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('proxying', () => {
  it('forwards GET with path, query, and custom headers', async () => {
    const { app, base } = await startGateway(() => ({
      upstreamBase,
      upstreamPath: '/items/42?active=true',
      timeoutMs: 5000,
    }));
    try {
      const res = await fetch(`${base}/items/42?active=true`, { headers: { 'x-custom': 'hello' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBeTruthy();
      expect(res.headers.get('x-hop-test')).toBeNull();
      expect(res.headers.get('x-upstream')).toBe('yes');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ method: 'GET', path: '/items/42', query: '?active=true' });
      expect((body['headers'] as Record<string, unknown>)['x-custom']).toBe('hello');
      expect((body['headers'] as Record<string, unknown>)['x-forwarded-for']).toBe('10.0.0.7');
      expect((body['headers'] as Record<string, unknown>)['x-request-id']).toBe(res.headers.get('x-request-id'));
    } finally {
      await app.close();
    }
  });

  it('streams POST bodies and preserves the method', async () => {
    const { app, base } = await startGateway(() => ({ upstreamBase, upstreamPath: '/submit', timeoutMs: 5000 }));
    try {
      const payload = JSON.stringify({ hello: 'world' });
      const res = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ method: 'POST', path: '/submit' });
      expect(body['body']).toBe(payload);
    } finally {
      await app.close();
    }
  });

  it('passes upstream status codes through (including 4xx/5xx)', async () => {
    const { app, base } = await startGateway(() => ({ upstreamBase, upstreamPath: '/teapot', timeoutMs: 5000 }));
    try {
      const res = await fetch(`${base}/teapot`);
      expect(res.status).toBe(418);
      await res.text();
    } finally {
      await app.close();
    }
  });

  it('maps an upstream timeout to 504 with a stable error code', async () => {
    const { app, base } = await startGateway(() => ({ upstreamBase, upstreamPath: '/slow?ms=1500', timeoutMs: 300 }));
    try {
      const res = await fetch(`${base}/slow`);
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe('UPSTREAM_TIMEOUT');
      expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    } finally {
      await app.close();
    }
  });

  it('maps a refused connection to 503', async () => {
    const { app, base } = await startGateway(() => ({
      upstreamBase: 'http://127.0.0.1:1',
      upstreamPath: '/',
      timeoutMs: 2000,
    }));
    try {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });

  it('rejects oversized bodies with 413', async () => {
    const { app, base } = await startGateway(() => ({ upstreamBase, upstreamPath: '/big', timeoutMs: 5000 }));
    try {
      const res = await fetch(`${base}/big`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'x'.repeat(200_000),
        duplex: 'half',
      });
      expect(res.status).toBe(413);
      await res.text().catch(() => undefined);
    } finally {
      await app.close();
    }
  });

  it('returns 404 with a stable code when no target resolves', async () => {
    const { app, base } = await startGateway(() => null);
    try {
      const res = await fetch(`${base}/nothing-here`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('handles concurrent requests', async () => {
    const { app, base } = await startGateway(() => ({ upstreamBase, upstreamPath: '/echo', timeoutMs: 5000 }));
    try {
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => fetch(`${base}/echo?n=${i}`).then((r) => r.status)),
      );
      expect(results.every((s) => s === 200)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
