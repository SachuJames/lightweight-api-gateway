import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../api/client';

const TOKEN_KEY = 'gateway.admin.token';
const USER_KEY = 'gateway.admin.user';

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}

interface AuthState {
  user: SessionUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function loadSession(): SessionUser | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!raw || !token) return null;
    api.setToken(token);
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(loadSession());
    setReady(true);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    const sessionUser: SessionUser = {
      id: res.user.id,
      email: res.user.email,
      role: res.user.role,
    };
    sessionStorage.setItem(TOKEN_KEY, res.token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(sessionUser));
    api.setToken(res.token);
    setUser(sessionUser);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    api.setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, ready, login, logout }), [user, ready, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** True when the current user may perform the given action. Mirrors server RBAC. */
export function can(user: SessionUser | null, action: 'manage' | 'reload' | 'read'): boolean {
  if (!user) return false;
  if (action === 'read') return true;
  if (action === 'reload') return user.role === 'admin' || user.role === 'operator';
  return user.role === 'admin';
}

export { ApiError };
