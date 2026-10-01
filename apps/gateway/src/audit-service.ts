import { appendAudit, type AuditInput } from './db/audit.js';
import type { DbClient } from './db.js';

/**
 * Audit trail service.
 *
 * Every mutating admin action is recorded with who did it, what changed
 * (before/after), and which request caused it. Records are append-only —
 * nothing in the application updates or deletes them.
 */

export const AuditActions = {
  authLogin: 'auth.login',
  routeCreate: 'route.create',
  routeUpdate: 'route.update',
  routeDelete: 'route.delete',
  rateLimitPolicyCreate: 'ratelimit.create',
  rateLimitPolicyUpdate: 'ratelimit.update',
  rateLimitPolicyDelete: 'ratelimit.delete',
  circuitPolicyCreate: 'circuit.create',
  circuitPolicyUpdate: 'circuit.update',
  circuitPolicyDelete: 'circuit.delete',
  userCreate: 'user.create',
  userDelete: 'user.delete',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export interface AuditContext {
  actor: string;
  requestId?: string | undefined;
}

export class AuditService {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  async record(
    ctx: AuditContext,
    action: AuditAction | string,
    resourceType: string,
    details: {
      resourceId?: string | null | undefined;
      before?: unknown;
      after?: unknown;
      metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<void> {
    const input: AuditInput = {
      actor: ctx.actor,
      action,
      resourceType,
      ...(details.resourceId !== undefined ? { resourceId: details.resourceId } : {}),
      ...(details.before !== undefined ? { before: details.before } : {}),
      ...(details.after !== undefined ? { after: details.after } : {}),
      ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
      ...(details.metadata !== undefined ? { metadata: details.metadata } : {}),
    };
    await appendAudit(this.db, input);
  }
}
