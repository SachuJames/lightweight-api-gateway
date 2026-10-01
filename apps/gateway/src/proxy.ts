import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Agent, request as undiciRequest } from 'undici';
import type { GatewayConfig } from './config.js';
import { ErrorCodes, GatewayError, UpstreamFailureKind } from './errors.js';

/**
 * Reverse proxy engine.
 *
 * Forwards the client request to the upstream with undici, streaming both
 * directions. Never buffers whole bodies in memory.
 */

/** Hop-by-hop headers are never forwarded; the proxy manages the connection itself. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ProxyTarget {
  upstreamBase: string;
  /** Path and query string to request from the upstream, e.g. "/users/123?active=true". */
  upstreamPath: string;
  timeoutMs: number;
}

export interface ProxyPluginOptions {
  config: GatewayConfig;
  /** Resolve the proxy target for a request, or null when nothing matches. */
  resolveTarget: (req: FastifyRequest) => ProxyTarget | null;
  /** Client IP for X-Forwarded-For (already trust-filtered by the caller). */
  getClientIp: (req: FastifyRequest) => string;
  /** Optional hook for metrics/observability (called after proxying settles). */
  onSettled?: (info: {
    requestId: string;
    target: ProxyTarget;
    statusCode: number | null;
    failureKind: UpstreamFailureKind;
    durationMs: number;
  }) => void;
}

/** Validate a client-supplied request ID, or generate a fresh one. */
export function resolveRequestId(raw: unknown): string {
  if (typeof raw === 'string' && REQUEST_ID_PATTERN.test(raw)) return raw;
  return randomUUID();
}

function connectionTokens(headers: Record<string, string | string[] | undefined>): Set<string> {
  const tokens = new Set<string>();
  const raw = headers['connection'];
  const values = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  for (const v of values) {
    for (const t of v.split(',')) {
      const token = t.trim().toLowerCase();
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

/** Strip hop-by-hop headers before forwarding to the upstream. */
export function filterOutboundHeaders(
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const tokens = connectionTokens(incoming);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (tokens.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length') continue; // undici manages these
    out[name] = value;
  }
  return out;
}

/** Strip hop-by-hop headers from the upstream response before sending to the client. */
export function filterInboundHeaders(
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const tokens = connectionTokens(incoming);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (tokens.has(lower)) continue;
    out[name] = value;
  }
  return out;
}

/** Wrap a stream so it fails fast once more than maxBytes flow through it. */
export function limitStreamBytes(source: Readable, maxBytes: number): Readable {
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(
          new GatewayError(ErrorCodes.PAYLOAD_TOO_LARGE, 413, `Request body exceeds ${maxBytes} bytes`),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
  source.on('error', (err) => counter.destroy(err));
  return source.pipe(counter);
}

function hasRequestBody(req: FastifyRequest): boolean {
  return req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
}

export function mapUpstreamError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const code = (err as { code?: string })?.code ?? '';
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new GatewayError(ErrorCodes.UPSTREAM_TIMEOUT, 504, 'Upstream did not respond in time', 'timeout');
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'EAI_AGAIN') {
    return new GatewayError(ErrorCodes.UPSTREAM_UNAVAILABLE, 503, 'Upstream is unreachable', 'connection');
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return new GatewayError(ErrorCodes.UPSTREAM_ERROR, 502, 'Upstream connection failed', 'connection');
  }
  return new GatewayError(ErrorCodes.UPSTREAM_ERROR, 502, 'Bad response from upstream', 'bad_response');
}

export interface ProxyOutcome {
  requestId: string;
  statusCode: number;
  failureKind: UpstreamFailureKind;
}

/** Pipe the upstream body into the reply, mapping pre-headers stream errors to a 502. */
function streamToReply(reply: FastifyReply, body: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    body.once('error', (streamErr: unknown) => {
      if (!reply.raw.headersSent) {
        done(streamErr);
      } else {
        reply.raw.destroy();
        done();
      }
    });
    body.once('end', () => done());
    body.once('close', () => done());
    reply.raw.once('close', () => {
      body.destroy();
    });
    void reply.send(body);
  });
}

