import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { can, useAuth } from '../auth/AuthContext';

const links: { to: string; label: string; min: 'read' | 'reload' | 'manage' }[] = [
  { to: '/', label: 'Dashboard', min: 'read' },
  { to: '/routes', label: 'Routes', min: 'read' },
  { to: '/policies', label: 'Policies', min: 'read' },
  { to: '/circuits', label: 'Circuit breakers', min: 'read' },
  { to: '/audit', label: 'Audit log', min: 'read' },
  { to: '/status', label: 'System status', min: 'read' },
  { to: '/settings', label: 'Settings', min: 'read' },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = () => {
    logout();
    void navigate('/login');
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span>◆</span> Gateway Admin
        </div>
        <nav>
          <div className="nav-section">Operate</div>
          {links
            .filter((l) => can(user, l.min))
            .map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                {l.label}
              </NavLink>
            ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="dim">Lightweight API Gateway</div>
          <div>
            <span className="user">
              {user?.email} · {user?.role}
            </span>
            <button className="btn secondary small" onClick={onLogout}>
              Log out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
