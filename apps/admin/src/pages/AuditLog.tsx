import { useCallback, useEffect, useState } from 'react';
import type { AuditRecord } from '@gateway/shared-types';
import { api } from '../api/client';
import { Badge, Empty, ErrorBox, Spinner, timeAgo } from '../components/ui';

const PAGE_SIZE = 50;

export function AuditLog() {
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [filters, setFilters] = useState({ actor: '', action: '', resourceType: '' });
  const [applied, setApplied] = useState({ actor: '', action: '', resourceType: '' });

  const load = useCallback(async () => {
    try {
      const res = await api.listAudit({ ...applied, limit: PAGE_SIZE, offset });
      setRecords(res.records);
      setTotal(res.total ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [applied, offset]);

  useEffect(() => {
    setRecords(null);
    void load();
  }, [load]);

  const apply = () => {
    setOffset(0);
    setApplied(filters);
  };

  return (
    <div>
      <h1 className="page-title">Audit log</h1>
      <p className="page-sub">
        Append-only record of every configuration change. Entries are never edited or deleted.
      </p>

      {error && <ErrorBox error={error} onRetry={() => void load()} />}

      <div className="card">
        <div className="toolbar">
          <input
            placeholder="Actor"
            value={filters.actor}
            onChange={(e) => {
              setFilters((f) => ({ ...f, actor: e.target.value }));
            }}
            style={{ maxWidth: 200 }}
          />
          <input
            placeholder="Action (e.g. route.update)"
            value={filters.action}
            onChange={(e) => {
              setFilters((f) => ({ ...f, action: e.target.value }));
            }}
            style={{ maxWidth: 220 }}
          />
          <input
            placeholder="Resource type"
            value={filters.resourceType}
            onChange={(e) => {
              setFilters((f) => ({ ...f, resourceType: e.target.value }));
            }}
            style={{ maxWidth: 180 }}
          />
          <button className="btn secondary small" onClick={apply}>
            Filter
          </button>
          <span className="spacer" />
          <span className="dim">{total.toLocaleString()} entries</span>
        </div>

        {records === null ? (
          <Spinner />
        ) : records.length === 0 ? (
          <Empty text="No audit records match." />
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Request ID</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td className="dim" style={{ whiteSpace: 'nowrap' }} title={r.createdAt}>
                      {timeAgo(r.createdAt)}
                    </td>
                    <td>{r.actor}</td>
                    <td>
                      <Badge color="blue">{r.action}</Badge>
                    </td>
                    <td className="mono dim">
                      {r.resourceType}
                      {r.resourceId ? ` · ${r.resourceId.slice(0, 8)}` : ''}
                    </td>
                    <td className="mono dim">{r.requestId?.slice(0, 8) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="toolbar" style={{ marginTop: 16, marginBottom: 0 }}>
              <button
                className="btn secondary small"
                disabled={offset === 0}
                onClick={() => {
                  setOffset((o) => Math.max(0, o - PAGE_SIZE));
                }}
              >
                ← Newer
              </button>
              <span className="dim">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <button
                className="btn secondary small"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => {
                  setOffset((o) => o + PAGE_SIZE);
                }}
              >
                Older →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
