import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AuditActions, AuditService } from './audit-service.js';
import {
  authenticateUser,
  hashPassword,
  registerAuthPlugin,
  requireRole,
  signToken,
  type AuthConfig,
} from './auth.js';
import type { ConfigStore } from './config-service.js';
import { withTransaction } from './db.js';
import { listAudit } from './db/audit.js';
import { bumpVersion, getCurrentVersion } from './db/config-versions.js';
import {
  circuitBreakerPolicyInputSchema,
  countRoutesUsingPolicy,
  deleteCircuitBreakerPolicy,
  deleteRateLimitPolicy,
  insertCircuitBreakerPolicy,
  insertRateLimitPolicy,
  rateLimitPolicyInputSchema,
  updateCircuitBreakerPolicy,
  updateRateLimitPolicy,
} from './db/policies.js';
import {
  deleteRoute,
  getRoute,
  insertRoute,
  listCircuitBreakerPolicies,
  listRateLimitPolicies,
  listRoutes,
  policyExists,
  updateRoute,
} from './db/routes.js';
import { createUser, deleteUser, listUsers } from './db/users.js';
import { ErrorCodes, GatewayError, toErrorResponse } from './errors.js';
import type { MetricsRegistry } from './metrics.js';
import { notifyConfigChange } from './reload.js';
import { routeInputSchema } from './routing.js';

/**
 * Admin API.
 *
 * Roles: viewer (read-only), operator (read + config reload), admin (full
 * control incl. user management). Every mutation runs in a transaction that
 * writes the change, bumps the config version, and appends an audit record;
 * only then is the reload notification published.
 */

export interface AdminDeps {
  pool: Pool;
  publisher: Redis;
  store: ConfigStore;
  audit: AuditService;
  auth: AuthConfig;
  metrics: MetricsRegistry;
}

