import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useAnalyticsStream } from '../hooks/useAnalytics';
import {
  formatMs,
  formatPct,
  perRouteTraffic,
  requestsPerSecond,
  summarizeMetrics,
} from '../lib/analytics';
import { CircuitBadge, Empty, Spinner, StatCard } from '../components/ui';
import type { Route } from '@gateway/shared-types';

export function Dashboard() {
  const { user } = useAuth();
  const token = sessionStorage.getItem('gateway.admin.token');
  const { snapshot, previous, status } = useAnalyticsStream(token);
  const [routes, setRoutes] = useState<Route[] | null>(null);

  useEffect(() => {
    api
      .listRoutes()
      .then((r) => {
        setRoutes(r.routes);
      })
      .catch(() => {
        setRoutes([]);
      });
  }, []);

  const stats = snapshot ? summarizeMetrics(snapshot.metrics) : null;
  const rps = snapshot ? requestsPerSecond(previous, snapshot) : null;
  const traffic = snapshot ? perRouteTraffic(snapshot.metrics).slice(0, 8) : [];
  const circuits = snapshot?.circuits ?? {};
  const openCircuits = Object.entries(circuits).filter(([, s]) => s !== 'CLOSED');

  const statusDot =
    status === 'live' ? (
      <span className="live-dot" />
    ) : status === 'error' ? (
      <span className="live-dot dead" />
    ) : (
      <span className="live-dot paused" />
    );

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">
        {statusDot}
        {status === 'live'
          ? 'Live traffic from the gateway (2s stream)'
          : status === 'error'
            ? 'Stream disconnected — retrying'
            : 'Connecting to live stream…'}
        {snapshot && <span className="dim"> · config v{snapshot.configVersion}</span>}
      </p>

      {!snapshot ? (
        <Spinner text="Waiting for first analytics snapshot…" />
      ) : (
        stats && (
          <>
            <div className="stat-grid">
              <StatCard
                label="Total requests"
                value={stats.totalRequests.toLocaleString()}
                hint={rps !== null ? `${rps.toFixed(1)} req/s` : 'collecting rate…'}
              />
              <StatCard
                label="Error rate"
                value={formatPct(stats.errorRate)}
                hint={`${(stats.requestsByStatusClass['5xx'] ?? 0).toLocaleString()} × 5xx`}
              />
              <StatCard
                label="Avg latency"
                value={formatMs(stats.avgLatencyMs)}
                hint={`p95 ≈ ${formatMs(stats.blendedP95Ms)} (blended)`}
              />
              <StatCard
                label="Active routes"
                value={String(routes?.filter((r) => r.enabled).length ?? '—')}
                hint={`${routes?.length ?? '—'} total`}
              />
              <StatCard
                label="Rate limited"
                value={stats.rateLimited.toLocaleString()}
                hint="429 responses"
              />
              <StatCard
                label="Circuit rejected"
                value={stats.circuitRejected.toLocaleString()}
                hint="fail-fast 503s"
              />
              <StatCard
                label="Auth failures"
                value={stats.authFailures.toLocaleString()}
                hint="401 responses"
              />
              <StatCard
                label="Upstream errors"
                value={stats.upstreamErrors.toLocaleString()}
                hint="5xx / timeouts"
              />
            </div>

            <div className="card">
              <h2>Top routes by traffic</h2>
              {traffic.length === 0 ? (
                <Empty text="No proxied traffic recorded yet. Send a request through the gateway." />
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th>Requests</th>
                      <th>5xx</th>
                      <th>Avg latency</th>
                      <th>p95 (approx)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traffic.map((t) => (
                      <tr key={t.route}>
                        <td className="mono">{t.route}</td>
                        <td>{t.requests.toLocaleString()}</td>
                        <td>{t.errors5xx.toLocaleString()}</td>
                        <td>{formatMs(t.avgLatencyMs)}</td>
                        <td>{formatMs(t.p95LatencyMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h2>Circuit breakers</h2>
              {openCircuits.length === 0 ? (
                <p className="dim">
                  All observed circuits are closed. States are per gateway instance — see{' '}
                  <Link to="/circuits">Circuit breakers</Link>.
                </p>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openCircuits.map(([routeId, state]) => {
                      const route = routes?.find((r) => r.id === routeId);
                      return (
                        <tr key={routeId}>
                          <td className="mono">{route?.name ?? routeId}</td>
                          <td>
                            <CircuitBadge state={state} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )
      )}
      <p className="dim">
        Signed in as {user?.email} ({user?.role}). Analytics are live gateway data — nothing here is
        sampled or fabricated.
      </p>
    </div>
  );
}
