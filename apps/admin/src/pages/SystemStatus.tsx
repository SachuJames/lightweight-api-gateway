import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { can, useAuth } from '../auth/AuthContext';
import { formatMs, summarizeMetrics } from '../lib/analytics';
import { Badge, Empty, ErrorBox, Spinner } from '../components/ui';
import type { ConfigVersionInfo, MetricsSnapshot } from '@gateway/shared-types';

export function SystemStatus() {
  const { user } = useAuth();
  const reloadable = can(user, 'reload');
  const [readiness, setReadiness] = useState<Record<string, unknown> | null>(null);
  const [version, setVersion] = useState<ConfigVersionInfo | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, v, m] = await Promise.all([
        api.getReadiness(),
        api.getConfigVersion(),
        api.getMetrics(),
      ]);
      setReadiness(r);
      setVersion(v);
      setMetrics(m);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => {
      clearInterval(t);
    };
  }, [load]);

  const reload = async () => {
    setReloading(true);
    setNotice(null);
    try {
      const res = await api.reloadConfig();
      setNotice(
        `Reload notification published — config version ${res.version}. Instances converge within seconds.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setReloading(false);
    }
  };

  const checks = (readiness?.['checks'] as Record<string, 'ok' | 'unreachable'> | undefined) ?? {};
  const stats = metrics ? summarizeMetrics(metrics) : null;
  const uptimeSec = typeof readiness?.['uptimeSec'] === 'number' ? readiness['uptimeSec'] : null;

  return (
    <div>
      <h1 className="page-title">System status</h1>
      <p className="page-sub">Health, dependencies, and the active configuration version.</p>

      {notice && <div className="alert success">{notice}</div>}
      {error && <ErrorBox error={error} onRetry={() => void load()} />}

      <div className="card">
        <h2>Dependencies</h2>
        {!readiness ? (
          <Spinner />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Component</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(checks).map(([name, state]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>
                    {state === 'ok' ? (
                      <Badge color="green">ok</Badge>
                    ) : (
                      <Badge color="red">unreachable</Badge>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Gateway</td>
                <td>
                  {readiness['status'] === 'ok' ? (
                    <Badge color="green">ready</Badge>
                  ) : (
                    <Badge color="yellow">degraded</Badge>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="dim">
          {uptimeSec !== null && (
            <>
              Uptime: {Math.floor(uptimeSec / 3600)}h {Math.floor((uptimeSec % 3600) / 60)}m.
            </>
          )}{' '}
          A failing dependency makes /ready return 503 so orchestrators stop routing to this
          instance.
        </p>
      </div>

      <div className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>Configuration</h2>
          <span className="spacer" />
          {reloadable && (
            <button
              className="btn secondary small"
              onClick={() => void reload()}
              disabled={reloading}
            >
              {reloading ? 'Reloading…' : 'Trigger reload'}
            </button>
          )}
        </div>
        {!version ? (
          <Spinner />
        ) : (
          <table className="tbl">
            <tbody>
              <tr>
                <th style={{ width: 260 }}>Active config version (this instance)</th>
                <td className="mono">v{version.version}</td>
              </tr>
              <tr>
                <th>Latest version in database</th>
                <td className="mono">v{version.dbVersion}</td>
              </tr>
              <tr>
                <th>Converged</th>
                <td>
                  {version.version === version.dbVersion ? (
                    <Badge color="green">in sync</Badge>
                  ) : (
                    <Badge color="yellow">catching up</Badge>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="dim">
          Config changes publish a Redis notification; every instance reloads and swaps its snapshot
          atomically. A 15s database poll catches any missed notification.
        </p>
      </div>

      <div className="card">
        <h2>Traffic counters (this instance)</h2>
        {!stats ? (
          <Spinner />
        ) : (
          <div className="stat-grid" style={{ marginBottom: 0 }}>
            <div className="stat-card">
              <div className="label">Requests</div>
              <div className="value">{stats.totalRequests.toLocaleString()}</div>
            </div>
            <div className="stat-card">
              <div className="label">Config reloads</div>
              <div className="value">
                {Object.entries(metrics?.counters ?? {})
                  .filter(([k]) => k.startsWith('gateway.config_reloads'))
                  .reduce((a, [, v]) => a + v, 0)
                  .toLocaleString()}
              </div>
            </div>
            <div className="stat-card">
              <div className="label">Avg latency</div>
              <div className="value">{formatMs(stats.avgLatencyMs)}</div>
            </div>
            <div className="stat-card">
              <div className="label">Max latency</div>
              <div className="value">{formatMs(stats.maxLatencyMs)}</div>
            </div>
          </div>
        )}
        {stats && stats.totalRequests === 0 && (
          <Empty text="No requests recorded yet on this instance." />
        )}
      </div>
    </div>
  );
}
