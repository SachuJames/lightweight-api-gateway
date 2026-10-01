import { useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CircuitBreakerPolicy, HttpMethod, RateLimitPolicy } from '@gateway/shared-types';
import { api, ApiError } from '../api/client';
import type { RouteInput } from '../api/client';
import { Spinner } from '../components/ui';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

const EMPTY: RouteInput = {
  name: '',
  pathPattern: '',
  methods: ['GET'],
  upstreamUrl: '',
  enabled: true,
  priority: 0,
  authRequired: false,
  rateLimitPolicyId: null,
  circuitBreakerPolicyId: null,
  timeoutMs: 30000,
  pluginConfig: {},
};

export function RouteForm() {
  const { id } = useParams<{ id: string }>();
  const editing = id !== undefined && id !== 'new';
  const navigate = useNavigate();
  const [form, setForm] = useState<RouteInput>(EMPTY);
  const [pluginJson, setPluginJson] = useState('{}');
  const [rlPolicies, setRlPolicies] = useState<RateLimitPolicy[]>([]);
  const [cbPolicies, setCbPolicies] = useState<CircuitBreakerPolicy[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.listRateLimitPolicies(), api.listCircuitBreakerPolicies()])
      .then(([rl, cb]) => {
        setRlPolicies(rl.policies);
        setCbPolicies(cb.policies);
      })
      .catch(() => {});
    if (editing && id) {
      api
        .getRoute(id)
        .then(({ route }) => {
          setForm({
            name: route.name,
            pathPattern: route.pathPattern,
            methods: route.methods,
            upstreamUrl: route.upstreamUrl,
            enabled: route.enabled,
            priority: route.priority,
            authRequired: route.authRequired,
            rateLimitPolicyId: route.rateLimitPolicyId,
            circuitBreakerPolicyId: route.circuitBreakerPolicyId,
            timeoutMs: route.timeoutMs,
            pluginConfig: route.pluginConfig,
          });
          setPluginJson(JSON.stringify(route.pluginConfig, null, 2));
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        });
    }
  }, [editing, id]);

  const set = <K extends keyof RouteInput>(key: K, value: RouteInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toggleMethod = (m: HttpMethod) => {
    setForm((f) => ({
      ...f,
      methods: f.methods.includes(m) ? f.methods.filter((x) => x !== m) : [...f.methods, m],
    }));
  };

  const validate = (): string[] => {
    const errs: string[] = [];
    if (!form.name.trim()) errs.push('Name is required.');
    if (!form.pathPattern.trim()) errs.push('Path pattern is required.');
    if (form.methods.length === 0) errs.push('Select at least one method.');
    if (!/^https?:\/\/.+/.test(form.upstreamUrl))
      errs.push('Upstream URL must start with http:// or https://.');
    if (!Number.isInteger(form.timeoutMs) || form.timeoutMs <= 0)
      errs.push('Timeout must be a positive number of ms.');
    try {
      const parsed = JSON.parse(pluginJson) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errs.push('Plugin config must be a JSON object.');
      }
    } catch {
      errs.push('Plugin config is not valid JSON.');
    }
    return errs;
  };

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    void doSubmit();
  };

  const doSubmit = async (): Promise<void> => {
    const errs = validate();
    setErrors(errs);
    if (errs.length > 0) return;
    setSaving(true);
    setNotice(null);
    const payload: RouteInput = {
      ...form,
      pluginConfig: JSON.parse(pluginJson) as Record<string, unknown>,
    };
    try {
      if (editing && id) {
        const res = await api.updateRoute(id, payload);
        setNotice(
          `Configuration updated — now at config version ${res.version}. No restart needed.`,
        );
      } else {
        const res = await api.createRoute(payload);
        setNotice(`Route created — now at config version ${res.version}.`);
        setTimeout(() => {
          void navigate(`/routes/${res.route.id}`);
        }, 1200);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.code === 'VALIDATION_ERROR' ? ` (${err.message})` : '';
        setErrors([`${err.message}${details}`]);
      } else {
        setErrors(['Save failed.']);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div>
      <h1 className="page-title">{editing ? 'Edit route' : 'New route'}</h1>
      <p className="page-sub">
        <Link to="/routes">← Back to routes</Link>
      </p>

      {notice && <div className="alert success">{notice}</div>}
      {errors.length > 0 && (
        <div className="alert error">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={submit}>
        <div className="card">
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                value={form.name}
                onChange={(e) => {
                  set('name', e.target.value);
                }}
                placeholder="users-api"
              />
            </div>
            <div className="form-field">
              <label htmlFor="pattern">Path pattern</label>
              <input
                id="pattern"
                value={form.pathPattern}
                onChange={(e) => {
                  set('pathPattern', e.target.value);
                }}
                placeholder="/api/users/*"
              />
              <span className="help">Supports :params and trailing /* wildcards.</span>
            </div>
            <div className="form-field full">
              <label>Methods</label>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                {METHODS.map((m) => (
                  <label key={m} className="checkbox-row mono">
                    <input
                      type="checkbox"
                      checked={form.methods.includes(m)}
                      onChange={() => {
                        toggleMethod(m);
                      }}
                    />
                    {m}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-field full">
              <label htmlFor="upstream">Upstream URL</label>
              <input
                id="upstream"
                value={form.upstreamUrl}
                onChange={(e) => {
                  set('upstreamUrl', e.target.value);
                }}
                placeholder="http://users-service:3001"
              />
              <span className="help">The matched path suffix is appended to this base URL.</span>
            </div>
            <div className="form-field">
              <label htmlFor="priority">Priority</label>
              <input
                id="priority"
                type="number"
                value={form.priority}
                onChange={(e) => {
                  set('priority', Number(e.target.value));
                }}
              />
              <span className="help">Higher wins when patterns overlap.</span>
            </div>
            <div className="form-field">
              <label htmlFor="timeout">Upstream timeout (ms)</label>
              <input
                id="timeout"
                type="number"
                value={form.timeoutMs}
                onChange={(e) => {
                  set('timeoutMs', Number(e.target.value));
                }}
              />
            </div>
            <div className="form-field">
              <label htmlFor="rl">Rate limit policy</label>
              <select
                id="rl"
                value={form.rateLimitPolicyId ?? ''}
                onChange={(e) => {
                  set('rateLimitPolicyId', e.target.value || null);
                }}
              >
                <option value="">None</option>
                {rlPolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.capacity}/{p.refillRatePerSec}/s)
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="cb">Circuit breaker policy</label>
              <select
                id="cb"
                value={form.circuitBreakerPolicyId ?? ''}
                onChange={(e) => {
                  set('circuitBreakerPolicyId', e.target.value || null);
                }}
              >
                <option value="">None</option>
                {cbPolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => {
                    set('enabled', e.target.checked);
                  }}
                />
                Enabled
              </label>
            </div>
            <div className="form-field">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={form.authRequired}
                  onChange={(e) => {
                    set('authRequired', e.target.checked);
                  }}
                />
                Require JWT authentication
              </label>
            </div>
            <div className="form-field full">
              <label htmlFor="plugins">Plugin config (JSON)</label>
              <textarea
                id="plugins"
                rows={4}
                className="mono"
                value={pluginJson}
                onChange={(e) => {
                  setPluginJson(e.target.value);
                }}
              />
              <span className="help">
                Per-plugin options keyed by plugin name, e.g. {'{'}"request-id": {'{'} ... {'}'}
                {'}'}.
              </span>
            </div>
          </div>
          <div className="form-actions">
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create route'}
            </button>
            <Link className="btn secondary" to="/routes">
              Cancel
            </Link>
          </div>
        </div>
      </form>
    </div>
  );
}
