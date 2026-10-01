import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AuditRecord, Route } from '@gateway/shared-types';
import { api } from '../api/client';
import { can, useAuth } from '../auth/AuthContext';
import { Badge, EnabledBadge, ErrorBox, Spinner, timeAgo } from '../components/ui';

export function RouteDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [route, setRoute] = useState<Route | null>(null);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getRoute(id),
      api
        .listAudit({ resourceType: 'route', resourceId: id, limit: 10 })
        .catch(() => ({ records: [] })),
    ])
      .then(([r, a]) => {
        setRoute(r.route);
        setAudit(a.records);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [id]);

  if (error) return <ErrorBox error={error} />;
  if (!route) return <Spinner />;

  const fields: [string, React.ReactNode][] = [
    ['Name', route.name],
    ['Path pattern', <span className="mono">{route.pathPattern}</span>],
    ['Methods', route.methods.join(', ')],
    ['Upstream URL', <span className="mono">{route.upstreamUrl}</span>],
    ['Status', <EnabledBadge enabled={route.enabled} />],
    ['Priority', String(route.priority)],
    [
      'Auth required',
      route.authRequired ? (
        <Badge color="blue">JWT required</Badge>
      ) : (
        <Badge color="gray">public</Badge>
      ),
    ],
    [
      'Rate limit policy',
      route.rateLimitPolicyId ? <span className="mono">{route.rateLimitPolicyId}</span> : 'none',
    ],
    [
      'Circuit breaker policy',
      route.circuitBreakerPolicyId ? (
        <span className="mono">{route.circuitBreakerPolicyId}</span>
      ) : (
        'none'
      ),
    ],
    ['Timeout', `${route.timeoutMs} ms`],
    ['Route version', String(route.version)],
    ['Updated', `${timeAgo(route.updatedAt)} (${route.updatedAt})`],
  ];

  return (
    <div>
      <h1 className="page-title">{route.name}</h1>
      <p className="page-sub">
        <Link to="/routes">← Back to routes</Link>
        {can(user, 'manage') && (
          <>
            {' · '}
            <Link to={`/routes/${route.id}/edit`}>Edit</Link>
          </>
        )}
      </p>

      <div className="card">
        <h2>Configuration</h2>
        <table className="tbl">
          <tbody>
            {fields.map(([k, v]) => (
              <tr key={k}>
                <th style={{ width: 200 }}>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Plugin config</h3>
        <pre className="json">{JSON.stringify(route.pluginConfig, null, 2)}</pre>
      </div>

      <div className="card">
        <h2>Recent changes</h2>
        {audit.length === 0 ? (
          <p className="dim">No audit records for this route yet.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="dim">{timeAgo(a.createdAt)}</td>
                  <td>{a.actor}</td>
                  <td className="mono">{a.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
