import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { ErrorBody } from '@gateway/shared-types';
import { registerAdminApi } from './admin.js';
import { requireRole, type AuthConfig } from './auth.js';
import type { AuditService } from './audit-service.js';
import { CircuitBreakerRegistry, type UpstreamOutcome } from './circuit-breaker.js';
import type { GatewayConfig } from './config.js';
import type { ConfigStore } from './config-service.js';
import { ErrorCodes } from './errors.js';
import { liveness, readiness } from './health.js';
import { MetricsRegistry } from './metrics.js';
import { PluginManager, type PluginRequest } from './plugins.js';
import { proxyRequest, resolveRequestId } from './proxy.js';
import { checkRateLimit } from './rate-limit.js';
import { matchCompiled } from './routing.js';

export interface ServerDeps {
  config: GatewayConfig;
  pool: Pool;
  /** Redis connection used for rate limiting. */
  redis: Redis;
  /** Redis connection used for publishing reload notifications. */
  publisher: Redis;
  store: ConfigStore;
  plugins: PluginManager;
  metrics: MetricsRegistry;
  breakers: CircuitBreakerRegistry;
  auth: AuthConfig;
  audit: AuditService;
}

function errorBody(code: string, message: string, requestId: string): ErrorBody {
  return { error: { code, message, requestId } };
}

