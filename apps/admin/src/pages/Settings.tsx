import { useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type { AdminUser } from '@gateway/shared-types';
import { api, ApiError } from '../api/client';
import { can, useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';
import { Badge, Empty, ErrorBox, Spinner, timeAgo } from '../components/ui';

export function Settings() {
  const { user } = useAuth();
  const isAdmin = can(user, 'manage');
  const [users, setUsers] = useState<AdminUser[] | null>(isAdmin ? null : []);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');

  const loadUsers = async () => {
    if (!isAdmin) return;
    try {
      const res = await api.listUsers();
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  const create = (e: SyntheticEvent) => {
    e.preventDefault();
    void doCreate();
  };

  const doCreate = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await api.createUser(email.trim(), password, role);
      setEmail('');
      setPassword('');
      setRole('viewer');
      setNotice('User created.');
      await loadUsers();
    } catch (err) {
      setError(
        err instanceof ApiError ? new Error(err.message) : new Error('Could not create user.'),
      );
    }
  };

  const remove = async (u: AdminUser) => {
    if (u.id === user?.id) {
      setError(new Error('You cannot delete your own account.'));
      return;
    }
    if (!window.confirm(`Delete user ${u.email}?`)) return;
    try {
      await api.deleteUser(u.id);
      setNotice('User deleted.');
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Session, API connection, and user management.</p>

      {notice && <div className="alert success">{notice}</div>}
      {error && <ErrorBox error={error} />}

      <div className="card">
        <h2>Session</h2>
        <table className="tbl">
          <tbody>
            <tr>
              <th style={{ width: 220 }}>Signed in as</th>
              <td>{user?.email}</td>
            </tr>
            <tr>
              <th>Role</th>
              <td>
                <Badge color="blue">{user?.role}</Badge>
              </td>
            </tr>
            <tr>
              <th>Token storage</th>
              <td className="dim">sessionStorage (this tab only; cleared when the tab closes)</td>
            </tr>
            <tr>
              <th>API base URL</th>
              <td className="mono dim">
                {API_BASE === '' ? `${window.location.origin} (same origin)` : API_BASE}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="card">
          <h2>Users</h2>
          {users === null ? (
            <Spinner />
          ) : users.length === 0 ? (
            <Empty text="No users." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>
                      <Badge color="blue">{u.role}</Badge>
                    </td>
                    <td className="dim">{timeAgo(u.createdAt)}</td>
                    <td>
                      <button className="btn-link danger" onClick={() => void remove(u)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Add user</h3>
          <form onSubmit={create}>
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="uemail">Email</label>
                <input
                  id="uemail"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="upass">Password</label>
                <input
                  id="upass"
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                  required
                  minLength={8}
                />
              </div>
              <div className="form-field">
                <label htmlFor="urole">Role</label>
                <select
                  id="urole"
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                  }}
                >
                  <option value="viewer">viewer — read-only</option>
                  <option value="operator">operator — read + reload</option>
                  <option value="admin">admin — full access</option>
                </select>
              </div>
            </div>
            <div className="form-actions">
              <button className="btn primary" type="submit">
                Create user
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Roles</h2>
        <table className="tbl">
          <thead>
            <tr>
              <th>Role</th>
              <th>Can do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <Badge color="blue">viewer</Badge>
              </td>
              <td className="dim">View routes, policies, audit log, metrics, status.</td>
            </tr>
            <tr>
              <td>
                <Badge color="blue">operator</Badge>
              </td>
              <td className="dim">Everything a viewer can, plus trigger config reloads.</td>
            </tr>
            <tr>
              <td>
                <Badge color="blue">admin</Badge>
              </td>
              <td className="dim">
                Full access: create/update/delete routes, policies, and users.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