const ROLES = ['admin', 'operator', 'viewer'] as const;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new GatewayError(
      ErrorCodes.BAD_REQUEST,
      400,
      'Invalid request body.',
      'none',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function actorOf(req: FastifyRequest): string {
  return req.authUser?.email ?? 'anonymous';
}

function notFound(resource: string, id: string): GatewayError {
  return new GatewayError(ErrorCodes.ROUTE_NOT_FOUND, 404, `${resource} ${id} not found.`);
}

export function registerAdminApi(app: FastifyInstance, deps: AdminDeps): void {
  const { pool, publisher, store, audit, auth, metrics } = deps;

  registerAuthPlugin(app, auth);

  app.setErrorHandler((err, req, reply) => {
    const requestId = String(req.id);
    if (err instanceof GatewayError) {
      const { statusCode, body } = toErrorResponse(err, requestId);
      void reply.status(statusCode).send(body);
      return;
    }
    app.log.error({ err, requestId }, 'unhandled admin API error');
    const { statusCode, body } = toErrorResponse(
      new GatewayError(ErrorCodes.INTERNAL_ERROR, 500, 'An unexpected error occurred.'),
      requestId,
    );
    void reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const { statusCode, body } = toErrorResponse(
      new GatewayError(ErrorCodes.ROUTE_NOT_FOUND, 404, `No admin route for ${req.method} ${req.url}.`),
      String(req.id),
    );
    void reply.status(statusCode).send(body);
  });

  /** Runs a mutation transactionally, then notifies instances of the new version. */
  async function mutate<T>(
    req: FastifyRequest,
    action: string,
    resourceType: string,
    resourceId: string | null,
    fn: (client: PoolClient) => Promise<{ result: T; before?: unknown }>,
  ): Promise<{ result: T; version: number }> {
    const actor = actorOf(req);
    const { result, version } = await withTransaction(pool, async (client) => {
      const { result, before } = await fn(client);
      const version = await bumpVersion(client, actor, `${action} ${resourceType}${resourceId ? ` ${resourceId}` : ''}`);
      const call: { before?: unknown } = before === undefined ? {} : { before };
      await new AuditService(client).record(
        { actor, requestId: String(req.id) },
        action,
        resourceType,
        { resourceId, after: result, ...call },
      );
      return { result, version };
    });
    await notifyConfigChange(publisher, version);
    return { result, version };
  }

  // --- auth ---------------------------------------------------------------
  app.post('/api/auth/login', async (req, reply: FastifyReply) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const user = await authenticateUser(pool, email, password);
    const token = await signToken(user, auth);
    await audit.record({ actor: user.email, requestId: String(req.id) }, AuditActions.authLogin, 'session');
    return reply.send({ token, user });
  });

  // --- routes --------------------------------------------------------------
  app.get('/api/routes', { preHandler: [requireRole('admin', 'operator', 'viewer')] }, async () => {
    return { routes: await listRoutes(pool) };
  });

  app.post('/api/routes', { preHandler: [requireRole('admin')] }, async (req, reply: FastifyReply) => {
    const input = parse(routeInputSchema, req.body);
    const { result } = await mutate(req, AuditActions.routeCreate, 'route', null, async (client) => {
      await assertPoliciesExist(client, input.rateLimitPolicyId, input.circuitBreakerPolicyId);
      const result = await insertRoute(client, input);
      return { result };
    });
    return reply.status(201).send({ route: result });
  });

  app.get<{ Params: { id: string } }>(
    '/api/routes/:id',
    { preHandler: [requireRole('admin', 'operator', 'viewer')] },
    async (req) => {
      const route = await getRoute(pool, req.params.id);
      if (!route) throw notFound('Route', req.params.id);
      return { route };
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/routes/:id',
    { preHandler: [requireRole('admin')] },
    async (req, reply: FastifyReply) => {
      const patch = parse(routeInputSchema.partial(), req.body);
      const { result } = await mutate(req, AuditActions.routeUpdate, 'route', req.params.id, async (client) => {
        const before = await getRoute(client, req.params.id);
        if (!before) throw notFound('Route', req.params.id);
        await assertPoliciesExist(client, patch.rateLimitPolicyId, patch.circuitBreakerPolicyId);
        const result = await updateRoute(client, req.params.id, patch);
        return { result: result!, before };
      });
      return reply.send({ route: result });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/routes/:id',
    { preHandler: [requireRole('admin')] },
    async (req) => {
      const { result } = await mutate(req, AuditActions.routeDelete, 'route', req.params.id, async (client) => {
        const before = await deleteRoute(client, req.params.id);
        if (!before) throw notFound('Route', req.params.id);
        return { result: { deleted: true }, before };
      });
      return result;
    },
  );

  // --- rate limit policies ---------------------------------------------------
  app.get('/api/rate-limit-policies', { preHandler: [requireRole('admin', 'operator', 'viewer')] }, async () => {
    return { policies: await listRateLimitPolicies(pool) };
  });

  app.post('/api/rate-limit-policies', { preHandler: [requireRole('admin')] }, async (req, reply: FastifyReply) => {
    const input = parse(rateLimitPolicyInputSchema, req.body);
    const { result } = await mutate(req, AuditActions.rateLimitPolicyCreate, 'rate_limit_policy', null, async (client) => {
      const result = await insertRateLimitPolicy(client, input);
      return { result };
    });
    return reply.status(201).send({ policy: result });
  });

  app.put<{ Params: { id: string } }>(
    '/api/rate-limit-policies/:id',
    { preHandler: [requireRole('admin')] },
    async (req, reply: FastifyReply) => {
      const patch = parse(rateLimitPolicyInputSchema.partial(), req.body);
      const { result } = await mutate(req, AuditActions.rateLimitPolicyUpdate, 'rate_limit_policy', req.params.id, async (client) => {
        const result = await updateRateLimitPolicy(client, req.params.id, patch);
        if (!result) throw notFound('Rate limit policy', req.params.id);
        return { result };
      });
      return reply.send({ policy: result });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/rate-limit-policies/:id',
    { preHandler: [requireRole('admin')] },
    async (req) => {
      const { result } = await mutate(req, AuditActions.rateLimitPolicyDelete, 'rate_limit_policy', req.params.id, async (client) => {
        const used = await countRoutesUsingPolicy(client, 'rate_limit_policy_id', req.params.id);
        if (used > 0) {
          throw new GatewayError(ErrorCodes.CONFLICT, 409, `Policy is referenced by ${used} route(s).`);
        }
        const before = await deleteRateLimitPolicy(client, req.params.id);
        if (!before) throw notFound('Rate limit policy', req.params.id);
        return { result: { deleted: true }, before };
      });
      return result;
    },
  );

  // --- circuit breaker policies -----------------------------------------------
  app.get('/api/circuit-breaker-policies', { preHandler: [requireRole('admin', 'operator', 'viewer')] }, async () => {
    return { policies: await listCircuitBreakerPolicies(pool) };
  });

  app.post('/api/circuit-breaker-policies', { preHandler: [requireRole('admin')] }, async (req, reply: FastifyReply) => {
    const input = parse(circuitBreakerPolicyInputSchema, req.body);
    const { result } = await mutate(req, AuditActions.circuitPolicyCreate, 'circuit_breaker_policy', null, async (client) => {
      const result = await insertCircuitBreakerPolicy(client, input);
      return { result };
    });
    return reply.status(201).send({ policy: result });
  });

  app.put<{ Params: { id: string } }>(
    '/api/circuit-breaker-policies/:id',
    { preHandler: [requireRole('admin')] },
    async (req, reply: FastifyReply) => {
      const patch = parse(circuitBreakerPolicyInputSchema.partial(), req.body);
      const { result } = await mutate(req, AuditActions.circuitPolicyUpdate, 'circuit_breaker_policy', req.params.id, async (client) => {
        const result = await updateCircuitBreakerPolicy(client, req.params.id, patch);
        if (!result) throw notFound('Circuit breaker policy', req.params.id);
        return { result };
      });
      return reply.send({ policy: result });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/circuit-breaker-policies/:id',
    { preHandler: [requireRole('admin')] },
    async (req) => {
      const { result } = await mutate(req, AuditActions.circuitPolicyDelete, 'circuit_breaker_policy', req.params.id, async (client) => {
        const used = await countRoutesUsingPolicy(client, 'circuit_breaker_policy_id', req.params.id);
        if (used > 0) {
          throw new GatewayError(ErrorCodes.CONFLICT, 409, `Policy is referenced by ${used} route(s).`);
        }
        const before = await deleteCircuitBreakerPolicy(client, req.params.id);
        if (!before) throw notFound('Circuit breaker policy', req.params.id);
        return { result: { deleted: true }, before };
      });
      return result;
    },
  );

  // --- users (admin only) -------------------------------------------------------
  app.get('/api/users', { preHandler: [requireRole('admin')] }, async () => {
    return { users: await listUsers(pool) };
  });

  app.post('/api/users', { preHandler: [requireRole('admin')] }, async (req, reply: FastifyReply) => {
    const input = parse(
      z.object({
        email: z.string().email().max(200),
        password: z.string().min(12).max(200),
        role: z.enum(ROLES),
      }),
      req.body,
    );
    const { result } = await mutate(req, AuditActions.userCreate, 'user', null, async (client) => {
      const passwordHash = await hashPassword(input.password);
      const user = await createUser(client, { email: input.email, passwordHash, role: input.role });
      return { result: { id: user.id, email: user.email, role: user.role } };
    });
    return reply.status(201).send({ user: result });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: [requireRole('admin')] },
    async (req) => {
      if (req.authUser?.sub === req.params.id) {
        throw new GatewayError(ErrorCodes.BAD_REQUEST, 400, 'You cannot delete your own account.');
      }
      const { result } = await mutate(req, AuditActions.userDelete, 'user', req.params.id, async (client) => {
        const deleted = await deleteUser(client, req.params.id);
        if (!deleted) throw notFound('User', req.params.id);
        return { result: { deleted: true } };
      });
      return result;
    },
  );

  // --- audit log (read) ----------------------------------------------------------
  app.get<{ Querystring: Record<string, string> }>(
    '/api/audit',
    { preHandler: [requireRole('admin', 'operator', 'viewer')] },
    async (req) => {
      const q = req.query;
      const limit = Math.min(Number(q['limit'] ?? 50) || 50, 500);
      const offset = Math.max(Number(q['offset'] ?? 0) || 0, 0);
      return listAudit(pool, {
        ...(q['actor'] ? { actor: q['actor'] } : {}),
        ...(q['action'] ? { action: q['action'] } : {}),
        ...(q['resourceType'] ? { resourceType: q['resourceType'] } : {}),
        ...(q['resourceId'] ? { resourceId: q['resourceId'] } : {}),
        ...(q['since'] ? { since: q['since'] } : {}),
        ...(q['until'] ? { until: q['until'] } : {}),
        limit,
        offset,
      });
    },
  );

  // --- config ----------------------------------------------------------------------
  app.get('/api/config/version', { preHandler: [requireRole('admin', 'operator', 'viewer')] }, async () => {
    return { version: store.version(), dbVersion: await getCurrentVersion(pool) };
  });

  app.post('/api/config/reload', { preHandler: [requireRole('admin', 'operator')] }, async () => {
    const version = await getCurrentVersion(pool);
    await notifyConfigChange(publisher, version);
    return { reloaded: true, version };
  });

  // --- metrics -----------------------------------------------------------------------
  app.get('/api/metrics', { preHandler: [requireRole('admin', 'operator', 'viewer')] }, async () => {
    return metrics.snapshot();
  });

  async function assertPoliciesExist(
    client: PoolClient,
    rateLimitPolicyId: string | null | undefined,
    circuitBreakerPolicyId: string | null | undefined,
  ): Promise<void> {
    if (rateLimitPolicyId != null && !(await policyExists(client, 'rate_limit_policies', rateLimitPolicyId))) {
      throw new GatewayError(ErrorCodes.UNPROCESSABLE, 422, `Rate limit policy ${rateLimitPolicyId} does not exist.`);
    }
    if (
      circuitBreakerPolicyId != null &&
      !(await policyExists(client, 'circuit_breaker_policies', circuitBreakerPolicyId))
    ) {
      throw new GatewayError(ErrorCodes.UNPROCESSABLE, 422, `Circuit breaker policy ${circuitBreakerPolicyId} does not exist.`);
    }
  }
}