/**
 * Build the gateway Fastify app: health checks, admin API, SSE analytics,
 * and the catch-all request pipeline (route match -> auth -> plugins ->
 * rate limit -> circuit breaker -> proxy).
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const loggerOptions = config.logPretty
    ? { level: config.logLevel, transport: { target: 'pino-pretty' } }
    : { level: config.logLevel };
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: true,
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: config.corsAllowedOrigins.length > 0 ? config.corsAllowedOrigins : true,
    credentials: true,
  });

  const startedAt = Date.now();

  app.get('/health', () => liveness().body);

  app.get('/ready', async (req, reply: FastifyReply) => {
    const result = await readiness(
      {
        database: async () => {
          await deps.pool.query('SELECT 1');
          return true;
        },
        redis: async () => {
          await deps.redis.ping();
          return true;
        },
      },
      {
        configVersion: deps.store.current().version,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      },
    );
    reply.status(result.statusCode).send(result.body);
  });

  // Admin API (auth plugin + RBAC + JSON error handling included).
  registerAdminApi(app, {
    pool: deps.pool,
    publisher: deps.publisher,
    store: deps.store,
    audit: deps.audit,
    auth: deps.auth,
    metrics: deps.metrics,
  });

  // SSE analytics stream for operators and admins.
  app.get(
    '/api/analytics/stream',
    { preHandler: requireRole('operator') },
    async (req, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (): void => {
        const snapshot = {
          timestamp: new Date().toISOString(),
          configVersion: deps.store.current().version,
          metrics: deps.metrics.snapshot(),
          circuits: deps.breakers.states(),
        };
        reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      };
      send();
      const timer = setInterval(send, 2000);
      timer.unref();
      req.raw.on('close', () => {
        clearInterval(timer);
      });
    },
  );

  // The gateway pipeline. A not-found handler (rather than a wildcard route)
  // so it never collides with explicit admin/health routes or the CORS
  // preflight route: anything unmatched falls through to route matching.
  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    const started = Date.now();
    const finish = (status: number, labels: Record<string, string> = {}): void => {
      deps.metrics.inc('gateway.requests', { status: String(status), ...labels });
      deps.metrics.observeLatency('gateway.request.duration', { ...labels }, Date.now() - started);
    };

    const snapshot = deps.store.current();
    const match = matchCompiled(snapshot.routes, req.method, req.url);
    if (!match) {
      finish(404, { route: 'unmatched' });
      reply.status(404).header('x-request-id', requestId);
      return errorBody(ErrorCodes.ROUTE_NOT_FOUND, 'No route matches this request.', requestId);
    }
    const { route } = match;
    const labels = { route: route.name };

    if (route.authRequired && !req.authUser) {
      finish(401, labels);
      deps.metrics.inc('gateway.auth_failures', labels);
      reply.status(401).header('x-request-id', requestId);
      return errorBody(
        ErrorCodes.AUTHENTICATION_ERROR,
        'Authentication required for this route.',
        requestId,
      );
    }

    const pluginRequest: PluginRequest = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      route,
      requestId,
      ip: req.ip,
      ...(req.authUser
        ? {
            authUser: { sub: req.authUser.sub, email: req.authUser.email, role: req.authUser.role },
          }
        : {}),
    };

    const shortCircuit = await deps.plugins.runOnRequest(pluginRequest, route);
    if (shortCircuit) {
      reply.status(shortCircuit.statusCode);
      for (const [name, value] of Object.entries(shortCircuit.headers ?? {})) {
        reply.header(name, value);
      }
      reply.header('x-request-id', requestId);
      finish(shortCircuit.statusCode, labels);
      await deps.plugins.runOnResponse(
        {
          statusCode: shortCircuit.statusCode,
          headers: reply.getHeaders() as Record<string, string | string[] | undefined>,
        },
        route,
      );
      return shortCircuit.body ?? '';
    }

    if (route.rateLimitPolicyId) {
      const policy = snapshot.rateLimitPolicies.get(route.rateLimitPolicyId);
      if (policy) {
        const result = await checkRateLimit(deps.redis, policy, {
          ip: req.ip,
          routeId: route.id,
          ...(req.authUser ? { userId: req.authUser.sub } : {}),
        });
        reply.header('x-ratelimit-remaining', result.remaining);
        if (!result.allowed) {
          reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
          finish(429, labels);
          deps.metrics.inc('gateway.rate_limited', labels);
          reply.status(429).header('x-request-id', requestId);
          return errorBody(
            ErrorCodes.RATE_LIMIT_EXCEEDED,
            `Rate limit exceeded for policy "${policy.name}".`,
            requestId,
          );
        }
      }
    }

    const breakerPolicy = route.circuitBreakerPolicyId
      ? snapshot.circuitBreakerPolicies.get(route.circuitBreakerPolicyId)
      : undefined;
    if (breakerPolicy) {
      const { allowed } = deps.breakers.canRequest(route.id, breakerPolicy);
      if (!allowed) {
        finish(503, labels);
        deps.metrics.inc('gateway.circuit_rejected', labels);
        reply.status(503).header('x-request-id', requestId);
        return errorBody(
          ErrorCodes.CIRCUIT_OPEN,
          `Circuit breaker is open for route "${route.name}".`,
          requestId,
        );
      }
    }

    const outcome = await proxyRequest(
      req,
      reply,
      {
        upstreamBase: route.upstreamUrl,
        upstreamPath: match.upstreamPath,
        timeoutMs: route.timeoutMs,
      },
      {
        config,
        getClientIp: (r) => r.ip,
        onSettled: (info) => {
          deps.metrics.inc('gateway.upstream', {
            route: route.name,
            status: String(info.statusCode ?? 0),
          });
          // Record the breaker outcome here (not after proxyRequest resolves):
          // onSettled fires before dispatcher teardown, so the recorded state
          // is visible to the next admitted request.
          if (breakerPolicy) {
            const upstreamOutcome: UpstreamOutcome =
              info.failureKind === 'none'
                ? { kind: 'success' }
                : info.failureKind === 'timeout'
                  ? { kind: 'timeout' }
                  : { kind: 'status', status: info.statusCode ?? 0 };
            deps.breakers.record(route.id, breakerPolicy, upstreamOutcome);
          }
        },
      },
    );

    if (outcome.failureKind === 'none') {
      await deps.plugins.runOnResponse(
        {
          statusCode: outcome.statusCode,
          headers: reply.getHeaders() as Record<string, string | string[] | undefined>,
        },
        route,
      );
    } else {
      await deps.plugins.runOnError(new Error(`upstream ${outcome.failureKind}`), route);
    }

    finish(outcome.statusCode, labels);
    return;
  });

  return app;
}

export { CircuitBreakerRegistry, MetricsRegistry, PluginManager };
