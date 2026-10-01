import { describe, expect, it } from 'vitest';
import { AuditActions, AuditService } from '../../src/audit-service.js';

describe('AuditService', () => {
  it('records actions with actor, request id, and before/after', async () => {
    const seen: unknown[] = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        seen.push({ sql, params });
        return {
          rows: [
            {
              id: 'a1',
              created_at: new Date('2026-01-01T00:00:00Z'),
              actor: params[0],
              action: params[1],
              resource_type: params[2],
              resource_id: params[3],
              before: params[4],
              after: params[5],
              request_id: params[6],
              metadata: params[7],
            },
          ],
        };
      },
    } as never;

    const audit = new AuditService(db);
    await audit.record(
      { actor: 'admin@example.local', requestId: 'req-42' },
      AuditActions.routeUpdate,
      'route',
      { resourceId: 'r1', before: { priority: 100 }, after: { priority: 200 } },
    );

    expect(seen).toHaveLength(1);
    const params = (seen[0] as { params: unknown[] }).params;
    expect(params[0]).toBe('admin@example.local');
    expect(params[1]).toBe('route.update');
    expect(params[2]).toBe('route');
    expect(params[3]).toBe('r1');
    expect(params[6]).toBe('req-42');
    expect(JSON.parse(params[4] as string)).toEqual({ priority: 100 });
    expect(JSON.parse(params[5] as string)).toEqual({ priority: 200 });
  });

  it('omits optional fields cleanly when not provided', async () => {
    let captured: unknown[] = [];
    const db = {
      query: async (_sql: string, params: unknown[]) => {
        captured = params;
        return { rows: [{ id: 'a1', created_at: new Date(), metadata: {} }] };
      },
    } as never;
    const audit = new AuditService(db);
    await audit.record({ actor: 'system' }, AuditActions.authLogin, 'session');
    expect(captured[0]).toBe('system');
    expect(captured[3]).toBeNull(); // resource_id
    expect(captured[4]).toBeNull(); // before
    expect(captured[6]).toBeNull(); // request_id
  });
});
