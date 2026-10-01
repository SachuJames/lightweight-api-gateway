import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CircuitBreakerPolicy, RateLimitPolicy, Route } from '@gateway/shared-types';
import { api } from '../api/client';
import { can, useAuth } from '../auth/AuthContext';
import { useAnalyticsStream } from '../hooks/useAnalytics';
import { CircuitBadge, ConfirmDialog, EnabledBadge, ErrorBox, Spinner } from '../components/ui';

export function Routes() {
  const { user } = useAuth();
  const token = sessionStorage.getItem('gateway.admin.token');
  const { snapshot } = useAnalyticsStream(token);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [rlPolicies, setRlPolicies] = useState<Record<string, string>>({});
  const [cbPolicies, setCbPolicies] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Route | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, rl, cb] = await Promise.all([
        api.listRoutes(),
        api.listRateLimitPolicies().catch(() => ({ policies: [] as RateLimitPolicy[] })),
        api.listCircuitBreakerPolicies().catch(() => ({ policies: [] as CircuitBreakerPolicy[] })),
      ]);
      setRoutes(r.routes);
      setRlPolicies(Object.fromEntries(rl.policies.map((p) => [p.id, p.name])));
      setCbPolicies(Object.fromEntries(cb.policies.map((p) => [p.id, p.name])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (route: Route) => {
    setToggling(route.id);
    setNotice(null);
    try {
      const res = await api.updateRoute(route.id, { enabled: !route.enabled });
      setNotice(`Configuration updated — now at config version ${res.version}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setToggling(null);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    try {
      await api.deleteRoute(confirmDelete.id);
      setConfirmDelete(null);
      setNotice(`Route "${confirmDelete.name}" deleted.`);
      await load();
    } catch (err) {
      setConfirmDelete(null);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const manageable = can(user, 'manage');

  return (
    <div>
      <h1 className="page-title">Routes</h1>
      <p className="page-sub">
        Proxy routes are matched in priority order. Changes apply without restarts.
      </p>

      {notice && <div className="alert success">{notice}</div>}
      {error && <ErrorBox error={error} onRetry={() => void load()} />}

      <div className="toolbar">
        <span className="spacer" />
        {manageable && (
          <Link className="btn primary" to="/routes/new">
            New route
          </Link>
        )}
      </div>

      {routes === null ? (
        <Spinner />
      ) : routes.length === 0 ? (
        <div className="empty">No routes configured yet.</div>
      ) : (
        <div className="card">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Path</th>
                <th>Upstream</th>
                <th>Rate limit</th>
                <th>Circuit</th>
                <th>Status</th>
                <th>Circuit state</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/routes/${r.id}`}>{r.name}</Link>
                    <div className="dim mono">{r.methods.join(', ')}</div>
                  </td>
                  <td className="mono">{r.pathPattern}</td>
                  <td className="mono dim">{r.upstreamUrl}</td>
                  <td className="dim">
                    {r.rateLimitPolicyId ? (rlPolicies[r.rateLimitPolicyId] ?? '…') : '—'}
                  </td>
                  <td className="dim">
                    {r.circuitBreakerPolicyId ? (cbPolicies[r.circuitBreakerPolicyId] ?? '…') : '—'}
                  </td>
                  <td>
                    <EnabledBadge enabled={r.enabled} />
                  </td>
                  <td>
                    <CircuitBadge state={snapshot?.circuits[r.id]} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {manageable && (
                      <>
                        <button
                          className="btn-link"
                          disabled={toggling === r.id}
                          onClick={() => void toggle(r)}
                        >
                          {r.enabled ? 'Disable' : 'Enable'}
                        </button>{' '}
                        <Link className="btn-link" to={`/routes/${r.id}/edit`}>
                          Edit
                        </Link>{' '}
                        <button
                          className="btn-link danger"
                          onClick={() => {
                            setConfirmDelete(r);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete route"
          body={`Delete route "${confirmDelete.name}" (${confirmDelete.pathPattern})? Traffic to it will return 404. This cannot be undone.`}
          confirmLabel="Delete route"
          onConfirm={() => void remove()}
          onCancel={() => {
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}
