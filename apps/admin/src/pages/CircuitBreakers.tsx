import { useEffect, useState } from 'react';
import type { CircuitBreakerPolicy, Route } from '@gateway/shared-types';
import { api } from '../api/client';
import { useAnalyticsStream } from '../hooks/useAnalytics';
import { CircuitBadge, Empty, Spinner } from '../components/ui';

export function CircuitBreakers() {
  const token = sessionStorage.getItem('gateway.admin.token');
  const { snapshot, status } = useAnalyticsStream(token);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [policies, setPolicies] = useState<Record<string, CircuitBreakerPolicy>>({});

  useEffect(() => {
    api
      .listRoutes()
      .then((r) => {
        setRoutes(r.routes);
      })
      .catch(() => {
        setRoutes([]);
      });
    api
      .listCircuitBreakerPolicies()
      .then((p) => {
        setPolicies(Object.fromEntries(p.policies.map((x) => [x.id, x])));
      })
      .catch(() => {});
  }, []);

  const circuits = snapshot?.circuits ?? {};
  const rows = (routes ?? []).filter((r) => r.circuitBreakerPolicyId);

  return (
    <div>
      <h1 className="page-title">Circuit breakers</h1>
      <p className="page-sub">
        Live per-route breaker states from the gateway{' '}
        {status === 'live' ? (
          <span>
            <span className="live-dot" /> live
          </span>
        ) : (
          <span className="dim">({status}…)</span>
        )}
        . Breaker state is per gateway instance, so a multi-instance deployment may show mixed
        states.
      </p>

      {routes === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty text="No routes have a circuit breaker policy attached. Attach one from the route editor." />
      ) : (
        <div className="card">
          <table className="tbl">
            <thead>
              <tr>
                <th>Route</th>
                <th>State</th>
                <th>Policy</th>
                <th>Threshold</th>
                <th>Open duration</th>
                <th>Half-open probes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const policy = r.circuitBreakerPolicyId
                  ? policies[r.circuitBreakerPolicyId]
                  : undefined;
                return (
                  <tr key={r.id}>
                    <td>
                      {r.name}
                      <div className="dim mono">{r.pathPattern}</div>
                    </td>
                    <td>
                      <CircuitBadge state={circuits[r.id]} />
                    </td>
                    <td>
                      {policy?.name ?? <span className="dim mono">{r.circuitBreakerPolicyId}</span>}
                    </td>
                    <td>
                      {policy ? `${policy.failureThreshold} / ${policy.rollingWindowMs}ms` : '—'}
                    </td>
                    <td>{policy ? `${policy.openDurationMs} ms` : '—'}</td>
                    <td>{policy?.halfOpenMaxProbes ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>How it works</h2>
        <p className="dim">
          Each route with a policy gets its own breaker. Failures inside the rolling window trip it
          open; after the open duration it admits a limited number of probe requests, closing again
          on success. Open breakers fail fast with 503 <span className="mono">CIRCUIT_OPEN</span>{' '}
          instead of waiting on a sick upstream.
        </p>
      </div>
    </div>
  );
}