async function proxyOnce(
  req: FastifyRequest,
  reply: FastifyReply,
  target: ProxyTarget,
  opts: ProxyPluginOptions,
): Promise<ProxyOutcome> {
  const requestId = resolveRequestId(req.headers['x-request-id']);
  const started = Date.now();
  let outcome: ProxyOutcome | null = null;
  const dispatcher = new Agent({ connect: { timeout: opts.config.upstreamConnectTimeoutMs } });

  try {
    const outbound = filterOutboundHeaders(req.headers as Record<string, string | string[] | undefined>);
    outbound['x-request-id'] = requestId;
    const clientIp = opts.getClientIp(req);
    const prior = req.headers['x-forwarded-for'];
    outbound['x-forwarded-for'] = prior ? `${prior}, ${clientIp}` : clientIp;

    let body: Readable | undefined;
    if (hasRequestBody(req)) {
      const contentLength = Number(req.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > opts.config.maxBodyBytes) {
        throw new GatewayError(
          ErrorCodes.PAYLOAD_TOO_LARGE,
          413,
          `Request body exceeds ${opts.config.maxBodyBytes} bytes`,
        );
      }
      body = limitStreamBytes(req.raw, opts.config.maxBodyBytes);
    }

    const upstreamUrl = target.upstreamBase + target.upstreamPath;
    let upstream;
    try {
      upstream = await undiciRequest(upstreamUrl, {
        method: req.method,
        headers: outbound,
        ...(body ? { body } : {}),
        dispatcher,
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (err) {
      throw mapUpstreamError(err);
    }

    const inbound = filterInboundHeaders(upstream.headers as Record<string, string | string[] | undefined>);
    reply.status(upstream.statusCode);
    for (const [name, value] of Object.entries(inbound)) {
      reply.header(name, value);
    }
    reply.header('x-request-id', requestId);

    const upstreamBody = upstream.body as Readable;
    const failureKind: UpstreamFailureKind = upstream.statusCode >= 500 ? 'bad_response' : 'none';
    try {
      await streamToReply(reply, upstreamBody);
    } catch (err) {
      throw mapUpstreamError(err);
    }
    outcome = { requestId, statusCode: upstream.statusCode, failureKind };
    return outcome;
  } catch (err) {
    const mapped = mapUpstreamError(err);
    if (!reply.raw.headersSent) {
      reply.status(mapped.statusCode);
      reply.header('x-request-id', requestId);
      reply.send({ error: { code: mapped.code, message: mapped.message, requestId } });
    } else {
      reply.raw.destroy();
    }
    outcome = { requestId, statusCode: mapped.statusCode, failureKind: mapped.failureKind };
    return outcome;
  } finally {
    await dispatcher.close().catch(() => undefined);
    opts.onSettled?.({
      requestId,
      target,
      statusCode: outcome?.statusCode ?? null,
      failureKind: outcome?.failureKind ?? 'none',
      durationMs: Date.now() - started,
    });
  }
}

export async function proxyPlugin(app: FastifyInstance, opts: ProxyPluginOptions): Promise<void> {
  // Pass request bodies through untouched so the proxy can stream them.
  // Note: the '*' wildcard does not override Fastify's built-in JSON/text
  // parsers, so those are replaced explicitly within this encapsulated context.
  const passthrough = (_request: FastifyRequest, payload: Readable, done: (err: Error | null, body?: unknown) => void) =>
    done(null, payload);
  app.removeContentTypeParser('application/json');
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('application/json', passthrough);
  app.addContentTypeParser('text/plain', passthrough);
  app.addContentTypeParser('*', passthrough);

  app.all('/*', async (req, reply) => {
    const target = opts.resolveTarget(req);
    if (!target) {
      const requestId = resolveRequestId(req.headers['x-request-id']);
      reply.status(404).header('x-request-id', requestId);
      return { error: { code: ErrorCodes.ROUTE_NOT_FOUND, message: 'No route matches this request', requestId } };
    }
    return proxyOnce(req, reply, target, opts);
  });
}
