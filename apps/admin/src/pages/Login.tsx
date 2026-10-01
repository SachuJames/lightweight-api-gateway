import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError, useAuth } from '../auth/AuthContext';

export function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    return <Navigate to="/" replace />;
  }

  const doLogin = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      void navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        setError(`Cannot reach the gateway API: ${err.message}`);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Login failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Gateway Admin</h1>
        <p className="sub">Sign in to manage routes, policies, and traffic.</p>
        {error && <div className="alert error">{error}</div>}
        <form
          onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            void doLogin();
          }}
        >
          <div className="form-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              required
            />
          </div>
          <div className="form-field" style={{ marginTop: 12 }}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              required
            />
          </div>
          <div className="form-actions">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
        <p className="sub" style={{ marginTop: 16 }}>
          Development login: admin@example.local (see .env.example).
        </p>
      </div>
    </div>
  );
}
