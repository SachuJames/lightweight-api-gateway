import { useCallback, useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type { CircuitBreakerPolicy, RateLimitPolicy } from '@gateway/shared-types';
import { api, ApiError } from '../api/client';
import type { CircuitBreakerPolicyInput, RateLimitPolicyInput } from '../api/client';
import { can, useAuth } from '../auth/AuthContext';
import { ConfirmDialog, Empty, ErrorBox, Spinner } from '../components/ui';

const RL_EMPTY: RateLimitPolicyInput = {
  name: '',
  capacity: 100,
  refillRatePerSec: 10,
  keyStrategy: 'ip',
  failOpen: true,
};

const CB_EMPTY: CircuitBreakerPolicyInput = {
  name: '',
  failureThreshold: 5,
  rollingWindowMs: 60000,
  openDurationMs: 30000,
  halfOpenMaxProbes: 1,
  failureStatuses: [500, 502, 503, 504],
  countTimeouts: true,
};

export function Policies() {
  const { user } = useAuth();
  const manageable = can(user, 'manage');
  const [rl, setRl] = useState<RateLimitPolicy[] | null>(null);
  const [cb, setCb] = useState<CircuitBreakerPolicy[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingRl, setEditingRl] = useState<RateLimitPolicy | null>(null);
  const [editingCb, setEditingCb] = useState<CircuitBreakerPolicy | null>(null);
  const [creating, setCreating] = useState<'rl' | 'cb' | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'rl' | 'cb'; id: string; name: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api.listRateLimitPolicies(),
        api.listCircuitBreakerPolicies(),
      ]);
      setRl(a.policies);
      setCb(b.policies);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRl = async (input: RateLimitPolicyInput) => {
    try {
      if (editingRl) await api.updateRateLimitPolicy(editingRl.id, input);
      else await api.createRateLimitPolicy(input);
      setEditingRl(null);
      setCreating(null);
      setNotice('Rate limit policy saved.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const saveCb = async (input: CircuitBreakerPolicyInput) => {
    try {
      if (editingCb) await api.updateCircuitBreakerPolicy(editingCb.id, input);
      else await api.createCircuitBreakerPolicy(input);
      setEditingCb(null);
      setCreating(null);
      setNotice('Circuit breaker policy saved.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      if (deleting.kind === 'rl') await api.deleteRateLimitPolicy(deleting.id);
      else await api.deleteCircuitBreakerPolicy(deleting.id);
      setDeleting(null);
      setNotice('Policy deleted.');
      await load();
    } catch (err) {
      setDeleting(null);
      setError(
        err instanceof ApiError && err.status === 409
          ? new Error('That policy is still referenced by a route. Detach it first.')
          : err instanceof Error
            ? err
            : new Error(String(err)),
      );
    }
  };

  return (
    <div>
      <h1 className="page-title">Policies</h1>
      <p className="page-sub">Rate limiting and circuit breaking attach to routes by reference.</p>
      {notice && <div className="alert success">{notice}</div>}
      {error && <ErrorBox error={error} onRetry={() => void load()} />}

      <div className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>Rate limit policies</h2>
          <span className="spacer" />
          {manageable && (
            <button
              className="btn primary small"
              onClick={() => {
                setCreating('rl');
                setEditingRl(null);
              }}
            >
              New policy
            </button>
          )}
        </div>
        {rl === null ? (
          <Spinner />
        ) : rl.length === 0 ? (
          <Empty text="No rate limit policies yet." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Capacity</th>
                <th>Refill/s</th>
                <th>Key</th>
                <th>On Redis failure</th>
                {manageable && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rl.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.capacity}</td>
                  <td>{p.refillRatePerSec}</td>
                  <td className="mono">{p.keyStrategy}</td>
                  <td>{p.failOpen ? 'fail open' : 'fail closed'}</td>
                  {manageable && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="btn-link"
                        onClick={() => {
                          setEditingRl(p);
                          setCreating(null);
                        }}
                      >
                        Edit
                      </button>{' '}
                      <button
                        className="btn-link danger"
                        onClick={() => {
                          setDeleting({ kind: 'rl', id: p.id, name: p.name });
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>Circuit breaker policies</h2>
          <span className="spacer" />
          {manageable && (
            <button
              className="btn primary small"
              onClick={() => {
                setCreating('cb');
                setEditingCb(null);
              }}
            >
              New policy
            </button>
          )}
        </div>
        {cb === null ? (
          <Spinner />
        ) : cb.length === 0 ? (
          <Empty text="No circuit breaker policies yet." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Threshold</th>
                <th>Window</th>
                <th>Open for</th>
                <th>Probes</th>
                <th>Failure statuses</th>
                {manageable && <th></th>}
              </tr>
            </thead>
            <tbody>
              {cb.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.failureThreshold}</td>
                  <td>{p.rollingWindowMs} ms</td>
                  <td>{p.openDurationMs} ms</td>
                  <td>{p.halfOpenMaxProbes}</td>
                  <td className="mono dim">{p.failureStatuses.join(', ')}</td>
                  {manageable && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="btn-link"
                        onClick={() => {
                          setEditingCb(p);
                          setCreating(null);
                        }}
                      >
                        Edit
                      </button>{' '}
                      <button
                        className="btn-link danger"
                        onClick={() => {
                          setDeleting({ kind: 'cb', id: p.id, name: p.name });
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(creating === 'rl' || editingRl) && (
        <RateLimitForm
          initial={editingRl ?? RL_EMPTY}
          title={editingRl ? 'Edit rate limit policy' : 'New rate limit policy'}
          onSave={(i) => void saveRl(i)}
          onCancel={() => {
            setCreating(null);
            setEditingRl(null);
          }}
        />
      )}
      {(creating === 'cb' || editingCb) && (
        <CircuitForm
          initial={editingCb ?? CB_EMPTY}
          title={editingCb ? 'Edit circuit breaker policy' : 'New circuit breaker policy'}
          onSave={(i) => void saveCb(i)}
          onCancel={() => {
            setCreating(null);
            setEditingCb(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete policy"
          body={`Delete policy "${deleting.name}"?`}
          confirmLabel="Delete policy"
          onConfirm={() => void remove()}
          onCancel={() => {
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function RateLimitForm({
  initial,
  title,
  onSave,
  onCancel,
}: {
  initial: RateLimitPolicyInput;
  title: string;
  onSave: (i: RateLimitPolicyInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    onSave(form);
  };
  const set = <K extends keyof RateLimitPolicyInput>(k: K, v: RateLimitPolicyInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  };
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2>{title}</h2>
        <form onSubmit={submit}>
          <div className="form-field">
            <label>Name</label>
            <input
              value={form.name}
              onChange={(e) => {
                set('name', e.target.value);
              }}
              required
            />
          </div>
          <div className="form-field">
            <label>Capacity (burst)</label>
            <input
              type="number"
              min={1}
              value={form.capacity}
              onChange={(e) => {
                set('capacity', Number(e.target.value));
              }}
              required
            />
          </div>
          <div className="form-field">
            <label>Refill rate (tokens/sec)</label>
            <input
              type="number"
              min={1}
              value={form.refillRatePerSec}
              onChange={(e) => {
                set('refillRatePerSec', Number(e.target.value));
              }}
              required
            />
          </div>
          <div className="form-field">
            <label>Key strategy</label>
            <select
              value={form.keyStrategy}
              onChange={(e) => {
                set('keyStrategy', e.target.value as RateLimitPolicyInput['keyStrategy']);
              }}
            >
              <option value="ip">ip — per client IP</option>
              <option value="user">user — per authenticated user</option>
              <option value="route_ip">route_ip — per route + IP</option>
              <option value="route_user">route_user — per route + user</option>
            </select>
          </div>
          <div className="form-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.failOpen}
                onChange={(e) => {
                  set('failOpen', e.target.checked);
                }}
              />
              Fail open when Redis is unavailable
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CircuitForm({
  initial,
  title,
  onSave,
  onCancel,
}: {
  initial: CircuitBreakerPolicyInput;
  title: string;
  onSave: (i: CircuitBreakerPolicyInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [statuses, setStatuses] = useState(initial.failureStatuses.join(', '));
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    onSave({
      ...form,
      failureStatuses: statuses
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n)),
    });
  };
  const set = <K extends keyof CircuitBreakerPolicyInput>(
    k: K,
    v: CircuitBreakerPolicyInput[K],
  ) => {
    setForm((f) => ({ ...f, [k]: v }));
  };
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2>{title}</h2>
        <form onSubmit={submit}>
          <div className="form-field">
            <label>Name</label>
            <input
              value={form.name}
              onChange={(e) => {
                set('name', e.target.value);
              }}
              required
            />
          </div>
          <div className="form-field">
            <label>Failure threshold</label>
            <input
              type="number"
              min={1}
              value={form.failureThreshold}
              onChange={(e) => {
                set('failureThreshold', Number(e.target.value));
              }}
              required
            />
            <span className="help">Failures inside the window that trip the circuit.</span>
          </div>
          <div className="form-field">
            <label>Rolling window (ms)</label>
            <input
              type="number"
              min={1000}
              value={form.rollingWindowMs}
              onChange={(e) => {
                set('rollingWindowMs', Number(e.target.value));
              }}
              required
            />
          </div>
          <div className="form-field">
            <label>Open duration (ms)</label>
            <input
              type="number"
              min={1000}
              value={form.openDurationMs}
              onChange={(e) => {
                set('openDurationMs', Number(e.target.value));
              }}
              required
            />
          </div>
          <div className="form-field">
            <label>Half-open max probes</label>
            <input
              type="number"
              min={1}
              value={form.halfOpenMaxProbes}
              onChange={(e) => {
                set('halfOpenMaxProbes', Number(e.target.value));
              }}
              required
            />
          </div>
          <div className="form-field">
            <label>Failure statuses (comma-separated)</label>
            <input
              value={statuses}
              onChange={(e) => {
                setStatuses(e.target.value);
              }}
            />
          </div>
          <div className="form-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.countTimeouts}
                onChange={(e) => {
                  set('countTimeouts', e.target.checked);
                }}
              />
              Count upstream timeouts as failures
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
