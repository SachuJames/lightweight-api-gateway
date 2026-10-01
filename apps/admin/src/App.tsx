import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Routes as RoutesPage } from './pages/Routes';
import { RouteDetail } from './pages/RouteDetail';
import { RouteForm } from './pages/RouteForm';
import { Policies } from './pages/Policies';
import { CircuitBreakers } from './pages/CircuitBreakers';
import { AuditLog } from './pages/AuditLog';
import { SystemStatus } from './pages/SystemStatus';
import { Settings } from './pages/Settings';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="routes" element={<RoutesPage />} />
          <Route path="routes/new" element={<RouteForm />} />
          <Route path="routes/:id" element={<RouteDetail />} />
          <Route path="routes/:id/edit" element={<RouteForm />} />
          <Route path="policies" element={<Policies />} />
          <Route path="circuits" element={<CircuitBreakers />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="status" element={<SystemStatus />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
