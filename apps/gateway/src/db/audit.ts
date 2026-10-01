import type { DbClient } from '../db.js';

export interface AuditRecord {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditInput {
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Append-only: the application never updates or deletes audit records. */
export async function appendAudit(client: DbClient, input: AuditInput): Promise<AuditRecord> {
  const res = await client.query(
    `INSERT INTO audit_logs (actor, action, resource_type, resource_id, "before", "after", request_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, created_at, actor, action, resource_type, resource_id, "before", "after", request_id, metadata`,
    [
      input.actor,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.requestId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const r = res.rows[0] as Record<string, unknown>;
  return {
    id: r['id'] as string,
    createdAt: (r['created_at'] as Date).toISOString(),
    actor: r['actor'] as string,
    action: r['action'] as string,
    resourceType: r['resource_type'] as string,
    resourceId: r['resource_id'] as string | null,
    before: r['before'],
    after: r['after'],
    requestId: r['request_id'] as string | null,
    metadata: (r['metadata'] as Record<string, unknown>) ?? {},
  };
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export async function listAudit(client: DbClient, filter: AuditFilter = {}): Promise<{ records: AuditRecord[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(`${sql} $${values.length}`);
  };
  if (filter.actor) add('actor =', filter.actor);
  if (filter.action) add('action =', filter.action);
  if (filter.resourceType) add('resource_type =', filter.resourceType);
  if (filter.resourceId) add('resource_id =', filter.resourceId);
  if (filter.since) add('created_at >=', filter.since);
  if (filter.until) add('created_at <=', filter.until);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filter.limit ?? 50, 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  const countRes = await client.query(`SELECT COUNT(*)::int AS total FROM audit_logs ${where}`, values);
  const res = await client.query(
    `SELECT id, created_at, actor, action, resource_type, resource_id, "before", "after", request_id, metadata
     FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    values,
  );
  const records = res.rows.map((r) => ({
    id: r.id as string,
    createdAt: (r.created_at as Date).toISOString(),
    actor: r.actor as string,
    action: r.action as string,
    resourceType: r.resource_type as string,
    resourceId: r.resource_id as string | null,
    before: r.before as unknown,
    after: r.after as unknown,
    requestId: r.request_id as string | null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
  }));
  return { records, total: (countRes.rows[0] as { total: number }).total };
}
